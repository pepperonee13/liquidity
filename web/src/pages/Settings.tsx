import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type ApiToken, type Rule } from '../api';
import { Card, CategorySelect, Empty, ErrorNote, Field, PageHeader, Pill, useBaseCurrency, useCategories } from '../ui';

export function Settings() {
  return (
    <>
      <PageHeader title="Settings">
        <button className="btn" onClick={() => void api('/auth/logout', { method: 'POST' }).then(() => window.location.reload())}>Log out</button>
      </PageHeader>
      <div className="stack">
        <AgentAccess />
        <General />
        <Categories />
        <Rules />
        <Password />
      </div>
    </>
  );
}

function AgentAccess() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<ApiToken[]>('/tokens') }).data ?? [];
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api<{ token: string }>('/tokens', { body: { name, scope } }),
    onSuccess: (r) => { setSecret(r.token); setCopied(false); setName(''); void qc.invalidateQueries({ queryKey: ['tokens'] }); },
  });
  const revoke = useMutation({ mutationFn: (id: number) => api(`/tokens/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }) });
  const origin = window.location.origin;
  const prompt = `You can read my personal finance data through the Liquidity API.\nStart by reading the guide at ${origin}/api/agent-guide (the full OpenAPI spec is at ${origin}/api/openapi.json).\nAuthenticate every request with the header: Authorization: Bearer ${secret ?? '<token>'}`;

  return (
    <Card title="AI agent access">
      <div className="stack">
        <p className="muted">Give an AI agent the guide and a token, and it can analyse your finances through the API. Read-only tokens cannot change anything; no token can reach your bank logins.</p>
        <div className="list">
          <div><span className="grow">Agent guide (Markdown)</span><a href="/api/agent-guide" target="_blank" rel="noreferrer"><code>{origin}/api/agent-guide</code></a></div>
          <div><span className="grow">OpenAPI specification</span><a href="/api/openapi.json" target="_blank" rel="noreferrer"><code>{origin}/api/openapi.json</code></a></div>
          <div><span className="grow">Interactive API reference</span><a href="/api/docs" target="_blank" rel="noreferrer"><code>{origin}/api/docs</code></a></div>
        </div>
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <input required placeholder="Token name, e.g. Claude" aria-label="Token name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 180px' }} />
          <select aria-label="Access level" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="read">Read only</option>
            <option value="write">Read and organise (categories, rules, budgets, commitments)</option>
          </select>
          <button className="btn primary" disabled={create.isPending}>Create token</button>
        </form>
        <ErrorNote error={create.error ?? revoke.error} />
        {secret && (
          <div className="note ok stack" style={{ gap: 8 }}>
            <strong>Copy this now. The token is shown only once.</strong>
            <code>{secret}</code>
            <span>Paste this into your agent to get it started:</span>
            <textarea readOnly rows={4} value={prompt} style={{ width: '100%', fontSize: '0.87rem' }} onFocus={(e) => e.target.select()} />
            <div><button className="btn small" onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy instructions'}</button></div>
          </div>
        )}
        {tokens.length > 0 && (
          <div className="list">
            {tokens.map((t) => (
              <div key={t.id}>
                <div className="grow">{t.name} <Pill>{t.scope === 'read' ? 'read only' : 'read and organise'}</Pill><small style={{ display: 'block' }}><code>{t.prefix}…</code> · {t.last_used_at ? `last used ${t.last_used_at} UTC` : 'never used'}</small></div>
                <button className="btn small danger" onClick={() => confirm(`Revoke the token “${t.name}”?`) && revoke.mutate(t.id)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function General() {
  const qc = useQueryClient();
  const base = useBaseCurrency();
  const [value, setValue] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api('/settings', { method: 'PATCH', body: { base_currency: (value ?? base).toUpperCase() } }),
    onSuccess: () => { setValue(null); void qc.invalidateQueries(); },
  });
  return (
    <Card title="General">
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Base currency" hint="Totals, budgets and charts are shown in this currency">
          <input required minLength={3} maxLength={3} value={value ?? base} onChange={(e) => setValue(e.target.value)} style={{ width: 100 }} />
        </Field>
        <button className="btn" disabled={save.isPending || value === null || value.toUpperCase() === base} style={{ marginBottom: 22 }}>Save</button>
      </form>
      <ErrorNote error={save.error} />
    </Card>
  );
}

function Categories() {
  const qc = useQueryClient();
  const categories = useCategories();
  const [f, setF] = useState({ name: '', kind: 'expense', group: '' });
  const done = () => qc.invalidateQueries();
  const add = useMutation({ mutationFn: () => api('/categories', { body: f }), onSuccess: () => { setF({ ...f, name: '' }); void done(); } });
  const patch = useMutation({ mutationFn: (v: { id: number; essential: boolean }) => api(`/categories/${v.id}`, { method: 'PATCH', body: { essential: v.essential } }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: number) => api(`/categories/${id}`, { method: 'DELETE' }), onSuccess: done });
  return (
    <Card title="Categories">
      <div className="stack">
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
          <input required placeholder="New category" aria-label="Category name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ flex: '1 1 160px' }} />
          <select aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select>
          <input placeholder="Group" aria-label="Group" list="groups" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} style={{ width: 140 }} />
          <datalist id="groups">{[...new Set(categories.map((c) => c.group))].map((g) => <option key={g} value={g} />)}</datalist>
          <button className="btn">Add</button>
        </form>
        <ErrorNote error={add.error ?? remove.error ?? patch.error} />
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>Name</th><th>Group</th><th>Kind</th><th>Essential</th><th className="r">Transactions</th><th /></tr></thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td><td className="muted">{c.group}</td><td className="muted">{c.kind}</td>
                  <td>{c.kind === 'expense' && <input type="checkbox" aria-label={`${c.name} is essential`} checked={c.essential} onChange={(e) => patch.mutate({ id: c.id, essential: e.target.checked })} />}</td>
                  <td className="r num">{c.transactions}</td>
                  <td className="r"><button className="btn small danger" onClick={() => confirm(`Delete “${c.name}”? Its ${c.transactions} transactions become uncategorised.`) && remove.mutate(c.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function Rules() {
  const qc = useQueryClient();
  const categories = useCategories();
  const [showBuiltin, setShowBuiltin] = useState(false);
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/rules') }).data ?? [];
  const [f, setF] = useState({ pattern: '', category_id: null as number | null });
  const [message, setMessage] = useState('');
  const done = () => qc.invalidateQueries();
  const add = useMutation({
    mutationFn: () => api<{ recategorized: number }>('/rules', { body: f }),
    onSuccess: (r) => { setF({ pattern: '', category_id: f.category_id }); setMessage(`Rule added, ${r.recategorized} transactions re-categorised.`); void done(); },
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/rules/${id}`, { method: 'DELETE' }), onSuccess: done });
  const reapply = useMutation({
    mutationFn: () => api<{ recategorized: number }>('/rules/apply', { body: { scope: 'all' } }),
    onSuccess: (r) => { setMessage(`${r.recategorized} transactions re-categorised.`); void done(); },
  });
  const shown = rules.filter((r) => showBuiltin || !r.builtin);
  return (
    <Card title="Categorisation rules" action={<button className="btn small" disabled={reapply.isPending} onClick={() => reapply.mutate()}>Re-apply all rules</button>}>
      <div className="stack">
        <p className="muted">When a merchant or description contains the text, the transaction gets the category. Your rules win over the built-in ones; categories you set by hand are never changed.</p>
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); if (f.category_id) add.mutate(); }}>
          <input required placeholder="Text to match, e.g. Kifli" aria-label="Pattern" value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} style={{ flex: '1 1 180px' }} />
          <CategorySelect aria-label="Category" categories={categories} value={f.category_id} onChange={(category_id) => setF({ ...f, category_id })} />
          <button className="btn" disabled={!f.category_id || add.isPending}>Add rule</button>
        </form>
        <ErrorNote error={add.error ?? remove.error ?? reapply.error} />
        {message && <p className="note ok" role="status">{message}</p>}
        <label className="row"><input type="checkbox" checked={showBuiltin} onChange={(e) => setShowBuiltin(e.target.checked)} /> Show the {rules.filter((r) => r.builtin).length} built-in rules</label>
        {shown.length === 0 ? <Empty>No rules of your own yet.</Empty> : (
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Matches</th><th>Category</th><th /></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><code>{r.pattern}</code> <small>{[r.field !== 'any' && `in ${r.field}`, r.match_type === 'regex' && 'regex', r.direction !== 'any' && `money ${r.direction}`, r.builtin && 'built-in'].filter(Boolean).join(' · ')}</small></td>
                    <td>{r.category_name}</td>
                    <td className="r"><button className="btn small danger" onClick={() => remove.mutate(r.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function Password() {
  const [f, setF] = useState({ current: '', password: '' });
  const [ok, setOk] = useState(false);
  const save = useMutation({ mutationFn: () => api('/auth/password', { body: f }), onSuccess: () => { setOk(true); setF({ current: '', password: '' }); } });
  return (
    <Card title="Password">
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); setOk(false); save.mutate(); }}>
        <Field label="Current password"><input type="password" required autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password"><input type="password" required minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <button className="btn" disabled={save.isPending}>Change password</button>
      </form>
      <ErrorNote error={save.error} />
      {ok && <p className="note ok" role="status" style={{ marginTop: 10 }}>Password changed. Other devices were logged out.</p>}
    </Card>
  );
}
