import type { DB } from './db.js';
import { normalize } from './money.js';

export interface RuleRow {
  id: number;
  priority: number;
  field: 'any' | 'counterparty' | 'description' | 'mcc';
  match_type: 'contains' | 'regex';
  pattern: string;
  direction: 'any' | 'in' | 'out';
  category_id: number;
}

export interface Categorizable {
  amount_minor: number;
  description: string;
  counterparty: string;
  mcc?: string | null;
}

type Matcher = (tx: Categorizable) => boolean;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(rule: RuleRow): Matcher {
  let test: (text: string) => boolean;
  if (rule.field === 'mcc') {
    const code = rule.pattern.trim();
    return (tx) => directionOk(rule, tx) && (tx.mcc ?? '') === code;
  }
  if (rule.match_type === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      return () => false;
    }
    test = (text) => re.test(text);
  } else {
    // "contains" must start at a word boundary so that "spar" does not match "sparkasse"-style infixes
    // in the middle of a word, e.g. "mol" must not match "atmolnar".
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(normalize(rule.pattern))}`);
    test = (text) => re.test(text);
  }
  return (tx) => {
    if (!directionOk(rule, tx)) return false;
    const cp = normalize(tx.counterparty);
    const desc = normalize(tx.description);
    if (rule.field === 'counterparty') return test(cp);
    if (rule.field === 'description') return test(desc);
    return test(`${cp} | ${desc}`);
  };
}

function directionOk(rule: RuleRow, tx: Categorizable): boolean {
  if (rule.direction === 'in') return tx.amount_minor > 0;
  if (rule.direction === 'out') return tx.amount_minor < 0;
  return true;
}

export class Categorizer {
  private rules: { rule: RuleRow; match: Matcher }[];

  constructor(db: DB) {
    const rows = db.prepare('SELECT * FROM rules ORDER BY priority ASC, builtin ASC, id ASC').all() as RuleRow[];
    this.rules = rows.map((rule) => ({ rule, match: compile(rule) }));
  }

  categorize(tx: Categorizable): number | null {
    for (const { rule, match } of this.rules) {
      if (match(tx)) return rule.category_id;
    }
    return null;
  }
}

/**
 * Apply rules to stored transactions. Manual choices are never overwritten.
 * `scope: 'uncategorized'` only fills gaps; `'all'` also re-evaluates rule-assigned categories.
 */
export function applyRules(db: DB, scope: 'uncategorized' | 'all' = 'uncategorized'): number {
  const categorizer = new Categorizer(db);
  const where =
    scope === 'all'
      ? "(category_id IS NULL OR category_source = 'rule')"
      : 'category_id IS NULL';
  const rows = db
    .prepare(`SELECT id, amount_minor, description, counterparty, mcc, category_id FROM transactions WHERE ${where}`)
    .all() as (Categorizable & { id: number; category_id: number | null })[];
  const upd = db.prepare("UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?");
  const clear = db.prepare('UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const cat = categorizer.categorize(r);
      if (cat === r.category_id) continue;
      if (cat === null) clear.run(r.id);
      else upd.run(cat, r.id);
      changed++;
    }
  })();
  return changed;
}

/**
 * Pair opposite-signed movements between the user's own accounts and mark both as transfers,
 * so they do not inflate income or spending.
 */
export function detectTransfers(db: DB): number {
  const transferCat = db.prepare("SELECT id FROM categories WHERE kind = 'transfer' ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined;
  if (!transferCat) return 0;
  const candidates = db
    .prepare(
      `SELECT t.id, t.account_id, t.booked_on, t.amount_minor, t.currency, t.amount_base_minor
       FROM transactions t
       WHERE t.transfer_peer_id IS NULL AND t.status = 'booked'
         AND (t.category_source IS NULL OR t.category_source = 'rule')
       ORDER BY t.booked_on, t.id`,
    )
    .all() as { id: number; account_id: number; booked_on: string; amount_minor: number; currency: string; amount_base_minor: number }[];

  const outs = candidates.filter((c) => c.amount_minor < 0);
  const ins = candidates.filter((c) => c.amount_minor > 0);
  const used = new Set<number>();
  const link = db.prepare(
    "UPDATE transactions SET transfer_peer_id = ?, category_id = ?, category_source = 'transfer' WHERE id = ?",
  );
  let pairs = 0;
  db.transaction(() => {
    for (const out of outs) {
      let best: (typeof ins)[number] | undefined;
      let bestGap = Infinity;
      for (const inc of ins) {
        if (used.has(inc.id) || inc.account_id === out.account_id) continue;
        const gap = Math.abs(Date.parse(inc.booked_on) - Date.parse(out.booked_on)) / 86400000;
        if (gap > 3) continue;
        const sameCurrency = inc.currency === out.currency && inc.amount_minor === -out.amount_minor;
        // Currency exchanges between own accounts: same day(ish), base values within 5 %.
        const crossCurrency =
          inc.currency !== out.currency &&
          gap <= 1 &&
          Math.abs(inc.amount_base_minor + out.amount_base_minor) <= Math.abs(out.amount_base_minor) * 0.05 &&
          Math.abs(out.amount_base_minor) > 0;
        if (!sameCurrency && !crossCurrency) continue;
        const score = gap + (sameCurrency ? 0 : 0.5);
        if (score < bestGap) {
          best = inc;
          bestGap = score;
        }
      }
      if (best) {
        used.add(best.id);
        link.run(best.id, transferCat.id, out.id);
        link.run(out.id, transferCat.id, best.id);
        pairs++;
      }
    }
  })();
  return pairs;
}
