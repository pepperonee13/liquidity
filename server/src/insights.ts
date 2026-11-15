import { baseCurrency, type DB } from './db.js';
import { Fx } from './fx.js';
import { addDays, addMonths, daysBetween, fromMinor, monthRange, today } from './money.js';
import { CADENCES, detectRecurring, merchantKey, yearlyFactor, type Cadence } from './recurring.js';

const SPEND = "flow = 'expense'";
const INCOME = "flow = 'income'";

export function monthTotals(db: DB, from: string, to: string) {
  const row = db
    .prepare(
      `SELECT COALESCE(-SUM(CASE WHEN ${SPEND} THEN amount_base_minor END), 0) AS expenses,
              COALESCE(SUM(CASE WHEN ${INCOME} THEN amount_base_minor END), 0) AS income
       FROM v_tx WHERE booked_on BETWEEN ? AND ?`,
    )
    .get(from, to) as { expenses: number; income: number };
  const net = row.income - row.expenses;
  return {
    income: fromMinor(row.income),
    expenses: fromMinor(row.expenses),
    net: fromMinor(net),
    savings_rate: row.income > 0 ? Math.round((net / row.income) * 1000) / 1000 : null,
  };
}

export function accountsWithBase(db: DB) {
  const fx = new Fx(db);
  const rows = db.prepare('SELECT * FROM accounts WHERE archived = 0 ORDER BY institution, name').all() as any[];
  return rows.map((a) => ({ ...a, balance_base_minor: fx.toBase(a.balance_minor, a.currency) }));
}

export function netWorth(db: DB): number {
  return fromMinor(
    accountsWithBase(db)
      .filter((a) => a.include_in_net_worth)
      .reduce((s, a) => s + a.balance_base_minor, 0),
  );
}

export function spendingByCategory(db: DB, from: string, to: string) {
  return db
    .prepare(
      `SELECT category_id, COALESCE(category_name, 'Uncategorized') AS category,
              COALESCE(category_group, 'Other') AS category_group, MAX(essential) AS essential,
              -SUM(amount_base_minor) AS spent, COUNT(*) AS transactions
       FROM v_tx WHERE ${SPEND} AND booked_on BETWEEN ? AND ?
       GROUP BY category_id ORDER BY spent DESC`,
    )
    .all(from, to) as { category_id: number | null; category: string; category_group: string; essential: number; spent: number; transactions: number }[];
}

export function budgetStatus(db: DB, month: string) {
  const { from, to } = monthRange(month);
  const spent = new Map(spendingByCategory(db, from, to).map((s) => [s.category_id, s.spent]));
  const rows = db
    .prepare(
      `SELECT b.category_id, c.name AS category, c.grp AS category_group, b.amount_minor
       FROM budgets b JOIN categories c ON c.id = b.category_id ORDER BY c.grp, c.name`,
    )
    .all() as { category_id: number; category: string; category_group: string; amount_minor: number }[];
  const now = today();
  const daysInMonth = daysBetween(from, to) + 1;
  const elapsed = now < from ? 0 : now > to ? daysInMonth : daysBetween(from, now) + 1;
  return rows.map((b) => {
    const s = spent.get(b.category_id) ?? 0;
    return {
      category_id: b.category_id,
      category: b.category,
      category_group: b.category_group,
      amount: fromMinor(b.amount_minor),
      spent: fromMinor(s),
      remaining: fromMinor(b.amount_minor - s),
      used_ratio: b.amount_minor > 0 ? Math.round((s / b.amount_minor) * 1000) / 1000 : null,
      /** Linear projection of month-end spending from the pace so far. */
      projected: fromMinor(elapsed > 0 ? Math.round((s / elapsed) * daysInMonth) : 0),
      status: s > b.amount_minor ? 'over' : elapsed > 0 && (s / elapsed) * daysInMonth > b.amount_minor * 1.05 ? 'at_risk' : 'on_track',
    };
  });
}

