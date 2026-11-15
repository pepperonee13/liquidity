import { config } from './config.js';
import { baseCurrency, type DB } from './db.js';
import { addDays, today } from './money.js';

/** Rough fallbacks (units per 1 EUR) used only until real ECB rates have been fetched. */
const FALLBACK_PER_EUR: Record<string, number> = {
  EUR: 1, HUF: 395, USD: 1.08, GBP: 0.85, CHF: 0.95, PLN: 4.3, CZK: 25, RON: 5, SEK: 11.3, NOK: 11.6, DKK: 7.46,
};

export class Fx {
  private cache = new Map<string, number>();
  private getRate;

  constructor(private db: DB) {
    this.getRate = db.prepare(
      'SELECT per_eur FROM fx_rates WHERE currency = ? AND day <= ? ORDER BY day DESC LIMIT 1',
    );
  }

  /** Units of `currency` per 1 EUR on (or before) `day`. */
  perEur(currency: string, day: string): number {
    if (currency === 'EUR') return 1;
    const key = `${currency}|${day}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let row = this.getRate.get(currency, day) as { per_eur: number } | undefined;
    if (!row) {
      row = this.db
        .prepare('SELECT per_eur FROM fx_rates WHERE currency = ? ORDER BY day ASC LIMIT 1')
        .get(currency) as { per_eur: number } | undefined;
    }
    const rate = row?.per_eur ?? FALLBACK_PER_EUR[currency] ?? 1;
    this.cache.set(key, rate);
    return rate;
  }

  convertMinor(amountMinor: number, from: string, to: string, day: string): number {
    if (from === to) return amountMinor;
    return Math.round((amountMinor / this.perEur(from, day)) * this.perEur(to, day));
  }

  toBase(amountMinor: number, from: string, day: string = today()): number {
    return this.convertMinor(amountMinor, from, baseCurrency(this.db), day);
  }
}

/** Recompute the base-currency amount of every transaction (after rates or base currency change). */
export function rebaseTransactions(db: DB): void {
  const fx = new Fx(db);
  const base = baseCurrency(db);
  const rows = db.prepare('SELECT id, amount_minor, currency, booked_on FROM transactions').all() as {
    id: number; amount_minor: number; currency: string; booked_on: string;
  }[];
  const upd = db.prepare('UPDATE transactions SET amount_base_minor = ? WHERE id = ? AND amount_base_minor != ?');
  db.transaction(() => {
    for (const r of rows) {
      const v = fx.convertMinor(r.amount_minor, r.currency, base, r.booked_on);
      upd.run(v, r.id, v);
    }
  })();
}

/**
 * Fetch ECB reference rates (via frankfurter.dev) for every currency in use.
 * Failures are non-fatal: conversion falls back to the nearest known or built-in rate.
 */
export async function syncFxRates(db: DB, fetchImpl: typeof fetch = fetch): Promise<{ fetched: number; error?: string }> {
  const currencies = new Set<string>([baseCurrency(db)]);
  for (const r of db.prepare('SELECT DISTINCT currency FROM accounts UNION SELECT DISTINCT currency FROM transactions UNION SELECT DISTINCT currency FROM commitments').all() as { currency: string }[]) {
    currencies.add(r.currency);
  }
  currencies.delete('EUR');
  if (currencies.size === 0 || !config.fxUrl) return { fetched: 0 };

  const firstTx = (db.prepare('SELECT MIN(booked_on) d FROM transactions').get() as { d: string | null }).d;
  const start = firstTx ?? addDays(today(), -7);
  const insert = db.prepare('INSERT OR REPLACE INTO fx_rates (day, currency, per_eur) VALUES (?, ?, ?)');
  let fetched = 0;
  try {
    for (const cur of currencies) {
      const have = db.prepare('SELECT MIN(day) lo, MAX(day) hi FROM fx_rates WHERE currency = ?').get(cur) as {
        lo: string | null; hi: string | null;
      };
      // Only fetch what is missing: everything, or the tail since the last stored day.
      const from = have.lo && have.lo <= addDays(start, 4) ? addDays(have.hi!, 1) : start;
      if (from > today()) continue;
      const res = await fetchImpl(`${config.fxUrl}/${from}..${today()}?symbols=${cur}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) continue; // currency not published by the ECB
      if (!res.ok) throw new Error(`FX provider responded ${res.status}`);
      const body = (await res.json()) as { rates?: Record<string, Record<string, number>> };
      db.transaction(() => {
        for (const [day, rates] of Object.entries(body.rates ?? {})) {
          if (typeof rates[cur] === 'number') {
            insert.run(day, cur, rates[cur]);
            fetched++;
          }
        }
      })();
    }
  } catch (err) {
    return { fetched, error: err instanceof Error ? err.message : String(err) };
  }
  if (fetched > 0) rebaseTransactions(db);
  return { fetched };
}
