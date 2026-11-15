import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Candidate, type Commitment, type CommitmentList } from '../api';
import { Card, CategorySelect, Empty, ErrorNote, Field, fmtDay, Modal, money, PageHeader, Pill, useBaseCurrency, useCategories } from '../ui';

const KINDS = ['subscription', 'insurance', 'utility', 'loan', 'rent', 'membership', 'tax', 'other'] as const;
const KIND_LABEL: Record<string, string> = {
  subscription: 'Subscriptions', insurance: 'Insurance', utility: 'Utilities', loan: 'Loans', rent: 'Rent & housing',
  membership: 'Memberships', tax: 'Taxes', other: 'Other',
};
const CADENCES = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly'];
const PER: Record<string, string> = { weekly: 'week', monthly: 'month', quarterly: 'quarter', semiannual: 'half-year', yearly: 'year' };

type Draft = {
  id?: number; kind: string; name: string; provider: string; amount: string; currency: string; cadence: string; next_due_on: string;
  end_on: string; cancel_notice_days: string; policy_number: string; category_id: number | null; match_pattern: string; status: string; url: string; notes: string;
};

const blank = (currency: string): Draft => ({
  kind: 'subscription', name: '', provider: '', amount: '', currency, cadence: 'monthly', next_due_on: '', end_on: '', cancel_notice_days: '',
  policy_number: '', category_id: null, match_pattern: '', status: 'active', url: '', notes: '',
});