export function commitmentsView(db: DB, opts: { status?: string; kind?: string } = {}) {
  const fx = new Fx(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) (where.push('c.status = ?'), params.push(opts.status));
  if (opts.kind) (where.push('c.kind = ?'), params.push(opts.kind));
  const rows = db
    .prepare(
      `SELECT c.*, cat.name AS category_name, a.name AS account_name,
              (SELECT MAX(booked_on) FROM transactions t WHERE t.commitment_id = c.id) AS last_paid_on,
              (SELECT COUNT(*) FROM transactions t WHERE t.commitment_id = c.id) AS payments,
              (SELECT -SUM(amount_base_minor) FROM transactions t WHERE t.commitment_id = c.id AND t.booked_on >= date('now', '-12 months')) AS paid_12m
       FROM commitments c
       LEFT JOIN categories cat ON cat.id = c.category_id
       LEFT JOIN accounts a ON a.id = c.account_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (c.status != 'active'), c.kind, c.name`,
    )
    .all(...params) as any[];
  const now = today();
  return rows.map((c) => {
    const base = fx.toBase(c.amount_minor, c.currency);
    const yearly = base * yearlyFactor(c.cadence as Cadence);
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      provider: c.provider,
      amount: fromMinor(c.amount_minor),
      currency: c.currency,
      cadence: c.cadence,
      amount_base: fromMinor(base),
      monthly_cost_base: fromMinor(Math.round(yearly / 12)),
      yearly_cost_base: fromMinor(yearly),
      next_due_on: c.next_due_on,
      days_until_due: c.next_due_on ? daysBetween(now, c.next_due_on) : null,
      start_on: c.start_on,
      end_on: c.end_on,
      cancel_notice_days: c.cancel_notice_days,
      cancel_by: c.end_on && c.cancel_notice_days != null ? addDays(c.end_on, -c.cancel_notice_days) : null,
      policy_number: c.policy_number,
      account_id: c.account_id,
      account_name: c.account_name,
      category_id: c.category_id,
      category_name: c.category_name,
      match_pattern: c.match_pattern,
      status: c.status,
      url: c.url,
      notes: c.notes,
      last_paid_on: c.last_paid_on,
      payments: c.payments,
      paid_last_12_months_base: fromMinor(c.paid_12m ?? 0),
    };
  });
}

export function overview(db: DB, month: string) {
  const { from, to } = monthRange(month);
  const prevMonth = addMonths(from, -1).slice(0, 7);
  const prev = monthRange(prevMonth);
  const accounts = accountsWithBase(db);
  const cats = spendingByCategory(db, from, to);
  const prevCats = new Map(spendingByCategory(db, prev.from, prev.to).map((c) => [c.category_id, c.spent]));
  const budgets = new Map(budgetStatus(db, month).map((b) => [b.category_id, b.amount]));
  const commitments = commitmentsView(db, { status: 'active' });
  const daily = db
    .prepare(`SELECT booked_on AS day, -SUM(amount_base_minor) AS spent FROM v_tx WHERE ${SPEND} AND booked_on BETWEEN ? AND ? GROUP BY booked_on ORDER BY booked_on`)
    .all(from, to) as { day: string; spent: number }[];
  const prevDaily = db
    .prepare(`SELECT booked_on AS day, -SUM(amount_base_minor) AS spent FROM v_tx WHERE ${SPEND} AND booked_on BETWEEN ? AND ? GROUP BY booked_on ORDER BY booked_on`)
    .all(prev.from, prev.to) as { day: string; spent: number }[];
  const uncategorized = db
    .prepare("SELECT COUNT(*) n FROM transactions WHERE category_id IS NULL AND booked_on BETWEEN ? AND ?")
    .get(from, to) as { n: number };
  return {
    base_currency: baseCurrency(db),
    month,
    net_worth: fromMinor(accounts.filter((a) => a.include_in_net_worth).reduce((s, a) => s + a.balance_base_minor, 0)),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      currency: a.currency,
      balance: fromMinor(a.balance_minor),
      balance_base: fromMinor(a.balance_base_minor),
    })),
    totals: monthTotals(db, from, to),
    previous_month_totals: monthTotals(db, prev.from, prev.to),
    categories: cats.map((c) => ({
      category_id: c.category_id,
      category: c.category,
      category_group: c.category_group,
      spent: fromMinor(c.spent),
      previous_month_spent: fromMinor(prevCats.get(c.category_id) ?? 0),
      budget: budgets.get(c.category_id as number) ?? null,
      transactions: c.transactions,
    })),
    daily_spending: daily.map((d) => ({ day: d.day, spent: fromMinor(d.spent) })),
    previous_month_daily_spending: prevDaily.map((d) => ({ day: d.day, spent: fromMinor(d.spent) })),
    uncategorized_transactions: uncategorized.n,
    commitments_monthly_total: Math.round(commitments.reduce((s, c) => s + c.monthly_cost_base, 0) * 100) / 100,
    upcoming_commitments: commitments
      .filter((c) => c.days_until_due !== null && c.days_until_due >= -3 && c.days_until_due <= 30)
      .sort((a, b) => (a.days_until_due ?? 0) - (b.days_until_due ?? 0))
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind, amount: c.amount, currency: c.currency, amount_base: c.amount_base, next_due_on: c.next_due_on, days_until_due: c.days_until_due })),
  };
}

