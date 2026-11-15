import type { DB } from './db.js';
import { addDays, addMonths, daysBetween, normalize, today } from './money.js';

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

export const CADENCES: Record<Cadence, { days: number; tolerance: number; perYear: number; minCount: number }> = {
  weekly: { days: 7, tolerance: 2, perYear: 52, minCount: 4 },
  monthly: { days: 30.4, tolerance: 5, perYear: 12, minCount: 3 },
  quarterly: { days: 91.3, tolerance: 12, perYear: 4, minCount: 3 },
  semiannual: { days: 182.6, tolerance: 18, perYear: 2, minCount: 2 },
  yearly: { days: 365.25, tolerance: 25, perYear: 1, minCount: 2 },
};

export function advance(day: string, cadence: Cadence): string {
  switch (cadence) {
    case 'weekly': return addDays(day, 7);
    case 'monthly': return addMonths(day, 1);
    case 'quarterly': return addMonths(day, 3);
    case 'semiannual': return addMonths(day, 6);
    case 'yearly': return addMonths(day, 12);
  }
}

export function yearlyFactor(cadence: Cadence): number {
  return CADENCES[cadence].perYear;
}

const NOISE = new Set(['kft', 'zrt', 'nyrt', 'bt', 'ltd', 'inc', 'gmbh', 'ab', 'hu', 'com', 'budapest', 'hungary', 'magyarorszag', 'www']);

/** Reduce a counterparty / description to a key that groups payments to the same merchant. */
export function merchantKey(counterparty: string, description: string): string {
  const source = normalize(counterparty) || normalize(description);
  const words = source
    .replace(/[^a-z ]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !NOISE.has(w));
  return words.slice(0, 2).join(' ');
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Occurrence {
  id: number;
  booked_on: string;
  amount_minor: number;
  amount_base_minor: number;
  currency: string;
  counterparty: string;
  description: string;
  category_id: number | null;
  category_name: string | null;
}

export interface RecurringCandidate {
  key: string;
  name: string;
  cadence: Cadence;
  amount_minor: number;
  currency: string;
  amount_type: 'fixed' | 'variable';
  occurrences: number;
  first_on: string;
  last_on: string;
  next_expected_on: string;
  yearly_cost_base_minor: number;
  suggested_kind: string;
  category_id: number | null;
  category_name: string | null;
  /** Latest amount vs. the earliest amount in the series, as a ratio (1.1 = +10 %). */
  price_change: number;
  transaction_ids: number[];
}

function analyse(key: string, items: Occurrence[], asOf: string): RecurringCandidate | null {
  if (items.length < 2) return null;
  const sorted = [...items].sort((a, b) => a.booked_on.localeCompare(b.booked_on));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].booked_on, sorted[i].booked_on));
  const med = median(gaps);
  const cadence = (Object.keys(CADENCES) as Cadence[]).find((c) => Math.abs(med - CADENCES[c].days) <= CADENCES[c].tolerance);
  if (!cadence) return null;
  const spec = CADENCES[cadence];
  if (sorted.length < spec.minCount) return null;
  const regular = gaps.filter((g) => Math.abs(g - spec.days) <= spec.tolerance).length / gaps.length;
  if (regular < 0.7) return null;

  const amounts = sorted.map((s) => Math.abs(s.amount_minor));
  const medAmount = median(amounts);
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  if (lo <= 0 || hi / lo > 3) return null;
  const last = sorted[sorted.length - 1];
  // Stopped paying a while ago? Then it is no longer a live commitment.
  if (daysBetween(last.booked_on, asOf) > spec.days * 1.6 + spec.tolerance) return null;

  // A fixed price either barely moves, or steps between a few price points (a plan that got dearer).
  const fixed =
    amounts.filter((a) => Math.abs(a - medAmount) <= medAmount * 0.12).length / amounts.length >= 0.8 ||
    (amounts.length >= 4 && new Set(amounts).size <= 3);
  const category = last.category_name ?? '';
  const kind =
    /insurance/i.test(category) ? 'insurance'
    : /utilities|phone/i.test(category) ? 'utility'
    : /loan/i.test(category) ? 'loan'
    : /housing|rent/i.test(category) ? 'rent'
    : /fitness/i.test(category) ? 'membership'
    : /tax/i.test(category) ? 'tax'
    : fixed && (!category || /subscription|entertainment|education/i.test(category)) ? 'subscription' : 'other';
  const recent = sorted.slice(-3);
  const typical = fixed ? Math.abs(last.amount_minor) : Math.round(median(recent.map((r) => Math.abs(r.amount_minor))));
  const typicalBase = fixed
    ? Math.abs(last.amount_base_minor)
    : Math.round(median(recent.map((r) => Math.abs(r.amount_base_minor))));
  return {
    key,
    name: last.counterparty || last.description || key,
    cadence,
    amount_minor: typical,
    currency: last.currency,
    amount_type: fixed ? 'fixed' : 'variable',
    occurrences: sorted.length,
    first_on: sorted[0].booked_on,
    last_on: last.booked_on,
    next_expected_on: advance(last.booked_on, cadence),
    yearly_cost_base_minor: Math.round(typicalBase * spec.perYear),
    suggested_kind: kind,
    category_id: last.category_id,
    category_name: last.category_name,
    price_change: Math.abs(last.amount_minor) / Math.abs(sorted[0].amount_minor),
    transaction_ids: sorted.map((s) => s.id),
  };
}

