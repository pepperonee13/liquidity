import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Account, type Connection, type Provider } from '../api';
import { Card, Empty, ErrorNote, Field, fmtDay, Modal, Money, money, PageHeader, Pill, useBaseCurrency } from '../ui';

const TYPES = ['checking', 'savings', 'credit', 'cash', 'investment', 'loan', 'other'];

export function Accounts() {
  const qc = useQueryClient();
  const base = useBaseCurrency();
  const [params, setParams] = useSearchParams();
  const [modal, setModal] = useState<null | 'connect' | 'manual' | { importFor: Account } | { edit: Account }>(null);
  const connections = useQuery({
    queryKey: ['connections'], queryFn: () => api<Connection[]>('/connections'),
    refetchInterval: (q) => (q.state.data?.some((c) => c.syncing) || params.get('connected') ? 2000 : false),
  });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
  const conns = connections.data ?? [];
  const anySyncing = conns.some((c) => c.syncing);

  // After returning from the bank: keep polling until the first sync has finished, then refresh everything.
  useEffect(() => {
    if (params.get('connected') && connections.data && !anySyncing) {
      const t = setTimeout(() => {
        void qc.invalidateQueries();
        setParams({}, { replace: true });
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [params, connections.data, anySyncing, qc, setParams]);

  const sync = useMutation({ mutationFn: (id: number) => api(`/connections/${id}/sync`, { method: 'POST' }), onSettled: () => qc.invalidateQueries() });
  const reconnect = useMutation({
    mutationFn: (id: number) => api<{ auth_url: string }>(`/connections/${id}/reconnect`, { method: 'POST' }),
    onSuccess: (r) => { window.location.href = r.auth_url; },
  });
  const disconnect = useMutation({
    mutationFn: (v: { id: number; purge: boolean }) => api(`/connections/${v.id}?purge=${v.purge}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const tone = (c: Connection) => (c.status === 'active' ? 'good' : c.status === 'expired' ? 'warn' : c.status === 'error' ? 'bad' : 'neutral');
  const expiresSoon = (c: Connection) => c.valid_until && Date.parse(c.valid_until) - Date.now() < 14 * 86400_000;

  return (
    <>
      <PageHeader title="Accounts">
        <button className="btn" onClick={() => setModal('manual')}>Add manual account</button>
        <button className="btn primary" onClick={() => setModal('connect')}>Connect a bank</button>
      </PageHeader>
      <div className="stack">
        {params.get('connect_error') && <p className="note error" role="alert">The bank connection failed: {params.get('connect_error')}</p>}
        {params.get('connected') && <p className="note ok" role="status">Bank connected. Fetching balances and transactions…</p>}
        <ErrorNote error={sync.error ?? reconnect.error ?? disconnect.error} />

        <Card title="Bank connections">
          {conns.length === 0 ? <Empty>No banks connected yet.</Empty> : (
            <div className="list">
              {conns.map((c) => (
                <div key={c.id}>
                  <div className="grow">
                    <div><strong>{c.institution_name}</strong> <Pill tone={tone(c)}>{c.syncing ? 'syncing…' : c.status}</Pill></div>
                    <small>
                      {c.accounts} account{c.accounts === 1 ? '' : 's'} · {c.last_synced_at ? `synced ${new Date(`${c.last_synced_at.replace(' ', 'T')}Z`).toLocaleString()}` : 'not synced yet'}
                      {c.valid_until && ` · consent until ${fmtDay(c.valid_until, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                    </small>
                    {c.last_error && <small style={{ display: 'block' }}>{c.last_error}</small>}
                  </div>
                  <div className="row">
                    {(c.status === 'expired' || expiresSoon(c)) && <button className="btn small primary" onClick={() => reconnect.mutate(c.id)}>Renew consent</button>}
                    <button className="btn small" disabled={c.syncing || sync.isPending || c.status === 'expired'} onClick={() => sync.mutate(c.id)}>Sync now</button>
                    <button className="btn small danger" onClick={() => {
                      if (!confirm(`Disconnect ${c.institution_name}?`)) return;
                      disconnect.mutate({ id: c.id, purge: confirm('Also delete its accounts and transactions from Liquidity?\n\nOK = delete the data, Cancel = keep it as manual accounts.') });
                    }}>Disconnect</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="All accounts">
          {!accounts.data?.length ? <Empty>No accounts yet.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th className="hide-sm">Type</th><th className="hide-sm">Transactions</th><th className="r">Balance</th><th /></tr></thead>
                <tbody>
                  {accounts.data.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/transactions?account_id=${a.id}`}>{a.name}</Link> {a.archived && <Pill>archived</Pill>} {!a.include_in_net_worth && <Pill>not in net worth</Pill>}
                        <span className="sub">{[a.institution, a.iban, a.source === 'manual' ? 'manual' : null].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="hide-sm">{a.type}</td>
                      <td className="hide-sm num">{a.transactions.toLocaleString()}{a.last_transaction_on && <span className="sub">latest {fmtDay(a.last_transaction_on)}</span>}</td>
                      <td className="r"><Money value={a.balance} currency={a.currency} />{a.currency !== base && <span className="sub">≈ {money(a.balance_base, base)}</span>}</td>
                      <td className="r">
                        <span className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn small" onClick={() => setModal({ importFor: a })}>Import CSV</button>
                          <button className="btn small" onClick={() => setModal({ edit: a })}>Edit</button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {modal === 'connect' && <ConnectBank onClose={() => setModal(null)} />}
      {modal === 'manual' && <AccountForm onClose={() => setModal(null)} base={base} />}
      {modal && typeof modal === 'object' && 'edit' in modal && <AccountForm account={modal.edit} onClose={() => setModal(null)} base={base} />}
      {modal && typeof modal === 'object' && 'importFor' in modal && <ImportCsv account={modal.importFor} onClose={() => setModal(null)} />}
    </>
  );
}

function ConnectBank({ onClose }: { onClose: () => void }) {
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/providers') }).data ?? [];
  const [providerId, setProviderId] = useState<string | null>(null);
  const [country, setCountry] = useState('HU');
  const [search, setSearch] = useState('');
  const provider = providers.find((p) => p.id === providerId) ?? providers.find((p) => p.configured && p.id !== 'demo') ?? providers.find((p) => p.configured);
  const banks = useQuery({
    queryKey: ['institutions', provider?.id, country],
    queryFn: () => api<{ name: string; country: string; logo?: string }[]>(`/providers/${provider!.id}/institutions?country=${country}`),
    enabled: Boolean(provider?.configured) && country.length === 2,
  });
  const start = useMutation({
    mutationFn: (name: string) => api<{ auth_url: string }>('/connections', { body: { provider: provider!.id, institution_name: name, country } }),
    onSuccess: (r) => { window.location.href = r.auth_url; },
  });
  const shown = (banks.data ?? []).filter((b) => b.name.toLowerCase().includes(search.toLowerCase()));
  const unconfigured = providers.filter((p) => !p.configured);

  return (
    <Modal title="Connect a bank" onClose={onClose}>
      <div className="stack">
        <div className="form">
          <Field label="Data provider">
            <select value={provider?.id ?? ''} onChange={(e) => setProviderId(e.target.value)}>
              {providers.map((p) => <option key={p.id} value={p.id} disabled={!p.configured}>{p.label}{p.configured ? '' : ' – not set up'}</option>)}
            </select>
          </Field>
          <Field label="Country code" hint="Revolut is listed under your account's country"><input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} /></Field>
        </div>
        {unconfigured.map((p) => (
          <p key={p.id} className="note">
            <strong>{p.label}</strong> is not set up yet. {p.setup_hint} Register this redirect URL with the provider: <code>{p.redirect_url}</code>
          </p>
        ))}
        {provider?.configured && (
          <>
            <input type="search" placeholder="Search banks" aria-label="Search banks" value={search} onChange={(e) => setSearch(e.target.value)} />
            <ErrorNote error={banks.error ?? start.error} />
            <div className="pick-list">
              {shown.map((b) => (
                <button key={b.name} disabled={start.isPending} onClick={() => start.mutate(b.name)}>
                  {b.logo ? <img src={b.logo} alt="" /> : null}{b.name}
                </button>
              ))}
              {banks.isLoading && <Empty>Loading banks…</Empty>}
              {banks.data && shown.length === 0 && <Empty>No bank matches. If yours is missing, add a manual account and import CSV statements.</Empty>}
            </div>
            <p className="muted" style={{ fontSize: '0.85rem' }}>You will be sent to your bank to approve read-only access. Liquidity never sees your bank password and cannot move money.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function AccountForm({ account, onClose, base }: { account?: Account; onClose: () => void; base: string }) {
  const qc = useQueryClient();
  const synced = account?.source === 'bank';
  const [f, setF] = useState({
    name: account?.name ?? '', institution: account?.institution ?? '', currency: account?.currency ?? base, type: account?.type ?? 'checking',
    balance: String(account?.balance ?? 0), include_in_net_worth: account?.include_in_net_worth ?? true, archived: account?.archived ?? false,
  });
  const done = () => { void qc.invalidateQueries(); onClose(); };
  const save = useMutation({
    mutationFn: () => api(account ? `/accounts/${account.id}` : '/accounts', {
      method: account ? 'PATCH' : 'POST',
      body: { ...f, currency: account ? undefined : f.currency.toUpperCase(), balance: synced ? undefined : Number(f.balance) },
    }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api(`/accounts/${account!.id}`, { method: 'DELETE' }), onSuccess: done });
  return (
    <Modal title={account ? 'Edit account' : 'Add manual account'} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form">
          <Field label="Name"><input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Cash, Állampapír, Car loan" /></Field>
          <Field label="Institution"><input value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></Field>
          <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Currency"><input required minLength={3} maxLength={3} disabled={Boolean(account)} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></Field>
          <Field label="Balance" hint={synced ? 'Updated from the bank' : 'Use a negative number for debts'}>
            <input type="number" step="any" disabled={synced} value={f.balance} onChange={(e) => setF({ ...f, balance: e.target.value })} />
          </Field>
          <div className="stack" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <label className="row"><input type="checkbox" checked={f.include_in_net_worth} onChange={(e) => setF({ ...f, include_in_net_worth: e.target.checked })} /> Count in net worth</label>
            {account && <label className="row"><input type="checkbox" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Archived</label>}
          </div>
        </div>
        <ErrorNote error={save.error ?? remove.error} />
        <div className="form-actions">
          {account && <button type="button" className="btn danger" style={{ marginRight: 'auto' }}
            onClick={() => confirm(`Delete ${account.name} and its ${account.transactions} transactions? This cannot be undone.`) && remove.mutate()}>Delete</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.isPending}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

interface ImportResult {
  headers: string[]; mapping: Record<string, string>; parsed: number; inserted: number; updated: number;
  skipped: { line: number; reason: string }[];
  preview: { booked_on: string; amount: number; currency: string; counterparty: string; description: string }[];
}
const MAP_FIELDS: [string, string][] = [
  ['date', 'Date'], ['amount', 'Amount (signed)'], ['debit', 'Money out'], ['credit', 'Money in'], ['currency', 'Currency'],
  ['counterparty', 'Merchant / partner'], ['description', 'Description'], ['id', 'Transaction ID'], ['status', 'Status'], ['balance', 'Balance'], ['fee', 'Fee'],
];

/** Hungarian bank exports are often Windows-1250; fall back to it when the file is not valid UTF-8. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1250').decode(buf);
  }
}

function ImportCsv({ account, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: (v: { csv: string; mapping: Record<string, string>; dry: boolean }) =>
      api<ImportResult>(`/accounts/${account.id}/import-csv`, { body: { csv: v.csv, mapping: v.mapping, dry_run: v.dry } }),
    onSuccess: (r, v) => {
      if (v.dry) { setPreview(r); setMapping(r.mapping); } else { setDone(r); void qc.invalidateQueries(); }
    },
  });
  const pick = async (file?: File) => {
    if (!file) return;
    const text = await readText(file);
    setCsv(text);
    setDone(null);
    run.mutate({ csv: text, mapping: {}, dry: true });
  };
  const remap = (field: string, header: string) => {
    const next = { ...mapping, [field]: header };
    setMapping(next);
    run.mutate({ csv, mapping: next, dry: true });
  };
  return (
    <Modal title={`Import CSV into ${account.name}`} onClose={onClose} wide>
      <div className="stack">
        <p className="muted">Export a statement as CSV from your bank and choose it here. English and Hungarian column names are recognised; importing overlapping periods does not create duplicates.</p>
        <input type="file" accept=".csv,.txt,text/csv" aria-label="CSV file" onChange={(e) => void pick(e.target.files?.[0])} />
        <ErrorNote error={run.error} />
        {done ? (
          <p className="note ok" role="status">Imported {done.inserted} new transactions{done.parsed - done.inserted > 0 ? `, ${done.parsed - done.inserted} were already there` : ''}{done.skipped.length ? `, ${done.skipped.length} rows skipped` : ''}.</p>
        ) : preview && (
          <>
            <div className="form" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {MAP_FIELDS.map(([field, label]) => (
                <Field key={field} label={label}>
                  <select value={mapping[field] ?? ''} onChange={(e) => remap(field, e.target.value)}>
                    <option value="">–</option>
                    {preview.headers.map((h) => <option key={h}>{h}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            {preview.parsed === 0 ? <p className="note error">No rows could be read. Choose at least the date column and an amount column above.</p> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Date</th><th>Merchant</th><th>Description</th><th className="r">Amount</th></tr></thead>
                  <tbody>
                    {preview.preview.map((p, i) => (
                      <tr key={i}><td className="num">{p.booked_on}</td><td><div className="clip">{p.counterparty}</div></td><td><div className="clip">{p.description}</div></td><td className="r"><Money value={p.amount} currency={p.currency} sign /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <small>{preview.parsed} rows ready{preview.skipped.length ? ` · ${preview.skipped.length} skipped (first: line ${preview.skipped[0].line}, ${preview.skipped[0].reason})` : ''}</small>
          </>
        )}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
          {!done && <button className="btn primary" disabled={!preview || preview.parsed === 0 || run.isPending} onClick={() => run.mutate({ csv, mapping, dry: false })}>Import {preview?.parsed ?? ''} rows</button>}
        </div>
      </div>
    </Modal>
  );
}