export type SpendingGroup = 'category' | 'group' | 'counterparty' | 'month' | 'account';

export function spending(db: DB, opts: { from: string; to: string; groupBy: SpendingGroup; categoryId?: number; accountId?: number }) {
  const where = [SPEND, 'booked_on BETWEEN ? AND ?'];
  const params: unknown[] = [opts.from, opts.to];
  if (opts.categoryId) (where.push('category_id = ?'), params.push(opts.categoryId));
  if (opts.accountId) (where.push('account_id = ?'), params.push(opts.accountId));
  let rows: { key: string; label: string; spent: number; transactions: number }[];
  if (opts.groupBy === 'counterparty') {
    const txs = db
      .prepare(`SELECT counterparty, description, amount_base_minor FROM v_tx WHERE ${where.join(' AND ')}`)
      .all(...params) as { counterparty: string; description: string; amount_base_minor: number }[];
    const map = new Map<string, { key: string; label: string; spent: number; transactions: number }>();
    for (const t of txs) {
      const key = merchantKey(t.counterparty, t.description) || '(unknown)';
      const entry = map.get(key) ?? { key, label: t.counterparty || t.description || '(unknown)', spent: 0, transactions: 0 };
      entry.spent -= t.amount_base_minor;
      entry.transactions++;
      map.set(key, entry);
    }
    rows = [...map.values()];
  } else {
    const expr = {
      category: ["COALESCE(CAST(category_id AS TEXT), 'none')", "COALESCE(category_name, 'Uncategorized')"],
      group: ["COALESCE(category_group, 'Other')", "COALESCE(category_group, 'Other')"],
      month: ['substr(booked_on, 1, 7)', 'substr(booked_on, 1, 7)'],
      account: ['CAST(account_id AS TEXT)', 'account_name'],
    }[opts.groupBy];
    rows = db
      .prepare(
        `SELECT ${expr[0]} AS key, ${expr[1]} AS label, -SUM(amount_base_minor) AS spent, COUNT(*) AS transactions
         FROM v_tx WHERE ${where.join(' AND ')} GROUP BY 1`,
      )
      .all(...params) as typeof rows;
  }
  const total = rows.reduce((s, r) => s + r.spent, 0);
  if (opts.groupBy === 'month') rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.spent - a.spent);
  return {
    base_currency: baseCurrency(db),
    from: opts.from,
    to: opts.to,
    group_by: opts.groupBy,
    total: fromMinor(total),
    rows: rows.map((r) => ({
      key: r.key,
      label: r.label,
      spent: fromMinor(r.spent),
      transactions: r.transactions,
      share: total > 0 ? Math.round((r.spent / total) * 1000) / 1000 : 0,
    })),
  };
}

