import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Budget } from '../api';
import { Card, CategorySelect, Empty, ErrorNote, Field, Modal, money, MonthPicker, PageHeader, Pill, thisMonth, useCategories } from '../ui';

interface Trends { categories: { category_id: number | null; category: string; monthly_average: number }[] }

export function Budgets() {
  const [month, setMonth] = useState(thisMonth());
  const [editing, setEditing] = useState<{ category_id: number | null; amount: string } | null>(null);
  const qc = useQueryClient();
  const categories = useCategories();
  const { data } = useQuery({ queryKey: ['budgets', month], queryFn: () => api<{ base_currency: string; budgets: Budget[] }>(`/budgets?month=${month}`) });
  const trends = useQuery({ queryKey: ['trends', 6], queryFn: () => api<Trends>('/insights/category-trends?months=6') }).data;
  const cur = data?.base_currency ?? 'HUF';
  const avg = (id: number | null) => trends?.categories.find((c) => c.category_id === id)?.monthly_average ?? 0;

  const save = useMutation({
    mutationFn: (v: { category_id: number; amount: number }) => api(`/budgets/${v.category_id}`, { method: 'PUT', body: { amount: v.amount } }),
    onSuccess: () => { void qc.invalidateQueries(); setEditing(null); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/budgets/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries(); setEditing(null); },
  });

  const budgets = data?.budgets ?? [];
  const budgeted = new Set(budgets.map((b) => b.category_id));
  const suggestions = (trends?.categories ?? []).filter((c) => c.category_id !== null && !budgeted.has(c.category_id) && c.monthly_average > 0).slice(0, 6);
  const total = budgets.reduce((s, b) => s + b.amount, 0);
  const spent = budgets.reduce((s, b) => s + b.spent, 0);
  const label = { on_track: 'On track', at_risk: 'At risk', over: 'Over' } as const;
  const tone = { on_track: 'good', at_risk: 'warn', over: 'bad' } as const;

  return (
    <>
      <PageHeader title="Budgets">
        <MonthPicker month={month} onChange={setMonth} />
        <button className="btn primary" onClick={() => setEditing({ category_id: null, amount: '' })}>Add budget</button>
      </PageHeader>
      <div className="stack">
        <Card title={budgets.length ? `${money(spent, cur)} spent of ${money(total, cur)} budgeted` : 'Monthly budgets'}>
          {budgets.length === 0 ? <Empty>No budgets yet. Add one, or start from a suggestion below.</Empty> : (
            <div className="list">
              {budgets.map((b) => (
                <div key={b.category_id} style={{ display: 'block' }}>
                  <div className="row between" style={{ marginBottom: 6 }}>
                    <span><Link to={`/transactions?month=${month}&category_id=${b.category_id}`}><strong>{b.category}</strong></Link> <Pill tone={tone[b.status]}>{label[b.status]}</Pill></span>
                    <span className="row">
                      <span className="num">{money(b.spent, cur)} <span className="muted">of {money(b.amount, cur)}</span></span>
                      <button className="btn small" onClick={() => setEditing({ category_id: b.category_id, amount: String(b.amount) })}>Edit</button>
                    </span>
                  </div>
                  <div className={`meter ${b.status}`} role="img" aria-label={`${Math.round((b.used_ratio ?? 0) * 100)}% of budget used`}>
                    <i style={{ width: `${Math.min(100, (b.used_ratio ?? 0) * 100)}%` }} />
                  </div>
                  <small>
                    {b.remaining >= 0 ? `${money(b.remaining, cur)} left` : `${money(-b.remaining, cur)} over`}
                    {month === thisMonth() && ` · on pace for ${money(b.projected, cur)}`} · 6-month average {money(avg(b.category_id), cur)}
                  </small>
                </div>
              ))}
            </div>
          )}
        </Card>
        {suggestions.length > 0 && (
          <Card title="Suggested from your last six months">
            <div className="list">
              {suggestions.map((s) => (
                <div key={s.category_id}>
                  <div className="grow">{s.category}<small style={{ display: 'block' }}>averages {money(s.monthly_average, cur)} a month</small></div>
                  <button className="btn small" onClick={() => setEditing({ category_id: s.category_id, amount: String(roundNice(s.monthly_average)) })}>Set budget</button>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
      {editing && (
        <Modal title={budgeted.has(editing.category_id ?? -1) ? 'Edit budget' : 'Add budget'} onClose={() => setEditing(null)}>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (editing.category_id) save.mutate({ category_id: editing.category_id, amount: Number(editing.amount) }); }}>
            <div className="form">
              <Field label="Category">
                <CategorySelect categories={categories} kinds={['expense']} allowNone={editing.category_id === null} value={editing.category_id}
                  onChange={(category_id) => setEditing({ ...editing, category_id })} />
              </Field>
              <Field label={`Monthly limit (${cur})`} hint={editing.category_id ? `6-month average: ${money(avg(editing.category_id), cur)}` : undefined}>
                <input type="number" required min="0" step="any" autoFocus value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
              </Field>
            </div>
            <ErrorNote error={save.error ?? remove.error} />
            <div className="form-actions">
              {budgeted.has(editing.category_id ?? -1) && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => remove.mutate(editing.category_id!)}>Remove</button>}
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" disabled={!editing.category_id || save.isPending}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function roundNice(n: number): number {
  const step = n >= 100_000 ? 10_000 : n >= 10_000 ? 1_000 : n >= 1_000 ? 100 : 10;
  return Math.ceil(n / step) * step;
}
