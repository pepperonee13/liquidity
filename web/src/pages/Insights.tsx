import { useQuery } from '@tanstack/react-query';
import { api, type Opportunity, type Totals } from '../api';
import { Bars, Legend, Lines } from '../charts';
import { Card, Empty, fmtMonth, money, PageHeader, pct } from '../ui';
import { OpportunityRow } from './Dashboard';

interface Trends {
  base_currency: string; months: string[];
  categories: { category_id: number | null; category: string; essential: boolean; by_month: Record<string, number>; monthly_average: number }[];
}

export function Insights() {
  const flow = useQuery({ queryKey: ['cashflow'], queryFn: () => api<{ base_currency: string; months: (Totals & { month: string })[] }>('/insights/cashflow?months=12') }).data;
  const worth = useQuery({ queryKey: ['networth'], queryFn: () => api<{ months: { month: string; net_worth: number }[] }>('/insights/net-worth?months=12') }).data;
  const trends = useQuery({ queryKey: ['trends', 6], queryFn: () => api<Trends>('/insights/category-trends?months=6') }).data;
  const opps = useQuery({ queryKey: ['opportunities'], queryFn: () => api<{ opportunities: Opportunity[] }>('/insights/savings-opportunities') }).data;
  const cur = flow?.base_currency ?? 'HUF';
  const short = (m: string) => fmtMonth(m, false);
  const flowSeries = [
    { key: 'income', label: 'Income', color: 'var(--series-1)' },
    { key: 'expenses', label: 'Spending', color: 'var(--series-2)' },
  ];
  const complete = flow?.months.slice(0, -1).filter((m) => m.income > 0 || m.expenses > 0) ?? [];
  const avgRate = complete.length ? complete.reduce((s, m) => s + m.net, 0) / Math.max(1, complete.reduce((s, m) => s + m.income, 0)) : null;
  const totalSaving = opps?.opportunities.reduce((s, o) => s + (o.estimated_yearly_saving ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader title="Insights" />
      <div className="grid cols-2">
        <Card className="span-2" title={`Ways to save${totalSaving ? ` · up to ${money(totalSaving, cur)} a year` : ''}`}>
          {!opps?.opportunities.length ? <Empty>Nothing stands out right now. Findings appear once there are a few months of transactions.</Empty>
            : opps.opportunities.map((o, i) => <OpportunityRow key={i} o={o} currency={cur} />)}
          <p className="muted" style={{ fontSize: '0.83rem', marginTop: 8 }}>Rule-based findings from your own data. Estimates are rough and are not financial advice.</p>
        </Card>

        <Card title="Income and spending" action={<Legend series={flowSeries} />}>
          <Bars data={flow?.months ?? []} x="month" series={flowSeries} currency={cur} xFormat={short} />
          <p className="muted" style={{ fontSize: '0.87rem', marginTop: 8 }}>Average savings rate over complete months: {pct(avgRate)}. Transfers between your own accounts are left out.</p>
        </Card>
        <Card title="Net worth">
          <Lines data={worth?.months ?? []} x="month" series={[{ key: 'net_worth', label: 'Net worth', color: 'var(--series-1)' }]} currency={cur} xFormat={short} zeroBased={false} />
          <p className="muted" style={{ fontSize: '0.87rem', marginTop: 8 }}>Month-end values, rebuilt from today’s balances and your transaction history.</p>
        </Card>

        <Card className="span-2" title="Spending by category, last six months">
          {!trends?.categories.length ? <Empty>No spending yet.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Category</th>{trends.months.map((m) => <th key={m} className="r">{short(m)}</th>)}<th className="r">Average</th></tr>
                </thead>
                <tbody>
                  {trends.categories.map((c) => (
                    <tr key={c.category_id ?? 0}>
                      <td>{c.category}{!c.essential && c.category_id !== null && <span className="sub">discretionary</span>}</td>
                      {trends.months.map((m) => <td key={m} className="r num">{c.by_month[m] ? money(c.by_month[m], cur, { compact: true }) : <span className="muted">–</span>}</td>)}
                      <td className="r num"><strong>{money(c.monthly_average, cur, { compact: true })}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
