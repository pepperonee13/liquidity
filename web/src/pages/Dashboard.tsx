import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Opportunity, type Overview } from '../api';
import { Legend, Lines } from '../charts';
import { Card, Empty, fmtDay, Money, money, monthEnd, MonthPicker, PageHeader, pct, thisMonth } from '../ui';

function cumulative(o: Overview) {
  const days = Number(monthEnd(o.month).slice(8));
  const cur = new Map(o.daily_spending.map((d) => [Number(d.day.slice(8)), d.spent]));
  const prev = new Map(o.previous_month_daily_spending.map((d) => [Number(d.day.slice(8)), d.spent]));
  const lastDay = o.month === thisMonth() ? new Date().getDate() : 31;
  const rows: Record<string, unknown>[] = [];
  let a = 0;
  let b = 0;
  for (let d = 1; d <= 31; d++) {
    a += cur.get(d) ?? 0;
    b += prev.get(d) ?? 0;
    if (d > days && !prev.has(d)) continue;
    rows.push({ day: String(d), current: d <= Math.min(lastDay, days) ? Math.round(a) : null, previous: Math.round(b) });
  }
  return rows;
}

function Delta({ now, before, goodWhenUp }: { now: number; before: number; goodWhenUp: boolean }) {
  if (!before) return <div className="delta">no data last month</div>;
  const change = now / before - 1;
  const up = change >= 0;
  return (
    <div className="delta">
      <span className={up === goodWhenUp ? 'pos' : ''}>{up ? '▲' : '▼'} {Math.abs(Math.round(change * 100))}%</span> vs last month
    </div>
  );
}

export function Dashboard() {
  const [month, setMonth] = useState(thisMonth());
  const { data: o, isLoading } = useQuery({ queryKey: ['overview', month], queryFn: () => api<Overview>(`/insights/overview?month=${month}`) });
  const opps = useQuery({ queryKey: ['opportunities'], queryFn: () => api<{ opportunities: Opportunity[] }>('/insights/savings-opportunities') });

  if (isLoading || !o) return <PageHeader title="Dashboard" />;
  const cur = o.base_currency;
  if (o.accounts.length === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <div className="stack" style={{ alignItems: 'flex-start' }}>
            <h2>Connect your first account</h2>
            <p className="muted">Link a bank to sync balances and transactions automatically, import a CSV statement, or try the app with the demo bank.</p>
            <Link className="btn primary" to="/accounts">Go to accounts</Link>
          </div>
        </Card>
      </>
    );
  }
  const maxSpent = Math.max(1, ...o.categories.map((c) => Math.max(c.spent, c.budget ?? 0)));
  const series = [
    { key: 'current', label: 'This month', color: 'var(--series-1)' },
    { key: 'previous', label: 'Previous month', color: 'var(--deemph)' },
  ];

  return (
    <>
      <PageHeader title="Dashboard">
        <MonthPicker month={month} onChange={setMonth} />
      </PageHeader>
      <div className="grid cols-4">
        <Card className="span-2 stat hero">
          <div className="label">Net worth</div>
          <div className="value">{money(o.net_worth, cur)}</div>
          <div className="delta">across {o.accounts.length} accounts · <Link to="/insights">history</Link></div>
        </Card>
        <Card className="stat">
          <div className="label">Income</div>
          <div className="value">{money(o.totals.income, cur)}</div>
          <Delta now={o.totals.income} before={o.previous_month_totals.income} goodWhenUp />
        </Card>
        <Card className="stat">
          <div className="label">Spending</div>
          <div className="value">{money(o.totals.expenses, cur)}</div>
          <Delta now={o.totals.expenses} before={o.previous_month_totals.expenses} goodWhenUp={false} />
        </Card>

        <div className="span-2 stack">
        <Card title="Spending so far" action={<Legend series={series} line />}>
          <Lines data={cumulative(o)} x="day" series={series} currency={cur} xFormat={(d) => `Day ${d}`} />
        </Card>
        <Card title="Spending by category"
          action={o.uncategorized_transactions > 0 ? <Link to={`/transactions?month=${month}&uncategorized=1`}>{o.uncategorized_transactions} uncategorised</Link> : undefined}>
          {o.categories.length === 0 ? <Empty>No spending recorded this month.</Empty> : (
            <div className="bars">
              {o.categories.slice(0, 10).map((c) => (
                <Link key={c.category_id ?? 0} className="bar-row" to={`/transactions?month=${month}&${c.category_id ? `category_id=${c.category_id}` : 'uncategorized=1'}`}
                  title={`${c.category}: ${money(c.spent, cur)}${c.budget ? ` of ${money(c.budget, cur)} budget` : ''} · last month ${money(c.previous_month_spent, cur)}`}>
                  <span className="name">{c.category}</span>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${(Math.max(c.spent, 0) / maxSpent) * 100}%` }} />
                    {c.budget ? <span className="bar-mark" style={{ left: `${(c.budget / maxSpent) * 100}%` }} /> : null}
                  </span>
                  <Money value={c.spent} currency={cur} />
                </Link>
              ))}
            </div>
          )}
          {o.categories.some((c) => c.budget) && <p className="muted" style={{ marginTop: 10, fontSize: '0.83rem' }}>The vertical mark shows the monthly budget.</p>}
        </Card>

        {opps.data && opps.data.opportunities.length > 0 && (
          <Card title="Ways to save" action={<Link to="/insights">See all {opps.data.opportunities.length}</Link>} >
            {opps.data.opportunities.slice(0, 3).map((x, i) => <OpportunityRow key={i} o={x} currency={cur} />)}
          </Card>
        )}
        </div>
        <div className="span-2 stack">
          <div className="grid cols-2 keep">
        <Card className="stat">
          <div className="label">Saved this month</div>
          <div className="value">{money(o.totals.net, cur)}</div>
          <div className="delta">savings rate {pct(o.totals.savings_rate)}</div>
        </Card>
        <Card className="stat">
          <div className="label">Fixed commitments</div>
          <div className="value">{money(o.commitments_monthly_total, cur)}</div>
          <div className="delta">per month · <Link to="/recurring">manage</Link></div>
        </Card>

          </div>
          <Card title="Accounts" action={<Link to="/accounts">All accounts</Link>}>
            <div className="list">
              {o.accounts.map((a) => (
                <div key={a.id}>
                  <div className="grow"><div>{a.name}</div><small>{a.institution || a.type}</small></div>
                  <div style={{ textAlign: 'right' }}>
                    <Money value={a.balance} currency={a.currency} />
                    {a.currency !== cur && <small style={{ display: 'block' }}>≈ {money(a.balance_base, cur)}</small>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Due in the next 30 days" action={<Link to="/recurring">Recurring</Link>}>
            {o.upcoming_commitments.length === 0 ? <Empty>Nothing tracked is due soon.</Empty> : (
              <div className="list">
                {o.upcoming_commitments.slice(0, 6).map((c) => (
                  <div key={c.id}>
                    <div className="grow"><div>{c.name}</div><small>{fmtDay(c.next_due_on)} · {c.days_until_due! < 0 ? 'overdue' : c.days_until_due === 0 ? 'today' : `in ${c.days_until_due} days`}</small></div>
                    <Money value={c.amount} currency={c.currency} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export function OpportunityRow({ o, currency }: { o: Opportunity; currency: string }) {
  return (
    <div className="opp">
      <div className="row between">
        <strong>{o.title}</strong>
        {o.estimated_yearly_saving ? <span className="pill good">up to {money(o.estimated_yearly_saving, currency)} / year</span> : null}
      </div>
      <p>{o.detail}</p>
    </div>
  );
}
