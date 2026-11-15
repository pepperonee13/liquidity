import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { api, type Category } from './api';

export function useBaseCurrency(): string {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<{ base_currency: string }>('/settings'), staleTime: 60_000 }).data?.base_currency ?? 'HUF';
}

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/categories') }).data ?? [];
}

const formatters = new Map<string, Intl.NumberFormat>();
export function money(value: number, currency: string, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const whole = currency === 'HUF' || opts.compact || Math.abs(value) >= 100_000;
  const key = `${currency}|${whole}|${opts.compact}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: 'currency', currency, maximumFractionDigits: opts.compact ? 1 : whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2,
        notation: opts.compact ? 'compact' : 'standard',
      });
    } catch {
      f = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    }
    formatters.set(key, f);
  }
  const s = f.format(value);
  return opts.sign && value > 0 ? `+${s}` : s;
}

export function Money({ value, currency, sign }: { value: number; currency: string; sign?: boolean }) {
  return <span className={`num${sign && value > 0 ? ' pos' : ''}`}>{money(value, currency, { sign })}</span>;
}

export const pct = (ratio: number | null) => (ratio === null ? '–' : `${Math.round(ratio * 100)}%`);

export function fmtDay(day: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  if (!day) return '–';
  return new Date(`${day.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, opts);
}
export function fmtMonth(month: string, long = true): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short' });
}
export function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}
export function todayIso(): string {
  const d = new Date();
  return `${thisMonth()}-${String(d.getDate()).padStart(2, '0')}`;
}

export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="month-picker">
      <button className="btn ghost icon" aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}>‹</button>
      <span>{fmtMonth(month)}</span>
      <button className="btn ghost icon" aria-label="Next month" disabled={month >= thisMonth()} onClick={() => onChange(shiftMonth(month, 1))}>›</button>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <div className="actions">{children}</div>
    </header>
  );
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="note error" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}

export function CategorySelect({ value, onChange, categories, allowNone = true, kinds, ...rest }: {
  value: number | null; onChange: (id: number | null) => void; categories: Category[]; allowNone?: boolean;
  kinds?: Category['kind'][]; 'aria-label'?: string; className?: string;
}) {
  const list = kinds ? categories.filter((c) => kinds.includes(c.kind)) : categories;
  const groups = new Map<string, Category[]>();
  for (const c of list) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  return (
    <select {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowNone && <option value="">Uncategorised</option>}
      {[...groups].map(([group, cats]) => (
        <optgroup key={group} label={group}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const icon = { neutral: '', good: '✓ ', warn: '! ', bad: '✕ ' }[tone];
  return <span className={`pill ${tone}`}>{icon}{children}</span>;
}
