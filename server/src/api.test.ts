import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { today } from './money.js';
import { DemoProvider } from './providers/demo.js';
import { Account, Commitment, Transaction } from './schemas.js';

let app: FastifyInstance;
let cookie = '';

const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie, ...headers } });
  return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? res.json() : res.body, headers: res.headers };
};

async function connect(name: string) {
  const start = await call('POST', '/api/connections', { provider: 'demo', institution_name: name, country: 'HU' });
  expect(start.status).toBe(200);
  const cb = await call('GET', new URL(start.body.auth_url).pathname + new URL(start.body.auth_url).search);
  expect(cb.status).toBe(302);
  expect(cb.headers.location).toMatch(/connected=/);
  for (let i = 0; i < 200 && app.ctx.syncing.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
  return start.body.id as number;
}

beforeAll(async () => {
  app = await buildApp({ db: openDb(':memory:'), providers: new Map([['demo', new DemoProvider()]]) });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'correct horse' } });
  cookie = String(setup.headers['set-cookie']).split(';')[0];
  for (const bank of ['Demo Revolut', 'Demo Erste Bank Hungary', 'Demo MBH Bank']) await connect(bank);
});

describe('authentication', () => {
  it('rejects anonymous access to data but serves the docs', async () => {
    expect((await app.inject({ url: '/api/accounts' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/openapi.json' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/agent-guide' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'another one' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
  });

  it('enforces token scopes', async () => {
    const ro = (await call('POST', '/api/tokens', { name: 'agent', scope: 'read' })).body.token as string;
    const rw = (await call('POST', '/api/tokens', { name: 'agent rw', scope: 'write' })).body.token as string;
    const as = (token: string, method: string, url: string, payload?: object) =>
      app.inject({ method: method as 'GET', url, payload, headers: { authorization: `Bearer ${token}` } });
    expect((await as(ro, 'GET', '/api/accounts')).statusCode).toBe(200);
    expect((await as(ro, 'POST', '/api/rules/apply', {})).statusCode).toBe(403);
    expect((await as(rw, 'POST', '/api/rules/apply', {})).statusCode).toBe(200);
    expect((await as(rw, 'GET', '/api/tokens')).statusCode).toBe(403);
    expect((await as(rw, 'POST', '/api/connections', { provider: 'demo', institution_name: 'Demo Revolut' })).statusCode).toBe(403);
    expect((await as('lq_bogus', 'GET', '/api/accounts')).statusCode).toBe(401);
    expect((await call('POST', '/api/rules/apply', {}, { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('bank sync with the demo provider', () => {
  it('creates accounts and transactions that match the documented schemas', async () => {
    const accounts = (await call('GET', '/api/accounts')).body;
    expect(accounts).toHaveLength(5);
    for (const a of accounts) expect(Value.Check(Account, a), JSON.stringify([...Value.Errors(Account, a)][0])).toBe(true);
    const list = (await call('GET', '/api/transactions?limit=1000')).body;
    expect(list.total).toBeGreaterThan(400);
    for (const t of list.items) expect(Value.Check(Transaction, t), JSON.stringify([...Value.Errors(Transaction, t)][0])).toBe(true);
  });

  it('is idempotent on re-sync', async () => {
    const before = (await call('GET', '/api/transactions?limit=1')).body.total;
    const results = (await call('POST', '/api/sync')).body;
    expect(results).toHaveLength(3);
    expect(results.every((r: any) => r.inserted === 0 && r.error === null)).toBe(true);
    expect((await call('GET', '/api/transactions?limit=1')).body.total).toBe(before);
  });

  it('categorises most spending and nets out internal transfers', async () => {
    const all = (await call('GET', '/api/transactions?limit=1000')).body.items;
    const uncategorized = all.filter((t: any) => t.category_id === null);
    expect(uncategorized.length / all.length).toBeLessThan(0.1);
    const topups = all.filter((t: any) => /top-up/i.test(t.description));
    expect(topups.length).toBeGreaterThan(10);
    expect(topups.every((t: any) => t.flow === 'transfer' && t.transfer_peer_id)).toBe(true);
    const flow = (await call('GET', '/api/insights/cashflow?months=3')).body.months[1];
    expect(flow.income).toBe(905000); // two salaries, no top-ups or savings transfers counted
    expect(flow.expenses).toBeGreaterThan(300000);
    expect(flow.expenses).toBeLessThan(900000);
  });

  it('keeps history when a bank is reconnected', async () => {
    const before = (await call('GET', '/api/accounts')).body;
    await connect('Demo Revolut');
    const after = (await call('GET', '/api/accounts')).body;
    expect(after.map((a: any) => [a.id, a.transactions])).toEqual(before.map((a: any) => [a.id, a.transactions]));
    expect((await call('GET', '/api/connections')).body).toHaveLength(3);
  });
});

describe('planning', () => {
  it('detects recurring payments and tracks one as a commitment', async () => {
    const candidates = (await call('GET', '/api/insights/recurring')).body.candidates;
    const names = candidates.map((c: any) => c.name);
    for (const expected of ['Netflix.com', 'Spotify AB', 'Generali Biztosító Zrt.', 'Kovács Péter', 'MBH Bank Nyrt.']) expect(names).toContain(expected);
    expect(names.some((n: string) => /lidl|spar|wolt/i.test(n))).toBe(false);

    const netflix = candidates.find((c: any) => c.name === 'Netflix.com');
    const created = await call('POST', '/api/commitments', {
      kind: 'subscription', name: 'Netflix', amount: netflix.amount, currency: netflix.currency, cadence: netflix.cadence, match_pattern: netflix.suggested_match_pattern,
    });
    expect(created.status).toBe(200);
    expect(Value.Check(Commitment, created.body), JSON.stringify([...Value.Errors(Commitment, created.body)][0])).toBe(true);
    expect(created.body.payments).toBeGreaterThanOrEqual(12);
    expect(created.body.next_due_on > today()).toBe(true);
    expect(created.body.yearly_cost_base).toBe(4990 * 12);
    const again = (await call('GET', '/api/insights/recurring')).body.candidates.map((c: any) => c.name);
    expect(again).not.toContain('Netflix.com');
    const detail = (await call('GET', `/api/commitments/${created.body.id}`)).body;
    expect(detail.transactions.length).toBe(created.body.payments);
  });

  it('tracks budgets against spending', async () => {
    const cats = (await call('GET', '/api/categories')).body;
    const groceries = cats.find((c: any) => c.name === 'Groceries');
    const salary = cats.find((c: any) => c.name === 'Salary');
    expect((await call('PUT', `/api/budgets/${salary.id}`, { amount: 10 })).status).toBe(400);
    expect((await call('PUT', `/api/budgets/${groceries.id}`, { amount: 1000 })).status).toBe(200);
    const month = today().slice(0, 7);
    const prev = (await call('GET', '/api/insights/cashflow?months=2')).body.months[0].month;
    const b = (await call('GET', `/api/budgets?month=${prev}`)).body.budgets[0];
    expect(b).toMatchObject({ category: 'Groceries', amount: 1000, status: 'over' });
    expect(b.spent).toBeGreaterThan(1000);
    expect((await call('GET', `/api/insights/overview?month=${month}`)).body.categories.length).toBeGreaterThan(0);
  });

  it('re-categorises through a new rule without touching manual choices', async () => {
    const cats = (await call('GET', '/api/categories')).body;
    const gifts = cats.find((c: any) => c.name === 'Gifts & donations');
    const travel = cats.find((c: any) => c.name === 'Travel');
    const wolt = (await call('GET', '/api/transactions?q=Wolt&limit=500')).body.items;
    expect(wolt.length).toBeGreaterThan(3);
    await call('PATCH', `/api/transactions/${wolt[0].id}`, { category_id: travel.id });
    const res = (await call('POST', '/api/rules', { pattern: 'wolt', category_id: gifts.id })).body;
    expect(res.recategorized).toBe(wolt.length - 1);
    const after = (await call('GET', '/api/transactions?q=Wolt&limit=500')).body.items;
    expect(after.find((t: any) => t.id === wolt[0].id).category_name).toBe('Travel');
    expect(after.filter((t: any) => t.category_name === 'Gifts & donations')).toHaveLength(wolt.length - 1);
  });
});

describe('insights', () => {
  it('reports spending breakdowns that add up', async () => {
    const byCat = (await call('GET', '/api/insights/spending?from=2000-01-01&group_by=category')).body;
    const byMonth = (await call('GET', '/api/insights/spending?from=2000-01-01&group_by=month')).body;
    const byMerchant = (await call('GET', '/api/insights/spending?from=2000-01-01&group_by=counterparty')).body;
    const sum = (rows: any[]) => Math.round(rows.reduce((s, r) => s + r.spent, 0));
    expect(sum(byCat.rows)).toBe(Math.round(byCat.total));
    expect(Math.round(byMonth.total)).toBe(Math.round(byCat.total));
    expect(sum(byMerchant.rows)).toBe(Math.round(byCat.total));
    expect(byMerchant.rows[0].label).toBe('Kovács Péter'); // rent is the largest payee
  });

  it('finds savings opportunities in the sample data', async () => {
    const res = (await call('GET', '/api/insights/savings-opportunities')).body;
    const types = res.opportunities.map((o: any) => o.type);
    expect(types).toContain('bank_fees');
    expect(types).toContain('untracked_recurring');
    expect(types).toContain('subscription_load');
    expect(types).toContain('price_increase'); // Telekom went from 8,490 to 9,990
  });

  it('reconstructs net worth history ending at the current net worth', async () => {
    const history = (await call('GET', '/api/insights/net-worth?months=6')).body.months;
    const overview = (await call('GET', '/api/insights/overview')).body;
    expect(history).toHaveLength(6);
    expect(history[5].net_worth).toBe(overview.net_worth);
    expect(history[0].net_worth).not.toBe(history[5].net_worth);
  });
});

describe('manual data', () => {
  it('supports cash accounts, manual transactions and CSV import', async () => {
    const acc = (await call('POST', '/api/accounts', { name: 'Wallet', currency: 'huf', type: 'cash', balance: 10000 })).body;
    expect(acc).toMatchObject({ currency: 'HUF', balance: 10000, source: 'manual' });
    const t = (await call('POST', '/api/transactions', { account_id: acc.id, booked_on: today(), amount: -2500, counterparty: 'Lidl' })).body;
    expect(t).toMatchObject({ amount: -2500, category_name: 'Groceries', flow: 'expense' });
    expect((await call('GET', '/api/accounts')).body.find((a: any) => a.id === acc.id).balance).toBe(7500);
    await call('DELETE', `/api/transactions/${t.id}`);
    expect((await call('GET', '/api/accounts')).body.find((a: any) => a.id === acc.id).balance).toBe(10000);

    const csv = 'Date,Description,Amount,Balance\n2024-05-01,Spar,-1200,8800\n2024-05-02,Refund,300,9100\n';
    const dry = (await call('POST', `/api/accounts/${acc.id}/import-csv`, { csv, dry_run: true })).body;
    expect(dry).toMatchObject({ parsed: 2, inserted: 0 });
    expect((await call('POST', `/api/accounts/${acc.id}/import-csv`, { csv })).body.inserted).toBe(2);
    expect((await call('POST', `/api/accounts/${acc.id}/import-csv`, { csv })).body.inserted).toBe(0);
    expect((await call('GET', '/api/accounts')).body.find((a: any) => a.id === acc.id).balance).toBe(9100);
    expect((await call('POST', `/api/accounts/${acc.id}/import-csv`, { csv: 'foo,bar\n1,2\n' })).status).toBe(400);
  });

  it('publishes an OpenAPI document covering the main resources', async () => {
    const spec = (await call('GET', '/api/openapi.json')).body;
    for (const p of ['/api/transactions', '/api/insights/savings-opportunities', '/api/commitments', '/api/budgets/{category_id}']) expect(spec.paths[p]).toBeDefined();
    expect(spec.paths['/api/connections/callback']).toBeUndefined();
  });
});
