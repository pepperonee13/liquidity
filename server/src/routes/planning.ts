import { Type as T, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { badRequest, notFound } from '../app.js';
import { baseCurrency, setSetting } from '../db.js';
import { rebaseTransactions, syncFxRates } from '../fx.js';
import { budgetStatus, commitmentsView } from '../insights.js';
import { toMinor, today } from '../money.js';
import { linkCommitments } from '../recurring.js';
import { Commitment, CommitmentInput, CommitmentKind, CommitmentStatus, Currency, IdParams, Month, Ok, Transaction } from '../schemas.js';
import { txView } from './ledger.js';

const BudgetRow = T.Object({
  category_id: T.Integer(),
  category: T.String(),
  category_group: T.String(),
  amount: T.Number({ description: 'Monthly budget in base currency' }),
  spent: T.Number(),
  remaining: T.Number(),
  used_ratio: T.Union([T.Number(), T.Null()]),
  projected: T.Number({ description: 'Projected month-end spending at the current pace' }),
  status: T.Union([T.Literal('on_track'), T.Literal('at_risk'), T.Literal('over')]),
});

export async function planningRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ---- Settings ----
  const Settings = T.Object({ base_currency: Currency });
  app.get('/api/settings', { schema: { tags: ['settings'], summary: 'Get settings', response: { 200: Settings } } }, async () => ({ base_currency: baseCurrency(db) }));
  app.patch('/api/settings', {
    schema: { tags: ['settings'], summary: 'Change settings', description: 'Changing the base currency re-converts all transactions. Budgets keep their numbers and should be reviewed.', body: T.Partial(Settings), response: { 200: Settings } },
  }, async (req) => {
    const b = req.body as { base_currency?: string };
    if (b.base_currency && b.base_currency.toUpperCase() !== baseCurrency(db)) {
      setSetting(db, 'base_currency', b.base_currency.toUpperCase());
      await syncFxRates(db);
      rebaseTransactions(db);
    }
    return { base_currency: baseCurrency(db) };
  });

  // ---- Budgets ----
  app.get('/api/budgets', {
    schema: { tags: ['budgets'], summary: 'Budgets with spending for a month', querystring: T.Object({ month: T.Optional(Month) }),
      response: { 200: T.Object({ month: T.String(), base_currency: T.String(), budgets: T.Array(BudgetRow) }) } },
  }, async (req) => {
    const month = (req.query as { month?: string }).month ?? today().slice(0, 7);
    return { month, base_currency: baseCurrency(db), budgets: budgetStatus(db, month) };
  });

  app.put('/api/budgets/:category_id', {
    schema: { tags: ['budgets'], summary: 'Set the monthly budget of a category', params: T.Object({ category_id: T.Integer() }),
      body: T.Object({ amount: T.Number({ minimum: 0, description: 'Monthly limit in base currency' }) }), response: { 200: Ok } },
  }, async (req) => {
    const id = (req.params as { category_id: number }).category_id;
    const cat = db.prepare('SELECT kind FROM categories WHERE id = ?').get(id) as { kind: string } | undefined;
    if (!cat) throw notFound('Category');
    if (cat.kind !== 'expense') throw badRequest('Budgets can only be set on expense categories.');
    db.prepare('INSERT INTO budgets (category_id, amount_minor) VALUES (?, ?) ON CONFLICT(category_id) DO UPDATE SET amount_minor = excluded.amount_minor')
      .run(id, toMinor((req.body as { amount: number }).amount));
    return { ok: true };
  });

  app.delete('/api/budgets/:category_id', {
    schema: { tags: ['budgets'], summary: 'Remove a budget', params: T.Object({ category_id: T.Integer() }), response: { 200: Ok } },
  }, async (req) => {
    db.prepare('DELETE FROM budgets WHERE category_id = ?').run((req.params as { category_id: number }).category_id);
    return { ok: true };
  });

  // ---- Commitments ----
  const tags = ['commitments'];
  const one = (id: number) => {
    const c = commitmentsView(db).find((x) => x.id === id);
    if (!c) throw notFound('Commitment');
    return c;
  };

  app.get('/api/commitments', {
    schema: { tags, summary: 'List recurring commitments (subscriptions, insurance, utilities, loans, …)',
      querystring: T.Object({ status: T.Optional(CommitmentStatus), kind: T.Optional(CommitmentKind) }),
      response: { 200: T.Object({
        base_currency: T.String(),
        monthly_total_base: T.Number({ description: 'Sum of active commitments, per month' }),
        yearly_total_base: T.Number(),
        commitments: T.Array(Commitment),
      }) } },
  }, async (req) => {
    const list = commitmentsView(db, req.query as { status?: string; kind?: string });
    const active = list.filter((c) => c.status === 'active');
    const yearly = active.reduce((s, c) => s + c.yearly_cost_base, 0);
    return {
      base_currency: baseCurrency(db),
      monthly_total_base: Math.round((yearly / 12) * 100) / 100,
      yearly_total_base: Math.round(yearly * 100) / 100,
      commitments: list,
    };
  });

  app.get('/api/commitments/:id', {
    schema: { tags, summary: 'One commitment with its payment history', params: IdParams,
      response: { 200: T.Object({ commitment: Commitment, transactions: T.Array(Transaction) }) } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    return {
      commitment: one(id),
      transactions: db.prepare('SELECT * FROM v_tx WHERE commitment_id = ? ORDER BY booked_on DESC').all(id).map(txView),
    };
  });

  const COLS = ['kind', 'name', 'provider', 'currency', 'cadence', 'next_due_on', 'start_on', 'end_on', 'cancel_notice_days',
    'policy_number', 'account_id', 'category_id', 'match_pattern', 'status', 'url', 'notes'] as const;

  app.post('/api/commitments', {
    schema: { tags, summary: 'Track a recurring commitment', description: 'With `match_pattern`, past and future matching payments are linked automatically and `next_due_on` follows the last payment.',
      body: CommitmentInput, response: { 200: Commitment } },
  }, async (req) => {
    const b = req.body as Static<typeof CommitmentInput>;
    if (b.amount <= 0) throw badRequest('Amount must be positive.');
    const info = db.prepare(
      `INSERT INTO commitments (kind, name, provider, amount_minor, currency, cadence, next_due_on, start_on, end_on, cancel_notice_days,
         policy_number, account_id, category_id, match_pattern, status, url, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(b.kind, b.name.trim(), b.provider ?? '', toMinor(b.amount), b.currency.toUpperCase(), b.cadence, b.next_due_on ?? null, b.start_on ?? null,
      b.end_on ?? null, b.cancel_notice_days ?? null, b.policy_number ?? null, b.account_id ?? null, b.category_id ?? null,
      b.match_pattern?.trim() || null, b.status ?? 'active', b.url ?? null, b.notes ?? null);
    linkCommitments(db);
    return one(Number(info.lastInsertRowid));
  });

  app.patch('/api/commitments/:id', {
    schema: { tags, summary: 'Update a commitment', params: IdParams, body: T.Partial(CommitmentInput), response: { 200: Commitment } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const b = req.body as Partial<Static<typeof CommitmentInput>> & Record<string, unknown>;
    one(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const col of COLS) {
      if (b[col] === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(col === 'currency' ? String(b[col]).toUpperCase() : col === 'provider' ? (b[col] ?? '') : b[col]);
    }
    if (b.amount !== undefined) {
      if (b.amount <= 0) throw badRequest('Amount must be positive.');
      sets.push('amount_minor = ?');
      params.push(toMinor(b.amount));
    }
    if (sets.length) db.prepare(`UPDATE commitments SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    if (b.match_pattern !== undefined) linkCommitments(db);
    return one(id);
  });

  app.delete('/api/commitments/:id', { schema: { tags, summary: 'Delete a commitment (its transactions are kept)', params: IdParams, response: { 200: Ok } } }, async (req) => {
    const id = (req.params as { id: number }).id;
    one(id);
    db.prepare('DELETE FROM commitments WHERE id = ?').run(id);
    return { ok: true };
  });
}