/** Find repeating outgoing payments that are not yet tracked as a commitment. */
export function detectRecurring(db: DB, asOf: string = today()): RecurringCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, booked_on, amount_minor, amount_base_minor, currency, counterparty, description, category_id, category_name
       FROM v_tx
       WHERE amount_minor < 0 AND flow = 'expense' AND commitment_id IS NULL AND status = 'booked'
         AND booked_on >= ?`,
    )
    .all(addMonths(asOf, -26)) as Occurrence[];
  const groups = new Map<string, Occurrence[]>();
  for (const r of rows) {
    const key = merchantKey(r.counterparty, r.description);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const out: RecurringCandidate[] = [];
  for (const [key, items] of groups) {
    const whole = analyse(key, items, asOf);
    if (whole) {
      out.push(whole);
      continue;
    }
    // One merchant can bill several plans (e.g. two app-store subscriptions): try per exact amount.
    const byAmount = new Map<number, Occurrence[]>();
    for (const it of items) (byAmount.get(it.amount_minor) ?? byAmount.set(it.amount_minor, []).get(it.amount_minor)!).push(it);
    for (const [amount, sub] of byAmount) {
      // Two equal purchases months apart are a coincidence, not a plan.
      if (sub.length === items.length || sub.length < 3) continue;
      const c = analyse(`${key} ${Math.abs(amount) / 100}`, sub, asOf);
      if (c) out.push(c);
    }
  }
  return out.sort((a, b) => b.yearly_cost_base_minor - a.yearly_cost_base_minor);
}

interface CommitmentMatchRow {
  id: number;
  match_pattern: string;
  cadence: Cadence;
  category_id: number | null;
  next_due_on: string | null;
}

/** Attach transactions to commitments via their match pattern and roll the next due date forward. */
export function linkCommitments(db: DB): number {
  const commitments = db
    .prepare("SELECT id, match_pattern, cadence, category_id, next_due_on FROM commitments WHERE status = 'active' AND COALESCE(match_pattern, '') != ''")
    .all() as CommitmentMatchRow[];
  if (commitments.length === 0) return 0;
  const txs = db
    .prepare('SELECT id, counterparty, description, category_id FROM transactions WHERE commitment_id IS NULL AND amount_minor < 0')
    .all() as { id: number; counterparty: string; description: string; category_id: number | null }[];
  const link = db.prepare('UPDATE transactions SET commitment_id = ? WHERE id = ?');
  const setCat = db.prepare("UPDATE transactions SET category_id = ?, category_source = 'commitment' WHERE id = ? AND (category_id IS NULL OR category_source = 'rule')");
  let linked = 0;
  db.transaction(() => {
    for (const c of commitments) {
      const needle = normalize(c.match_pattern);
      for (const t of txs) {
        if (!`${normalize(t.counterparty)} | ${normalize(t.description)}`.includes(needle)) continue;
        link.run(c.id, t.id);
        if (c.category_id) setCat.run(c.category_id, t.id);
        t.counterparty = '';
        t.description = '\u0000'; // consumed
        linked++;
      }
      const last = (db.prepare('SELECT MAX(booked_on) d FROM transactions WHERE commitment_id = ?').get(c.id) as { d: string | null }).d;
      if (last) {
        const next = advance(last, c.cadence);
        if (!c.next_due_on || next > c.next_due_on) db.prepare('UPDATE commitments SET next_due_on = ? WHERE id = ?').run(next, c.id);
      }
    }
  })();
  return linked;
}