export function Recurring() {
  const base = useBaseCurrency();
  const [draft, setDraft] = useState<Draft | null>(null);
  const { data } = useQuery({ queryKey: ['commitments'], queryFn: () => api<CommitmentList>('/commitments') });
  const detected = useQuery({ queryKey: ['recurring'], queryFn: () => api<{ candidates: Candidate[] }>('/insights/recurring') }).data?.candidates ?? [];
  const list = data?.commitments ?? [];
  const cur = data?.base_currency ?? base;

  const edit = (c: Commitment) => setDraft({
    id: c.id, kind: c.kind, name: c.name, provider: c.provider, amount: String(c.amount), currency: c.currency, cadence: c.cadence,
    next_due_on: c.next_due_on ?? '', end_on: c.end_on ?? '', cancel_notice_days: c.cancel_notice_days?.toString() ?? '', policy_number: c.policy_number ?? '',
    category_id: c.category_id, match_pattern: c.match_pattern ?? '', status: c.status, url: c.url ?? '', notes: c.notes ?? '',
  });
  const track = (c: Candidate) => setDraft({
    ...blank(c.currency), kind: KINDS.includes(c.suggested_kind as never) ? c.suggested_kind : 'other', name: c.name, provider: c.name,
    amount: String(c.amount), cadence: c.cadence, next_due_on: c.next_expected_on, category_id: c.category_id, match_pattern: c.suggested_match_pattern,
  });

  return (
    <>
      <PageHeader title="Recurring">
        <button className="btn primary" onClick={() => setDraft(blank(base))}>Add commitment</button>
      </PageHeader>
      <div className="stack">
        <div className="grid cols-3">
          <Card className="stat"><div className="label">Per month</div><div className="value">{money(data?.monthly_total_base ?? 0, cur)}</div><div className="delta">active commitments</div></Card>
          <Card className="stat"><div className="label">Per year</div><div className="value">{money(data?.yearly_total_base ?? 0, cur)}</div><div className="delta">{list.filter((c) => c.status === 'active').length} tracked</div></Card>
          <Card className="stat"><div className="label">Not tracked yet</div><div className="value">{detected.length}</div><div className="delta">recurring payments detected</div></Card>
        </div>

        {list.length === 0 && <Card><Empty>Nothing tracked yet. Add your subscriptions, insurance policies, loans and bills here, or pick them from the detected payments below.</Empty></Card>}
        {KINDS.filter((k) => list.some((c) => c.kind === k)).map((kind) => {
          const items = list.filter((c) => c.kind === kind);
          return (
            <Card key={kind} title={KIND_LABEL[kind]} action={<span className="muted num">{money(items.filter((c) => c.status === 'active').reduce((s, c) => s + c.monthly_cost_base, 0), cur)} / month</span>}>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th className="r">Cost</th><th className="r hide-sm">Per year</th><th>Next due</th><th className="hide-sm">Contract</th><th /></tr></thead>
                  <tbody>
                    {items.map((c) => (
                      <tr key={c.id}>
                        <td>
                          {c.name} {c.status !== 'active' && <Pill>{c.status}</Pill>}
                          <span className="sub">{[c.provider !== c.name && c.provider, c.policy_number && `No. ${c.policy_number}`, c.payments ? `${c.payments} payments` : 'no payments linked'].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className="r num">{money(c.amount, c.currency)}<span className="sub">per {PER[c.cadence]}</span></td>
                        <td className="r num hide-sm">{money(c.yearly_cost_base, cur)}</td>
                        <td>
                          {fmtDay(c.next_due_on)}
                          {c.days_until_due !== null && c.status === 'active' && <span className="sub">{c.days_until_due < 0 ? `${-c.days_until_due} days overdue` : c.days_until_due === 0 ? 'today' : `in ${c.days_until_due} days`}</span>}
                        </td>
                        <td className="hide-sm">
                          {c.end_on ? <>until {fmtDay(c.end_on, { day: 'numeric', month: 'short', year: 'numeric' })}</> : <span className="muted">–</span>}
                          {c.cancel_by && <span className="sub">cancel by {fmtDay(c.cancel_by, { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                        </td>
                        <td className="r">
                          <span className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            {c.payments > 0 && <Link className="btn small ghost hide-sm" to={`/transactions?commitment_id=${c.id}`}>Payments</Link>}
                            <button className="btn small" onClick={() => edit(c)}>Edit</button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })}

        <Card title="Detected in your transactions">
          {detected.length === 0 ? <Empty>No untracked recurring payments found.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Payee</th><th className="r">Typical</th><th className="r hide-sm">Per year</th><th className="hide-sm">Last paid</th><th /></tr></thead>
                <tbody>
                  {detected.map((c) => (
                    <tr key={c.key}>
                      <td>
                        {c.name}
                        <span className="sub">{c.cadence} · {c.occurrences} payments{c.category_name ? ` · ${c.category_name}` : ''}{c.amount_type === 'variable' ? ' · amount varies' : ''}</span>
                      </td>
                      <td className="r num">
                        {money(c.amount, c.currency)}
                        {c.amount_type === 'fixed' && c.price_change >= 1.05 && <span className="sub">▲ {Math.round((c.price_change - 1) * 100)}% since first seen</span>}
                      </td>
                      <td className="r num hide-sm">{money(c.yearly_cost_base, cur)}</td>
                      <td className="hide-sm">{fmtDay(c.last_on)}</td>
                      <td className="r"><button className="btn small" onClick={() => track(c)}>Track</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {draft && <CommitmentForm draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}

function CommitmentForm({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const qc = useQueryClient();
  const categories = useCategories();
  const [f, setF] = useState(draft);
  const up = (patch: Partial<Draft>) => setF({ ...f, ...patch });
  const done = () => { void qc.invalidateQueries(); onClose(); };
  const save = useMutation({
    mutationFn: () => api(f.id ? `/commitments/${f.id}` : '/commitments', {
      method: f.id ? 'PATCH' : 'POST',
      body: {
        kind: f.kind, name: f.name, provider: f.provider, amount: Number(f.amount), currency: f.currency.toUpperCase(), cadence: f.cadence, status: f.status,
        next_due_on: f.next_due_on || null, end_on: f.end_on || null, cancel_notice_days: f.cancel_notice_days === '' ? null : Number(f.cancel_notice_days),
        policy_number: f.policy_number || null, category_id: f.category_id, match_pattern: f.match_pattern || null, url: f.url || null, notes: f.notes || null,
      },
    }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api(`/commitments/${f.id}`, { method: 'DELETE' }), onSuccess: done });
  const contract = ['insurance', 'loan', 'rent', 'membership', 'utility'].includes(f.kind) || f.end_on !== '';

  return (
    <Modal title={f.id ? 'Edit commitment' : 'Add commitment'} onClose={onClose} wide>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form">
          <Field label="Type">
            <select value={f.kind} onChange={(e) => up({ kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
          </Field>
          <Field label="Name"><input required autoFocus value={f.name} onChange={(e) => up({ name: e.target.value })} /></Field>
          <Field label="Amount"><input type="number" required min="0.01" step="any" value={f.amount} onChange={(e) => up({ amount: e.target.value })} /></Field>
          <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
            <Field label="Currency"><input required maxLength={3} minLength={3} value={f.currency} onChange={(e) => up({ currency: e.target.value })} style={{ width: 80 }} /></Field>
            <div style={{ flex: 1 }}><Field label="Billed"><select value={f.cadence} onChange={(e) => up({ cadence: e.target.value })}>{CADENCES.map((c) => <option key={c}>{c}</option>)}</select></Field></div>
          </div>
          <Field label="Provider"><input value={f.provider} onChange={(e) => up({ provider: e.target.value })} /></Field>
          <Field label="Next due"><input type="date" value={f.next_due_on} onChange={(e) => up({ next_due_on: e.target.value })} /></Field>
          {f.kind === 'insurance' && <Field label="Policy number"><input value={f.policy_number} onChange={(e) => up({ policy_number: e.target.value })} /></Field>}
          {contract && (
            <>
              <Field label={f.kind === 'insurance' ? 'Renewal anniversary' : 'Contract ends'}><input type="date" value={f.end_on} onChange={(e) => up({ end_on: e.target.value })} /></Field>
              <Field label="Cancellation notice (days)" hint="Used to remind you before it renews"><input type="number" min="0" value={f.cancel_notice_days} onChange={(e) => up({ cancel_notice_days: e.target.value })} /></Field>
            </>
          )}
          <Field label="Category"><CategorySelect categories={categories} kinds={['expense', 'transfer']} value={f.category_id} onChange={(category_id) => up({ category_id })} /></Field>
          <Field label="Match payments containing" hint="Transactions with this text are linked automatically">
            <input value={f.match_pattern} onChange={(e) => up({ match_pattern: e.target.value })} placeholder="e.g. Netflix" />
          </Field>
          <Field label="Status">
            <select value={f.status} onChange={(e) => up({ status: e.target.value })}><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select>
          </Field>
          <Field label="Link"><input type="url" value={f.url} onChange={(e) => up({ url: e.target.value })} placeholder="https://" /></Field>
          <div className="full"><Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => up({ notes: e.target.value })} placeholder="Coverage, contact, login hint…" /></Field></div>
        </div>
        <ErrorNote error={save.error ?? remove.error} />
        <div className="form-actions">
          {f.id && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => confirm(`Delete ${f.name}? Its payments are kept.`) && remove.mutate()}>Delete</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.isPending}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
