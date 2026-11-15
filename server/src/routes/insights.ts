import { Type as T } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { baseCurrency } from '../db.js';
import { cashflow, categoryTrends, netWorthHistory, overview, savingsOpportunities, spending, type SpendingGroup } from '../insights.js';
import { addMonths, fromMinor, today } from '../money.js';
import { detectRecurring } from '../recurring.js';
import { Day, Month, Nullable, RecurringCandidate, Totals } from '../schemas.js';

export async function insightRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const tags = ['insights'];
  const MonthsQuery = T.Object({ months: T.Integer({ default: 12, minimum: 1, maximum: 60 }) });

  app.get('/api/insights/overview', {
    schema: {
      tags, summary: 'Snapshot of one month: net worth, income, expenses, categories, budgets, upcoming bills',
      querystring: T.Object({ month: T.Optional(Month) }),
      response: { 200: T.Object({
        base_currency: T.String(),
        month: T.String(),
        net_worth: T.Number(),
        accounts: T.Array(T.Object({ id: T.Integer(), name: T.String(), institution: T.String(), type: T.String(), currency: T.String(), balance: T.Number(), balance_base: T.Number() })),
        totals: Totals,
        previous_month_totals: Totals,
        categories: T.Array(T.Object({
          category_id: Nullable(T.Integer()), category: T.String(), category_group: T.String(), spent: T.Number(),
          previous_month_spent: T.Number(), budget: Nullable(T.Number()), transactions: T.Integer(),
        })),
        daily_spending: T.Array(T.Object({ day: T.String(), spent: T.Number() })),
        previous_month_daily_spending: T.Array(T.Object({ day: T.String(), spent: T.Number() })),
        uncategorized_transactions: T.Integer(),
        commitments_monthly_total: T.Number(),
        upcoming_commitments: T.Array(T.Object({
          id: T.Integer(), name: T.String(), kind: T.String(), amount: T.Number(), currency: T.String(), amount_base: T.Number(),
          next_due_on: Nullable(T.String()), days_until_due: Nullable(T.Integer()),
        })),
      }) },
    },
  }, async (req) => overview(db, (req.query as { month?: string }).month ?? today().slice(0, 7)));

  app.get('/api/insights/spending', {
    schema: {
      tags, summary: 'Spending for a date range, grouped by category, category group, merchant, month or account',
      description: 'Net of refunds, transfers excluded, base currency. Defaults to the last 30 days by category.',
      querystring: T.Object({
        from: T.Optional(Day), to: T.Optional(Day),
        group_by: T.Union(['category', 'group', 'counterparty', 'month', 'account'].map((v) => T.Literal(v)), { default: 'category' }),
        category_id: T.Optional(T.Integer()), account_id: T.Optional(T.Integer()),
      }),
      response: { 200: T.Object({
        base_currency: T.String(), from: T.String(), to: T.String(), group_by: T.String(), total: T.Number(),
        rows: T.Array(T.Object({ key: T.String(), label: T.String(), spent: T.Number(), transactions: T.Integer(), share: T.Number({ description: 'Fraction of total, 0..1' }) })),
      }) },
    },
  }, async (req) => {
    const q = req.query as { from?: string; to?: string; group_by: SpendingGroup; category_id?: number; account_id?: number };
    const to = q.to ?? today();
    return spending(db, { from: q.from ?? addMonths(to, -1), to, groupBy: q.group_by, categoryId: q.category_id, accountId: q.account_id });
  });

  app.get('/api/insights/cashflow', {
    schema: { tags, summary: 'Income, expenses, net and savings rate per month', querystring: MonthsQuery,
      response: { 200: T.Object({ base_currency: T.String(), months: T.Array(T.Intersect([T.Object({ month: T.String() }), Totals])) }) } },
  }, async (req) => cashflow(db, (req.query as { months: number }).months));

  app.get('/api/insights/category-trends', {
    schema: { tags, summary: 'Spending per category per month (a matrix for spotting trends)', querystring: T.Object({ months: T.Integer({ default: 6, minimum: 1, maximum: 36 }) }),
      response: { 200: T.Object({
        base_currency: T.String(), months: T.Array(T.String()),
        categories: T.Array(T.Object({
          category_id: Nullable(T.Integer()), category: T.String(), essential: T.Boolean(),
          by_month: T.Record(T.String(), T.Number()), total: T.Number(), monthly_average: T.Number(),
        })),
      }) } },
  }, async (req) => categoryTrends(db, (req.query as { months: number }).months));

  app.get('/api/insights/net-worth', {
    schema: { tags, summary: 'Month-end net worth history', description: 'Reconstructed from current balances and transactions, so it only reflects accounts with transaction history.',
      querystring: MonthsQuery, response: { 200: T.Object({ base_currency: T.String(), months: T.Array(T.Object({ month: T.String(), net_worth: T.Number() })) }) } },
  }, async (req) => netWorthHistory(db, (req.query as { months: number }).months));

  app.get('/api/insights/recurring', {
    schema: { tags, summary: 'Recurring payments detected in transactions that are not yet tracked as commitments',
      description: 'Turn one into a tracked commitment with `POST /api/commitments`, passing `suggested_match_pattern` as `match_pattern`.',
      response: { 200: T.Object({ base_currency: T.String(), candidates: T.Array(RecurringCandidate) }) } },
  }, async () => ({
    base_currency: baseCurrency(db),
    candidates: detectRecurring(db).map((c) => ({
      key: c.key, name: c.name, cadence: c.cadence, amount: fromMinor(c.amount_minor), currency: c.currency, amount_type: c.amount_type,
      occurrences: c.occurrences, first_on: c.first_on, last_on: c.last_on, next_expected_on: c.next_expected_on,
      yearly_cost_base: fromMinor(c.yearly_cost_base_minor), suggested_kind: c.suggested_kind,
      category_id: c.category_id, category_name: c.category_name, price_change: Math.round(c.price_change * 1000) / 1000,
      suggested_match_pattern: c.name, transaction_ids: c.transaction_ids,
    })),
  }));

  app.get('/api/insights/savings-opportunities', {
    schema: { tags, summary: 'Heuristic list of places to save money',
      description: 'Rule-based findings: categories running above their own average, blown budgets, price rises, subscription load, renewal windows, bank fees, idle cash. Treat as leads to investigate with the other endpoints, not as advice.',
      response: { 200: T.Object({
        base_currency: T.String(), generated_on: T.String(),
        opportunities: T.Array(T.Object({
          type: T.String(), title: T.String(), detail: T.String(),
          estimated_yearly_saving: Nullable(T.Number()), related: T.Record(T.String(), T.Any()),
        })),
      }) } },
  }, async () => savingsOpportunities(db));
}
