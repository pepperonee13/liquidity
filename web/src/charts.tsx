import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from './ui';

export interface Series {
  key: string;
  label: string;
  color: string;
}

const axis = { stroke: 'var(--axis)', tick: { fill: 'var(--muted)', fontSize: 12 }, tickLine: false } as const;

function Tip({ active, payload, label, series, currency, title }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <b>{title ? title(label) : label}</b>
      {(series as Series[]).map((s) => {
        const p = payload.find((x: any) => x.dataKey === s.key);
        if (!p || p.value == null) return null;
        return (
          <div key={s.key}>
            <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}</span>
            <span>{money(p.value, currency)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ series, line }: { series: Series[]; line?: boolean }) {
  return (
    <div className="legend">
      {series.map((s) => <span key={s.key}><i className={line ? 'line' : ''} style={{ background: s.color }} />{s.label}</span>)}
    </div>
  );
}

const compact = (currency: string) => (v: number) => money(v, currency, { compact: true });

export function Bars({ data, x, series, currency, xFormat }: {
  data: object[]; x: string; series: Series[]; currency: string; xFormat?: (v: string) => string;
}) {
  return (
    <div className="chart">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={x} {...axis} tickFormatter={xFormat} />
          <YAxis {...axis} axisLine={false} width={80} tickFormatter={compact(currency)} />
          <Tooltip cursor={{ fill: 'var(--wash)' }} content={<Tip series={series} currency={currency} title={xFormat} />} />
          {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Lines({ data, x, series, currency, xFormat, zeroBased = true }: {
  data: object[]; x: string; series: Series[]; currency: string; xFormat?: (v: string) => string; zeroBased?: boolean;
}) {
  return (
    <div className="chart">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={x} {...axis} tickFormatter={xFormat} minTickGap={24} />
          <YAxis {...axis} axisLine={false} width={80} tickFormatter={compact(currency)} domain={zeroBased ? [0, 'auto'] : ['auto', 'auto']} />
          <Tooltip cursor={{ stroke: 'var(--axis)' }} content={<Tip series={series} currency={currency} title={xFormat} />} />
          {series.map((s) => (
            <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
