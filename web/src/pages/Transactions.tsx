import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs, type Account, type Transaction, type TransactionList } from '../api';
import { Card, CategorySelect, Empty, ErrorNote, Field, fmtDay, fmtMonth, Modal, Money, money, monthEnd, PageHeader, Pill, todayIso, useCategories } from '../ui';

const PAGE = 100;

export function Transactions() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const categories = useCategories();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') }).data ?? [];
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ tx: Transaction; categoryId: number; name: string } | null>(null);

  const month = params.get('month') ?? '';
  const filters = {
    from: month ? `${month}-01` : undefined,
    to: month ? monthEnd(month) : undefined,
    account_id: params.get('account_id') ?? undefined,
    category_id: params.get('category_id') ?? undefined,
    commitment_id: params.get('commitment_id') ?? undefined,
    uncategorized: params.get('uncategorized') ? true : undefined,
    q: params.get('q') ?? undefined,
  };
  const key = JSON.stringify(filters);
  useEffect(() => setPage(0), [key]);
  useEffect(() => {
    const t = setTimeout(() => set('q', search), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === 'category_id' && value) next.delete('uncategorized');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  };

  const list = useQuery({
    queryKey: ['transactions', key, page],
    queryFn: () => api<TransactionList>(`/transactions${qs({ ...filters, limit: PAGE, offset: page * PAGE })}`),
    placeholderData: (prev) => prev,
  });

  const recategorize = useMutation({
    mutationFn: (v: { tx: Transaction; categoryId: number | null }) => api(`/transactions/${v.tx.id}`, { method: 'PATCH', body: { category_id: v.categoryId } }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries();
      const name = categories.find((c) => c.id === v.categoryId)?.name;
      setToast(v.categoryId && name && v.tx.counterparty ? { tx: v.tx, categoryId: v.categoryId, name } : null);
    },
  });
  const makeRule = useMutation({
    mutationFn: (t: NonNullable<typeof toast>) => api<{ recategorized: number }>('/rules', { body: { pattern: t.tx.counterparty, category_id: t.categoryId, field: 'counterparty' } }),
    onSuccess: () => {
      setToast(null);
      void qc.invalidateQueries();
    },
  });

  const months: string[] = [];
  for (let i = 0, d = new Date(); i < 24; i++, d.setMonth(d.getMonth() - 1)) months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  const data = list.data;
  const filtered = Object.values(filters).some((v) => v !== undefined);

  return (
    <>
      <PageHeader title="Transactions">
        <button className="btn" onClick={() => setAdding(true)} disabled={accounts.length === 0}>Add transaction</button>
      </PageHeader>
      <Card>
        <div className="row" style={{ marginBottom: 14 }}>
          <input type="search" placeholder="Search merchant or description" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: '1 1 200px' }} />
          <select aria-label="Month" value={month} onChange={(e) => set('month', e.target.value)}>
            <option value="">All time</option>
            {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
          </select>
          <select aria-label="Account" value={params.get('account_id') ?? ''} onChange={(e) => set('account_id', e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select aria-label="Category" value={params.get('uncategorized') ? 'none' : (params.get('category_id') ?? '')}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.delete('category_id');
              next.delete('uncategorized');
              if (e.target.value === 'none') next.set('uncategorized', '1');
              else if (e.target.value) next.set('category_id', e.target.value);
              setParams(next, { replace: true });
            }}>
            <option value="">All categories</option>
            <option value="none">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {filtered && <button className="btn ghost" onClick={() => { setSearch(''); setParams({}, { replace: true }); }}>Clear</button>}
        </div>
        <ErrorNote error={list.error ?? recategorize.error} />
        {data && (
          <p className="muted" style={{ marginBottom: 6, fontSize: '0.87rem' }}>
            {data.total.toLocaleString()} transactions · net {money(data.sum_base, data.base_currency, { sign: true })}
            {params.get('commitment_id') && ' · payments of one commitment'}
          </p>
        )}
        {data && data.items.length === 0 ? <Empty>No transactions match.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Details</th><th className="hide-sm">Account</th><th>Category</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {data?.items.map((t) => (
                  <tr key={t.id} className={t.status === 'pending' ? 'pending' : ''}>
                    <td className="num">{fmtDay(t.booked_on, { day: 'numeric', month: 'short', year: '2-digit' })}</td>
                    <td>
                      <div className="clip" title={`${t.counterparty} ${t.description}`}>{t.counterparty || t.description || '—'}</div>
                      <span className="sub clip">{t.counterparty ? t.description : ''}{t.status === 'pending' ? ' · pending' : ''}{t.commitment_id ? ' · recurring' : ''}</span>
                    </td>
                    <td className="hide-sm muted">{t.account_name}</td>
                    <td>
                      <CategorySelect aria-label={`Category for ${t.counterparty || t.description}`} categories={categories} value={t.category_id}
                        onChange={(categoryId) => recategorize.mutate({ tx: t, categoryId })} />
                    </td>
                    <td className="r">
                      <Money value={t.amount} currency={t.currency} sign />
                      {t.flow === 'transfer' && <span className="sub">transfer</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > PAGE && (
          <div className="row between" style={{ marginTop: 14 }}>
            <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</button>
            <span className="muted">{page * PAGE + 1}–{Math.min((page + 1) * PAGE, data.total)} of {data.total.toLocaleString()}</span>
            <button className="btn" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Older</button>
          </div>
        )}
      </Card>
      {toast && (
        <div className="toast" role="status">
          <span>Always file “{toast.tx.counterparty}” under {toast.name}?</span>
          <button className="btn small" disabled={makeRule.isPending} onClick={() => makeRule.mutate(toast)}>Create rule</button>
          <button className="btn small ghost" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
      {adding && <AddTransaction accounts={accounts} onClose={() => setAdding(false)} />}
    </>
  );
}

function AddTransaction({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const qc = useQueryClient();
  const categories = useCategories();
  const manual = accounts.filter((a) => a.source === 'manual');
  const [f, setF] = useState({ account_id: (manual[0] ?? accounts[0])?.id ?? 0, booked_on: todayIso(), amount: '', direction: 'out', counterparty: '', description: '', category_id: null as number | null });
  const save = useMutation({
    mutationFn: () => api('/transactions', { body: { ...f, amount: (f.direction === 'out' ? -1 : 1) * Math.abs(Number(f.amount)), direction: undefined } }),
    onSuccess: () => { void qc.invalidateQueries(); onClose(); },
  });
  const account = accounts.find((a) => a.id === f.account_id);
  return (
    <Modal title="Add transaction" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form">
          <Field label="Account">
            <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: Number(e.target.value) })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" required value={f.booked_on} onChange={(e) => setF({ ...f, booked_on: e.target.value })} /></Field>
          <Field label="Type">
            <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="out">Money out</option><option value="in">Money in</option></select>
          </Field>
          <Field label={`Amount (${account?.currency ?? ''})`}><input type="number" required min="0.01" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Merchant / payee"><input value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} /></Field>
          <Field label="Category" hint="Leave empty to apply your rules">
            <CategorySelect categories={categories} value={f.category_id} onChange={(category_id) => setF({ ...f, category_id })} />
          </Field>
          <div className="full"><Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        </div>
        {account?.source === 'bank' && <p className="note" style={{ marginTop: 12 }}>This account is synced from the bank, so a manual entry may duplicate a transaction that arrives later.</p>}
        <ErrorNote error={save.error} />
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending}>Add</button></div>
      </form>
    </Modal>
  );
}