function lastMonths(n: number, endMonth = today().slice(0, 7)): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(`${endMonth}-01`, -i).slice(0, 7));
  return out;
}

export function cashflow(db: DB, months: number) {
  return {
    base_currency: baseCurrency(db),
    months: lastMonths(months).map((m) => {
      const { from, to } = monthRange(m);
      return { month: m, ...monthTotals(db, from, to) };
    }),
  };
}

export function categoryTrends(db: DB, months: number) {
  const list = lastMonths(months);
  const rows = db
    .prepare(
      `SELECT category_id, COALESCE(category_name, 'Uncategorized') AS category, MAX(essential) AS essential,
              substr(booked_on, 1, 7) AS month, -SUM(amount_base_minor) AS spent
       FROM v_tx WHERE ${SPEND} AND booked_on >= ? GROUP BY category_id, month`,
    )
    .all(`${list[0]}-01`) as { category_id: number | null; category: string; essential: number; month: string; spent: number }[];
  const map = new Map<number | null, { category_id: number | null; category: string; essential: boolean; by_month: Record<string, number> }>();
  for (const r of rows) {
    const e = map.get(r.category_id) ?? { category_id: r.category_id, category: r.category, essential: Boolean(r.essential), by_month: {} };
    e.by_month[r.month] = fromMinor(r.spent);
    map.set(r.category_id, e);
  }
  return {
    base_currency: baseCurrency(db),
    months: list,
    categories: [...map.values()]
      .map((c) => {
        const values = list.map((m) => c.by_month[m] ?? 0);
        return {
          ...c,
          by_month: Object.fromEntries(list.map((m, i) => [m, values[i]])),
          total: Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100,
          monthly_average: Math.round((values.reduce((s, v) => s + v, 0) / list.length) * 100) / 100,
        };
      })
      .sort((a, b) => b.total - a.total),
  };
}

/** Month-end net worth, reconstructed by rolling current balances back through the transactions. */
export function netWorthHistory(db: DB, months: number) {
  const list = lastMonths(months);
  const current = accountsWithBase(db)
    .filter((a) => a.include_in_net_worth)
    .reduce((s, a) => s + a.balance_base_minor, 0);
  const after = db.prepare(
    `SELECT COALESCE(SUM(t.amount_base_minor), 0) AS s FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.archived = 0 AND a.include_in_net_worth = 1 AND t.booked_on > ?`,
  );
  return {
    base_currency: baseCurrency(db),
    months: list.map((m) => {
      const end = monthRange(m).to;
      const later = (after.get(end) as { s: number }).s;
      return { month: m, net_worth: fromMinor(current - later) };
    }),
  };
}

export interface Opportunity {
  type: string;
  title: string;
  detail: string;
  /** Rough yearly saving in base currency if acted on; null when it cannot be estimated. */
  estimated_yearly_saving: number | null;
  related: Record<string, unknown>;
}

