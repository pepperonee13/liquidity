import { Type as T, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { badRequest, notFound } from '../app.js';
import { applyRules } from '../categorize.js';
import { baseCurrency } from '../db.js';
import { Fx } from '../fx.js';
import { fromMinor, toMinor } from '../money.js';
import { Category, Day, IdParams, Nullable, Ok, Rule, Transaction } from '../schemas.js';

export function txView(r: any) {
  return {
    id: r.id, account_id: r.account_id, account_name: r.account_name, booked_on: r.booked_on,
    amount: fromMinor(r.amount_minor), currency: r.currency, amount_base: fromMinor(r.amount_base_minor),
    counterparty: r.counterparty, description: r.description, status: r.status,
    category_id: r.category_id, category_name: r.category_name, category_source: r.category_source, flow: r.flow,
    commitment_id: r.commitment_id, transfer_peer_id: r.transfer_peer_id, mcc: r.mcc, notes: r.notes, source: r.source,
  };
}

export async function ledgerRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ---- Transactions ----
  const tags = ['transactions'];

  const ListQuery = T.Object({
    from: T.Optional(Day),
    to: T.Optional(Day),
    account_id: T.Optional(T.Integer()),
    category_id: T.Optional(T.Integer()),
    uncategorized: T.Optional(T.Boolean({ description: 'Only transactions without a category' })),
    commitment_id: T.Optional(T.Integer()),
    flow: T.Optional(T.Union([T.Literal('expense'), T.Literal('income'), T.Literal('transfer')])),
    q: T.Optional(T.String({ description: 'Case-insensitive text search in counterparty, description and notes' })),
    min_amount: T.Optional(T.Number({ description: 'Minimum absolute amount in base currency' })),
    max_amount: T.Optional(T.Number({ description: 'Maximum absolute amount in base currency' })),
    sort: T.Union([T.Literal('date_desc'), T.Literal('date_asc'), T.Literal('amount_desc'), T.Literal('amount_asc')], { default: 'date_desc', description: 'amount_* sorts by absolute base-currency amount' }),
    limit: T.Integer({ default: 100, minimum: 1, maximum: 1000 }),
    offset: T.Integer({ default: 0, minimum: 0 }),
  });

  app.get('/api/transactions', {
    schema: {
      tags, summary: 'Search transactions', querystring: ListQuery,
      response: { 200: T.Object({
        total: T.Integer({ description: 'Number of matches before limit/offset' }),
        sum_base: T.Number({ description: 'Signed sum of all matches in base currency' }),
        base_currency: T.String(),
        items: T.Array(Transaction),
      }) },
    },
  }, async (req) => {
    const q = req.query as Static<typeof ListQuery>;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.from) (where.push('booked_on >= ?'), params.push(q.from));
    if (q.to) (where.push('booked_on <= ?'), params.push(q.to));
    if (q.account_id) (where.push('account_id = ?'), params.push(q.account_id));
    if (q.category_id) (where.push('category_id = ?'), params.push(q.category_id));
    if (q.uncategorized) where.push('category_id IS NULL');
    if (q.commitment_id) (where.push('commitment_id = ?'), params.push(q.commitment_id));
    if (q.flow) (where.push('flow = ?'), params.push(q.flow));
    if (q.q) {
      where.push("(counterparty LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR COALESCE(notes, '') LIKE ? ESCAPE '\\')");
      const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(like, like, like);
    }
    if (q.min_amount !== undefined) (where.push('ABS(amount_base_minor) >= ?'), params.push(toMinor(q.min_amount)));
    if (q.max_amount !== undefined) (where.push('ABS(amount_base_minor) <= ?'), params.push(toMinor(q.max_amount)));
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = {
      date_desc: 'booked_on DESC, id DESC', date_asc: 'booked_on ASC, id ASC',
      amount_desc: 'ABS(amount_base_minor) DESC', amount_asc: 'ABS(amount_base_minor) ASC',
    }[q.sort];
    const agg = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(amount_base_minor), 0) AS sum FROM v_tx ${clause}`).get(...params) as { total: number; sum: number };
    const rows = db.prepare(`SELECT * FROM v_tx ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset);
    return { total: agg.total, sum_base: fromMinor(agg.sum), base_currency: baseCurrency(db), items: rows.map(txView) };
  });

  const one = (id: number) => {
    const row = db.prepare('SELECT * FROM v_tx WHERE id = ?').get(id);
    if (!row) throw notFound('Transaction');
    return txView(row);
  };
  const checkCategory = (id: number | null | undefined) => {
    if (id != null && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw badRequest(`Category ${id} does not exist.`);
  };

  app.get('/api/transactions/:id', { schema: { tags, summary: 'Get one transaction', params: IdParams, response: { 200: Transaction } } }, async (req) =>
    one((req.params as { id: number }).id),
  );

  const NewTx = T.Object({
    account_id: T.Integer(),
    booked_on: Day,
    amount: T.Number({ description: 'Signed; negative = money out' }),
    counterparty: T.Optional(T.String()),
    description: T.Optional(T.String()),
    category_id: T.Optional(Nullable(T.Integer())),
    notes: T.Optional(Nullable(T.String())),
    adjust_balance: T.Boolean({ default: true, description: 'For manual accounts: apply the amount to the account balance' }),
  });
  app.post('/api/transactions', {
    schema: { tags, summary: 'Add a transaction by hand (e.g. cash spending)', body: NewTx, response: { 200: Transaction } },
  }, async (req) => {
    const b = req.body as Static<typeof NewTx>;
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(b.account_id) as { id: number; currency: string; connection_id: number | null } | undefined;
    if (!account) throw badRequest(`Account ${b.account_id} does not exist.`);
    checkCategory(b.category_id);
    const minor = toMinor(b.amount);
    if (minor === 0) throw badRequest('Amount must not be zero.');
    const base = new Fx(db).convertMinor(minor, account.currency, baseCurrency(db), b.booked_on);
    const info = db
      .prepare(
        `INSERT INTO transactions (account_id, external_id, source, booked_on, amount_minor, currency, amount_base_minor,
           description, counterparty, category_id, category_source, notes)
         VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(account.id, `manual:${crypto.randomUUID()}`, b.booked_on, minor, account.currency, base, b.description ?? '', b.counterparty ?? '',
        b.category_id ?? null, b.category_id != null ? 'manual' : null, b.notes ?? null);
    if (b.adjust_balance && !account.connection_id) {
      db.prepare("UPDATE accounts SET balance_minor = balance_minor + ?, balance_at = datetime('now') WHERE id = ?").run(minor, account.id);
    }
    if (b.category_id == null) applyRules(db, 'uncategorized');
    return one(Number(info.lastInsertRowid));
  });

  const PatchTx = T.Partial(T.Object({
    category_id: Nullable(T.Integer({ description: 'null clears the category' })),
    notes: Nullable(T.String()),
    commitment_id: Nullable(T.Integer()),
  }));
  app.patch('/api/transactions/:id', {
    schema: { tags, summary: 'Change category, notes or commitment link', description: 'A category set here is marked as manual and is never overwritten by rules.', params: IdParams, body: PatchTx, response: { 200: Transaction } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const b = req.body as Static<typeof PatchTx>;
    one(id);
    if (b.category_id !== undefined) {
      checkCategory(b.category_id);
      db.prepare('UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?').run(b.category_id, b.category_id === null ? null : 'manual', id);
    }
    if (b.notes !== undefined) db.prepare('UPDATE transactions SET notes = ? WHERE id = ?').run(b.notes, id);
    if (b.commitment_id !== undefined) {
      if (b.commitment_id !== null && !db.prepare('SELECT 1 FROM commitments WHERE id = ?').get(b.commitment_id)) throw badRequest('Commitment does not exist.');
      db.prepare('UPDATE transactions SET commitment_id = ? WHERE id = ?').run(b.commitment_id, id);
    }
    return one(id);
  });

  const Bulk = T.Object({
    ids: T.Array(T.Integer(), { minItems: 1, maxItems: 5000 }),
    category_id: Nullable(T.Integer()),
  });
  app.post('/api/transactions/bulk-categorize', {
    schema: { tags, summary: 'Set the category of many transactions at once', body: Bulk, response: { 200: T.Object({ updated: T.Integer() }) } },
  }, async (req) => {
    const b = req.body as Static<typeof Bulk>;
    checkCategory(b.category_id);
    const upd = db.prepare('UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?');
    let updated = 0;
    db.transaction(() => {
      for (const id of b.ids) updated += upd.run(b.category_id, b.category_id === null ? null : 'manual', id).changes;
    })();
    return { updated };
  });

  app.delete('/api/transactions/:id', {
    schema: { tags, summary: 'Delete a transaction', description: 'Bank-synced transactions reappear on the next sync; delete only manual or CSV rows.', params: IdParams, response: { 200: Ok } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const tx = db.prepare('SELECT t.amount_minor, t.source, a.id AS account_id, a.connection_id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(id) as
      | { amount_minor: number; source: string; account_id: number; connection_id: number | null } | undefined;
    if (!tx) throw notFound('Transaction');
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    if (tx.source === 'manual' && !tx.connection_id) db.prepare('UPDATE accounts SET balance_minor = balance_minor - ? WHERE id = ?').run(tx.amount_minor, tx.account_id);
    return { ok: true };
  });

  // ---- Categories ----
  const ctags = ['categories'];
  const catView = (where = '', params: unknown[] = []) =>
    (db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS transactions
       FROM categories c ${where} ORDER BY CASE c.kind WHEN 'income' THEN 0 WHEN 'expense' THEN 1 ELSE 2 END, c.grp, c.name`,
    ).all(...params) as any[]).map((c) => ({ id: c.id, name: c.name, kind: c.kind, group: c.grp, essential: Boolean(c.essential), transactions: c.transactions }));

  app.get('/api/categories', { schema: { tags: ctags, summary: 'List categories', response: { 200: T.Array(Category) } } }, async () => catView());

  const CatInput = T.Object({
    name: T.String({ minLength: 1, maxLength: 60 }),
    kind: T.Union([T.Literal('expense'), T.Literal('income'), T.Literal('transfer')]),
    group: T.Optional(T.String({ maxLength: 40 })),
    essential: T.Optional(T.Boolean()),
  });
  app.post('/api/categories', { schema: { tags: ctags, summary: 'Create a category', body: CatInput, response: { 200: Category } } }, async (req) => {
    const b = req.body as Static<typeof CatInput>;
    const info = db.prepare('INSERT INTO categories (name, kind, grp, essential) VALUES (?, ?, ?, ?)').run(b.name.trim(), b.kind, b.group?.trim() || 'Other', b.essential ? 1 : 0);
    return catView('WHERE c.id = ?', [info.lastInsertRowid])[0];
  });

  app.patch('/api/categories/:id', { schema: { tags: ctags, summary: 'Update a category', params: IdParams, body: T.Partial(CatInput), response: { 200: Category } } }, async (req) => {
    const id = (req.params as { id: number }).id;
    const b = req.body as Partial<Static<typeof CatInput>>;
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw notFound('Category');
    if (b.name !== undefined) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(b.name.trim(), id);
    if (b.kind !== undefined) db.prepare('UPDATE categories SET kind = ? WHERE id = ?').run(b.kind, id);
    if (b.group !== undefined) db.prepare('UPDATE categories SET grp = ? WHERE id = ?').run(b.group.trim() || 'Other', id);
    if (b.essential !== undefined) db.prepare('UPDATE categories SET essential = ? WHERE id = ?').run(b.essential ? 1 : 0, id);
    return catView('WHERE c.id = ?', [id])[0];
  });

  app.delete('/api/categories/:id', {
    schema: { tags: ctags, summary: 'Delete a category', description: 'Its transactions become uncategorised (or move to `move_to`); its rules and budget are removed.',
      params: IdParams, querystring: T.Object({ move_to: T.Optional(T.Integer()) }), response: { 200: Ok } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const moveTo = (req.query as { move_to?: number }).move_to;
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw notFound('Category');
    if (moveTo === id) throw badRequest('move_to must be a different category.');
    checkCategory(moveTo);
    db.transaction(() => {
      if (moveTo) db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(moveTo, id);
      else db.prepare('UPDATE transactions SET category_source = NULL WHERE category_id = ?').run(id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    })();
    return { ok: true };
  });

  // ---- Rules ----
  const ruleView = (where = '', params: unknown[] = []) =>
    (db.prepare(
      `SELECT r.*, c.name AS category_name FROM rules r JOIN categories c ON c.id = r.category_id ${where} ORDER BY r.builtin, r.priority, r.id`,
    ).all(...params) as any[]).map((r) => ({ ...r, builtin: Boolean(r.builtin), created_at: undefined }));

  app.get('/api/rules', {
    schema: { tags: ctags, summary: 'List auto-categorisation rules', querystring: T.Object({ builtin: T.Optional(T.Boolean({ description: 'Filter to built-in (true) or own (false) rules' })) }), response: { 200: T.Array(Rule) } },
  }, async (req) => {
    const b = (req.query as { builtin?: boolean }).builtin;
    return b === undefined ? ruleView() : ruleView('WHERE r.builtin = ?', [b ? 1 : 0]);
  });

  const RuleInput = T.Object({
    pattern: T.String({ minLength: 1, maxLength: 200 }),
    category_id: T.Integer(),
    field: T.Union([T.Literal('any'), T.Literal('counterparty'), T.Literal('description'), T.Literal('mcc')], { default: 'any' }),
    match_type: T.Union([T.Literal('contains'), T.Literal('regex')], { default: 'contains' }),
    direction: T.Union([T.Literal('any'), T.Literal('in'), T.Literal('out')], { default: 'any' }),
    priority: T.Integer({ default: 100, description: 'Own rules default to 100 and so beat the built-in rules (400-900)' }),
    apply: T.Boolean({ default: true, description: 'Immediately re-categorise existing transactions that were not set by hand' }),
  });
  app.post('/api/rules', {
    schema: { tags: ctags, summary: 'Create a rule', body: RuleInput, response: { 200: T.Object({ rule: Rule, recategorized: T.Integer() }) } },
  }, async (req) => {
    const b = req.body as Static<typeof RuleInput>;
    checkCategory(b.category_id);
    if (b.match_type === 'regex') {
      try { new RegExp(b.pattern); } catch { throw badRequest('Pattern is not a valid regular expression.'); }
    }
    const info = db.prepare('INSERT INTO rules (priority, field, match_type, pattern, direction, category_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.priority, b.field, b.match_type, b.pattern.trim(), b.direction, b.category_id);
    const recategorized = b.apply ? applyRules(db, 'all') : 0;
    return { rule: ruleView('WHERE r.id = ?', [info.lastInsertRowid])[0], recategorized };
  });

  app.delete('/api/rules/:id', { schema: { tags: ctags, summary: 'Delete a rule', params: IdParams, response: { 200: Ok } } }, async (req) => {
    db.prepare('DELETE FROM rules WHERE id = ?').run((req.params as { id: number }).id);
    return { ok: true };
  });

  app.post('/api/rules/apply', {
    schema: { tags: ctags, summary: 'Re-run the rules over stored transactions',
      body: T.Object({ scope: T.Union([T.Literal('uncategorized'), T.Literal('all')], { default: 'uncategorized', description: '"all" also re-evaluates rule-assigned categories; manual choices are always kept' }) }),
      response: { 200: T.Object({ recategorized: T.Integer() }) } },
  }, async (req) => ({ recategorized: applyRules(db, (req.body as { scope: 'uncategorized' | 'all' }).scope) }));
}
