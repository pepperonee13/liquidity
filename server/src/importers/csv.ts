import { parse } from 'csv-parse/sync';
import { normalize, parseAmount } from '../money.js';
import type { ProviderTransaction } from '../providers/types.js';

export interface CsvMapping {
  date: string;
  amount?: string;
  /** Separate columns for money out / money in (used when there is no signed amount column). */
  debit?: string;
  credit?: string;
  currency?: string;
  description?: string;
  counterparty?: string;
  id?: string;
  status?: string;
  balance?: string;
  fee?: string;
}

const SYNONYMS: Record<keyof CsvMapping, string[]> = {
  date: ['completed date', 'booking date', 'konyveles datuma', 'konyvelesi datum', 'konyveles napja', 'tranzakcio datuma', 'tranzakcio idopontja', 'datum', 'date', 'started date', 'erteknap', 'value date'],
  amount: ['amount', 'osszeg', 'tranzakcio osszege', 'konyvelt osszeg', 'osszeg (huf)'],
  debit: ['terheles', 'debit', 'kiadas', 'money out', 'paid out'],
  credit: ['jovairas', 'credit', 'bevetel', 'money in', 'paid in'],
  currency: ['currency', 'penznem', 'deviza', 'devizanem', 'osszeg devizaneme'],
  description: ['description', 'kozlemeny', 'megjegyzes', 'leiras', 'reference', 'narrative', 'tranzakcio tipusa', 'type'],
  counterparty: ['partner neve', 'partner', 'kedvezmenyezett neve', 'kedvezmenyezett', 'ellenoldali nev', 'ellenoldal neve', 'counterparty', 'payee', 'merchant', 'name', 'nev'],
  id: ['transaction id', 'tranzakcio azonosito', 'azonosito', 'banki tranzakcio azonosito', 'id'],
  status: ['state', 'status', 'allapot', 'statusz'],
  balance: ['balance', 'egyenleg', 'konyvelt egyenleg', 'egyenleg a tranzakcio utan'],
  fee: ['fee', 'dij'],
};

export function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = [';', ',', '\t', '|'].map((d) => [d, head.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function detectMapping(headers: string[]): Partial<CsvMapping> {
  const norm = headers.map((h) => normalize(h));
  const mapping: Partial<CsvMapping> = {};
  for (const field of Object.keys(SYNONYMS) as (keyof CsvMapping)[]) {
    for (const syn of SYNONYMS[field]) {
      const idx = norm.findIndex((h, i) => h === syn && !Object.values(mapping).includes(headers[i]));
      if (idx >= 0) {
        mapping[field] = headers[idx];
        break;
      }
    }
  }
  return mapping;
}

/** Accepts 2024-01-31, 2024.01.31., 2024/01/31, 31.01.2024, 31/01/2024 (with optional time). */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let m = s.match(/^(\d{4})[-./ ]\s?(\d{1,2})[-./ ]\s?(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{4})/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface CsvParseResult {
  headers: string[];
  mapping: Partial<CsvMapping>;
  transactions: ProviderTransaction[];
  skipped: { line: number; reason: string }[];
  /** Balance after the most recent row, when the file has a balance column. */
  latestBalanceMinor: number | null;
}

export function parseCsv(text: string, opts: { mapping?: Partial<CsvMapping>; defaultCurrency: string }): CsvParseResult {
  const clean = text.replace(/^﻿/, '');
  const records = parse(clean, {
    delimiter: sniffDelimiter(clean),
    columns: (header: string[]) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  const mapping = { ...detectMapping(headers), ...stripEmpty(opts.mapping) };
  const result: CsvParseResult = { headers, mapping, transactions: [], skipped: [], latestBalanceMinor: null };
  if (!mapping.date || (!mapping.amount && !mapping.debit && !mapping.credit)) return result;

  const balances: { day: string; balance: number }[] = [];
  records.forEach((rec, i) => {
    const line = i + 2;
    const get = (col?: string) => (col ? (rec[col] ?? '').trim() : '');
    const day = parseDate(get(mapping.date));
    if (!day) return void result.skipped.push({ line, reason: `Unreadable date "${get(mapping.date)}"` });

    const state = normalize(get(mapping.status));
    if (state && /(revert|declin|fail|cancel|elutasit|sikertelen|torolt)/.test(state)) {
      return void result.skipped.push({ line, reason: `Status ${get(mapping.status)}` });
    }

    if (state && /pend|fuggo/.test(state)) return void result.skipped.push({ line, reason: 'Still pending' });

    let amount: number | null = null;
    if (mapping.amount) amount = parseAmount(get(mapping.amount));
    if (amount === null && (mapping.debit || mapping.credit)) {
      const debit = parseAmount(get(mapping.debit));
      const credit = parseAmount(get(mapping.credit));
      if (debit) amount = -Math.abs(debit);
      else if (credit) amount = Math.abs(credit);
    }
    if (amount === null) return void result.skipped.push({ line, reason: 'No amount' });
    const fee = parseAmount(get(mapping.fee));
    if (fee) amount -= Math.abs(fee);
    if (amount === 0) return void result.skipped.push({ line, reason: 'Zero amount' });

    const currency = (get(mapping.currency) || opts.defaultCurrency).toUpperCase().slice(0, 3);
    const counterparty = get(mapping.counterparty);
    const description = get(mapping.description);
    result.transactions.push({
      externalId: get(mapping.id) || null,
      bookedOn: day,
      amountMinor: Math.round(amount * 100),
      currency,
      // Card exports (e.g. Revolut) put the merchant in the description column.
      counterparty: counterparty || description,
      description: counterparty ? description : '',
      status: 'booked',
      raw: rec,
    });

    const balance = parseAmount(get(mapping.balance));
    if (balance !== null) balances.push({ day, balance });
  });
  if (balances.length) {
    // Files come oldest-first or newest-first; pick the row that is last in time either way.
    const newestFirst = balances[0].day > balances[balances.length - 1].day;
    const maxDay = balances.reduce((m, b) => (b.day > m ? b.day : m), '');
    const sameDay = balances.filter((b) => b.day === maxDay);
    const pick = newestFirst ? sameDay[0] : sameDay[sameDay.length - 1];
    result.latestBalanceMinor = Math.round(pick.balance * 100);
  }
  return result;
}

function stripEmpty<T extends object>(obj?: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (v) (out as Record<string, unknown>)[k] = v;
  return out;
}