export function savingsOpportunities(db: DB): { base_currency: string; generated_on: string; opportunities: Opportunity[] } {
  const base = baseCurrency(db);
  const now = today();
  const out: Opportunity[] = [];
  const money = (n: number) => `${Math.round(n).toLocaleString('en-US')} ${base}`;

  const thisMonth = now.slice(0, 7);
  const complete = lastMonths(4, addMonths(`${thisMonth}-01`, -1).slice(0, 7)); // 4 complete months
  const latest = complete[3];
  const trends = categoryTrends(db, 5).categories;
  const monthlyExpenses = complete.slice(0, 3).map((m) => monthTotals(db, monthRange(m).from, monthRange(m).to).expenses);
  const avgExpenses = monthlyExpenses.reduce((s, v) => s + v, 0) / 3;

  // 1. Categories running hot compared with their own recent average.
  for (const c of trends) {
    const baseline = complete.slice(0, 3).reduce((s, m) => s + (c.by_month[m] ?? 0), 0) / 3;
    const last = c.by_month[latest] ?? 0;
    if (baseline > 0 && last > baseline * 1.25 && last - baseline > Math.max(avgExpenses * 0.01, 1)) {
      out.push({
        type: 'category_spike',
        title: `${c.category} spending is up ${Math.round((last / baseline - 1) * 100)}%`,
        detail: `${money(last)} in ${latest} versus a ${money(baseline)} average over the three months before.`,
        estimated_yearly_saving: c.essential ? null : Math.round((last - baseline) * 12),
        related: { category_id: c.category_id, month: latest, baseline_monthly: Math.round(baseline), latest_monthly: last },
      });
    }
  }

  // 2. Budgets that are blown or on course to be.
  for (const b of budgetStatus(db, thisMonth)) {
    if (b.status === 'on_track') continue;
    out.push({
      type: b.status === 'over' ? 'over_budget' : 'budget_at_risk',
      title: b.status === 'over' ? `${b.category} is over budget` : `${b.category} is on pace to exceed its budget`,
      detail: `${money(b.spent)} spent of ${money(b.amount)} this month; projected ${money(b.projected)} by month end.`,
      estimated_yearly_saving: null,
      related: { category_id: b.category_id, month: thisMonth },
    });
  }

  // 3. Recurring payments nobody is tracking yet, and price rises on any recurring payment.
  const recurring = detectRecurring(db, now);
  for (const r of recurring) {
    if (r.amount_type === 'fixed' && r.price_change >= 1.05) {
      const yearlyBefore = r.yearly_cost_base_minor / r.price_change;
      out.push({
        type: 'price_increase',
        title: `${r.name} got ${Math.round((r.price_change - 1) * 100)}% more expensive`,
        detail: `Now ${fromMinor(r.amount_minor)} ${r.currency} ${r.cadence}. Worth checking for a cheaper plan or a competitor.`,
        estimated_yearly_saving: fromMinor(Math.round(r.yearly_cost_base_minor - yearlyBefore)),
        related: { recurring_key: r.key, transaction_ids: r.transaction_ids.slice(-3) },
      });
    }
  }
  if (recurring.length > 0) {
    const total = recurring.reduce((s, r) => s + r.yearly_cost_base_minor, 0);
    out.push({
      type: 'untracked_recurring',
      title: `${recurring.length} recurring payment${recurring.length === 1 ? '' : 's'} not tracked yet`,
      detail: `Together about ${money(fromMinor(total))} a year. Review them in Recurring and cancel what you no longer use.`,
      estimated_yearly_saving: null,
      related: { recurring_keys: recurring.map((r) => r.key) },
    });
  }

  // 4. Subscription load.
  const commitments = commitmentsView(db, { status: 'active' });
  const subs = [
    ...commitments.filter((c) => c.kind === 'subscription').map((c) => ({ name: c.name, yearly: c.yearly_cost_base })),
    ...recurring.filter((r) => r.suggested_kind === 'subscription').map((r) => ({ name: r.name, yearly: fromMinor(r.yearly_cost_base_minor) })),
  ];
  if (subs.length >= 3) {
    const total = subs.reduce((s, x) => s + x.yearly, 0);
    out.push({
      type: 'subscription_load',
      title: `${subs.length} subscriptions cost about ${money(total)} a year`,
      detail: `Largest: ${[...subs].sort((a, b) => b.yearly - a.yearly).slice(0, 4).map((s) => `${s.name} (${money(s.yearly)})`).join(', ')}. Dropping overlapping services is usually the quickest saving.`,
      estimated_yearly_saving: null,
      related: { subscriptions: subs },
    });
  }

  // 5. Contracts coming up for renewal: the moment to renegotiate or switch.
  for (const c of commitments) {
    const deadline = c.cancel_by ?? c.end_on;
    if (!deadline) continue;
    const days = daysBetween(now, deadline);
    if (days < 0 || days > 60) continue;
    out.push({
      type: 'renewal_window',
      title: `${c.name}: ${c.cancel_by ? 'cancellation deadline' : 'renewal'} in ${days} day${days === 1 ? '' : 's'}`,
      detail: `${c.kind === 'insurance' ? 'Insurance' : 'Contract'} costing ${money(c.yearly_cost_base)} a year ${c.cancel_by ? `must be cancelled by ${c.cancel_by}` : `renews on ${c.end_on}`}. Compare offers before it rolls over.`,
      estimated_yearly_saving: null,
      related: { commitment_id: c.id },
    });
  }

  // 6. Bank fees and interest.
  const fees = db
    .prepare(
      `SELECT -SUM(amount_base_minor) AS spent, COUNT(*) AS n FROM v_tx
       WHERE ${SPEND} AND category_name = 'Bank fees & interest' AND booked_on >= ?`,
    )
    .get(addMonths(now, -12)) as { spent: number | null; n: number };
  if ((fees.spent ?? 0) > 0) {
    out.push({
      type: 'bank_fees',
      title: `${money(fromMinor(fees.spent!))} in bank fees over the last 12 months`,
      detail: `${fees.n} fee transactions. A cheaper account package or consolidating accounts could remove most of this.`,
      estimated_yearly_saving: fromMinor(Math.round(fees.spent! * 0.5)),
      related: { category: 'Bank fees & interest' },
    });
  }

  // 7. Biggest discretionary categories: what a 15 % trim would be worth.
  const discretionary = trends
    .filter((c) => !c.essential && c.category_id !== null)
    .map((c) => ({ ...c, avg: complete.slice(1).reduce((s, m) => s + (c.by_month[m] ?? 0), 0) / 3 }))
    .filter((c) => c.avg > avgExpenses * 0.04)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);
  for (const c of discretionary) {
    out.push({
      type: 'discretionary_trim',
      title: `${c.category} averages ${money(c.avg)} a month`,
      detail: `One of your largest non-essential categories over the last three months. Trimming it by 15% would free up ${money(c.avg * 0.15)} a month.`,
      estimated_yearly_saving: Math.round(c.avg * 0.15 * 12),
      related: { category_id: c.category_id },
    });
  }

  // 8. Cash sitting idle in current accounts.
  const checking = accountsWithBase(db).filter((a) => a.type === 'checking').reduce((s, a) => s + a.balance_base_minor, 0);
  if (avgExpenses > 0 && fromMinor(checking) > avgExpenses * 3) {
    const excess = fromMinor(checking) - avgExpenses * 2;
    out.push({
      type: 'idle_cash',
      title: `${money(excess)} more than two months of expenses sits in current accounts`,
      detail: 'Current accounts pay little or no interest. Moving the surplus to savings or government bonds would put it to work.',
      estimated_yearly_saving: null,
      related: { checking_balance: fromMinor(checking), average_monthly_expenses: Math.round(avgExpenses) },
    });
  }

  // 9. Data quality: uncategorised spending hides patterns.
  const unc = db
    .prepare(`SELECT COUNT(*) n, COALESCE(-SUM(amount_base_minor), 0) spent FROM v_tx WHERE ${SPEND} AND category_id IS NULL AND booked_on >= ?`)
    .get(addMonths(now, -3)) as { n: number; spent: number };
  const total3 = monthTotals(db, addMonths(now, -3), now).expenses;
  if (unc.n > 0 && total3 > 0 && fromMinor(unc.spent) / total3 > 0.1) {
    out.push({
      type: 'uncategorized',
      title: `${Math.round((fromMinor(unc.spent) / total3) * 100)}% of recent spending is uncategorised`,
      detail: `${unc.n} transactions worth ${money(fromMinor(unc.spent))} in the last three months have no category. Categorise them (or add rules) for sharper insights.`,
      estimated_yearly_saving: null,
      related: { query: '/api/transactions?uncategorized=true' },
    });
  }

  out.sort((a, b) => (b.estimated_yearly_saving ?? -1) - (a.estimated_yearly_saving ?? -1));
  return { base_currency: base, generated_on: now, opportunities: out };
}

export { CADENCES };
