import { describe, expect, it } from 'vitest';
import { Categorizer, detectTransfers } from './categorize.js';
import { openDb } from './db.js';
import { detectMapping, parseCsv, parseDate } from './importers/csv.js';
import { addMonths, monthRange, normalize, parseAmount, toMinor } from './money.js';
import { EnableBankingProvider, mapTransaction } from './providers/enablebanking.js';
import { detectRecurring, merchantKey } from './recurring.js';
import { assignExternalIds, importTransactions } from './sync.js';
import type { ProviderTransaction } from './providers/types.js';

describe('money', () => {
  it('parses bank formatted numbers', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56);
    expect(parseAmount('-1.234,56')).toBe(-1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('-12 500 HUF')).toBe(-12500);
    expect(parseAmount('12,5')).toBe(12.5);
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('12.50')).toBe(12.5);
    expect(parseAmount('(45.00)')).toBe(-45);
    expect(parseAmount('+300')).toBe(300);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
  it('converts to minor units without float drift', () => {
    expect(toMinor('19.99')).toBe(1999);
    expect(toMinor(-0.07)).toBe(-7);
    expect(toMinor('1 000')).toBe(100000);
  });
  it('handles month arithmetic at month ends', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-03-15', -3)).toBe('2023-12-15');
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
  it('normalises Hungarian text', () => {
    expect(normalize('  Fővárosi  VÍZMŰVEK ')).toBe('fovarosi vizmuvek');
  });
});

describe('csv import', () => {
  it('reads a Revolut export', () => {
    const csv = [
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'CARD_PAYMENT,Current,2024-03-01 10:00:00,2024-03-02 08:00:00,Lidl,-4500.00,0.00,HUF,COMPLETED,95500.00',
      'TOPUP,Current,2024-03-03 10:00:00,2024-03-03 10:00:05,Top-Up by *1234,50000.00,0.00,HUF,COMPLETED,145500.00',
      'CARD_PAYMENT,Current,2024-03-04 10:00:00,,Netflix,-4490.00,0.00,HUF,REVERTED,',
      'ATM,Current,2024-03-05 10:00:00,2024-03-05 10:00:00,Cash at ATM,-20000.00,500.00,HUF,COMPLETED,125000.00',
    ].join('\n');
    const r = parseCsv(csv, { defaultCurrency: 'HUF' });
    expect(r.mapping).toMatchObject({ date: 'Completed Date', amount: 'Amount', currency: 'Currency', status: 'State', fee: 'Fee' });
    expect(r.transactions.map((t) => t.amountMinor)).toEqual([-450000, 5000000, -2050000]);
    expect(r.transactions[0].counterparty).toBe('Lidl');
    expect(r.skipped).toHaveLength(1);
    expect(r.latestBalanceMinor).toBe(12500000);
  });

  it('reads a Hungarian semicolon export with debit and credit columns', () => {
    const csv = [
      '﻿Könyvelés dátuma;Partner neve;Közlemény;Terhelés;Jóváírás;Pénznem',
      '2024.03.05.;MVM Next Zrt.;Áramszámla;12 340,00;;HUF',
      '2024.03.06.;ACME Kft.;Munkabér;;650 000,00;HUF',
    ].join('\r\n');
    const r = parseCsv(csv, { defaultCurrency: 'HUF' });
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({ bookedOn: '2024-03-05', amountMinor: -1234000, counterparty: 'MVM Next Zrt.', description: 'Áramszámla' });
    expect(r.transactions[1].amountMinor).toBe(65000000);
  });

  it('parses common date shapes and maps headers', () => {
    expect(parseDate('31.01.2024')).toBe('2024-01-31');
    expect(parseDate('2024/1/5')).toBe('2024-01-05');
    expect(parseDate('20240131')).toBe('2024-01-31');
    expect(parseDate('yesterday')).toBeNull();
    expect(detectMapping(['Dátum', 'Összeg', 'Devizanem'])).toEqual({ date: 'Dátum', amount: 'Összeg', currency: 'Devizanem' });
  });
});

function tx(p: Partial<ProviderTransaction> & { bookedOn: string; amountMinor: number }): ProviderTransaction {
  return { externalId: null, currency: 'HUF', description: '', counterparty: '', status: 'booked', ...p };
}

function accountDb() {
  const db = openDb(':memory:');
  const add = (name: string, currency = 'HUF') =>
    Number(db.prepare('INSERT INTO accounts (name, currency) VALUES (?, ?)').run(name, currency).lastInsertRowid);
  return { db, add };
}

describe('categorisation', () => {
  it('applies built-in rules with word boundaries and direction', () => {
    const { db } = accountDb();
    const c = new Categorizer(db);
    const name = (id: number | null) => (id ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string }).name : null);
    expect(name(c.categorize({ amount_minor: -1, counterparty: 'LIDL Magyarország Bt.', description: '' }))).toBe('Groceries');
    expect(name(c.categorize({ amount_minor: -1, counterparty: 'Bolt Food', description: '' }))).toBe('Dining & delivery');
    expect(name(c.categorize({ amount_minor: -1, counterparty: 'Fővárosi Vízművek', description: 'vízdíj' }))).toBe('Utilities');
    expect(name(c.categorize({ amount_minor: 500000, counterparty: 'ACME Kft.', description: 'Munkabér' }))).toBe('Salary');
    expect(name(c.categorize({ amount_minor: -1, counterparty: 'Unknown shop', description: '', mcc: '5411' }))).toBe('Groceries');
    // "atm" must not fire inside another word, and "kamat" only counts as income when money arrives.
    expect(name(c.categorize({ amount_minor: -1, counterparty: 'Batmobil Kft', description: '' }))).toBeNull();
    expect(name(c.categorize({ amount_minor: -100, counterparty: 'Bank', description: 'kamat' }))).toBeNull();
  });

  it('lets a user rule outrank the defaults', () => {
    const { db } = accountDb();
    const cat = (db.prepare("SELECT id FROM categories WHERE name = 'Gifts & donations'").get() as { id: number }).id;
    db.prepare("INSERT INTO rules (priority, pattern, category_id) VALUES (100, 'lidl', ?)").run(cat);
    expect(new Categorizer(db).categorize({ amount_minor: -1, counterparty: 'Lidl', description: '' })).toBe(cat);
  });

  it('pairs transfers between own accounts', () => {
    const { db, add } = accountDb();
    const a = add('A');
    const b = add('B');
    importTransactions(db, a, [tx({ bookedOn: '2024-03-01', amountMinor: -5000000, description: 'to B' }), tx({ bookedOn: '2024-03-02', amountMinor: -120000, counterparty: 'Shop' })], 'csv');
    importTransactions(db, b, [tx({ bookedOn: '2024-03-02', amountMinor: 5000000, description: 'from A' })], 'csv');
    expect(detectTransfers(db)).toBe(1);
    const flows = db.prepare('SELECT flow FROM v_tx ORDER BY id').all().map((r: any) => r.flow);
    expect(flows).toEqual(['transfer', 'expense', 'transfer']);
  });
});

describe('transaction identity', () => {
  it('is stable across overlapping imports and keeps genuine duplicates', () => {
    const { db, add } = accountDb();
    const a = add('A');
    const coffee = tx({ bookedOn: '2024-03-01', amountMinor: -90000, counterparty: 'Cafe' });
    expect(importTransactions(db, a, [coffee, coffee], 'bank')).toEqual({ inserted: 2, updated: 0 });
    expect(importTransactions(db, a, [coffee, coffee, tx({ bookedOn: '2024-03-02', amountMinor: -1, externalId: 'x1' })], 'bank')).toEqual({ inserted: 1, updated: 0 });
    expect(assignExternalIds([coffee, coffee])[1]).toMatch(/#1$/);
  });

  it('replaces pending items and keeps manual categories on re-sync', () => {
    const { db, add } = accountDb();
    const a = add('A');
    importTransactions(db, a, [tx({ bookedOn: '2024-03-01', amountMinor: -100, status: 'pending', counterparty: 'Hold' }), tx({ bookedOn: '2024-03-01', amountMinor: -500, externalId: 'e1' })], 'bank');
    db.prepare("UPDATE transactions SET category_id = 1, category_source = 'manual' WHERE external_id = 'id:e1'").run();
    importTransactions(db, a, [tx({ bookedOn: '2024-03-02', amountMinor: -100, externalId: 'e2', counterparty: 'Hold' }), tx({ bookedOn: '2024-03-01', amountMinor: -500, externalId: 'e1' })], 'bank');
    const rows = db.prepare('SELECT external_id, status, category_id FROM transactions ORDER BY external_id').all();
    expect(rows).toEqual([
      { external_id: 'id:e1', status: 'booked', category_id: 1 },
      { external_id: 'id:e2', status: 'booked', category_id: null },
    ]);
  });
});

describe('recurring detection', () => {
  it('finds monthly and yearly payments but not irregular shopping', () => {
    const { db, add } = accountDb();
    const a = add('A');
    const txs: ProviderTransaction[] = [];
    for (let i = 0; i < 8; i++) {
      const month = addMonths('2024-01-03', i);
      txs.push(tx({ bookedOn: month, amountMinor: i < 5 ? -449000 : -499000, counterparty: 'Netflix.com' }));
      txs.push(tx({ bookedOn: addMonths('2024-01-12', i), amountMinor: -(1500000 + i * 210000), counterparty: 'MVM Next Zrt.', description: 'áram' }));
    }
    for (const d of ['2024-01-02', '2024-01-09', '2024-01-11', '2024-02-20', '2024-03-01', '2024-03-02', '2024-06-17', '2024-08-01']) {
      txs.push(tx({ bookedOn: d, amountMinor: -800000, counterparty: 'Lidl 123' }));
    }
    txs.push(tx({ bookedOn: '2022-09-01', amountMinor: -6000000, counterparty: 'Allianz Biztosító' }));
    txs.push(tx({ bookedOn: '2023-09-01', amountMinor: -6400000, counterparty: 'Allianz Biztosító' }));
    txs.push(tx({ bookedOn: '2024-01-05', amountMinor: -300000, counterparty: 'Old Gym' }), tx({ bookedOn: '2024-02-05', amountMinor: -300000, counterparty: 'Old Gym' }), tx({ bookedOn: '2024-03-05', amountMinor: -300000, counterparty: 'Old Gym' }));
    importTransactions(db, a, txs, 'csv');
    db.prepare("UPDATE transactions SET category_id = (SELECT id FROM categories WHERE name = 'Insurance') WHERE counterparty LIKE 'Allianz%'").run();

    const found = detectRecurring(db, '2024-08-20');
    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual(['Allianz Biztosító', 'MVM Next Zrt.', 'Netflix.com']);
    expect(byName['Netflix.com']).toMatchObject({ cadence: 'monthly', amount_minor: 499000, amount_type: 'fixed', next_expected_on: '2024-09-03' });
    expect(byName['Netflix.com'].price_change).toBeCloseTo(1.111, 2);
    expect(byName['MVM Next Zrt.']).toMatchObject({ cadence: 'monthly', amount_type: 'variable' });
    expect(byName['Allianz Biztosító']).toMatchObject({ cadence: 'yearly', suggested_kind: 'insurance' });
  });

  it('builds merchant keys that ignore store numbers and legal suffixes', () => {
    expect(merchantKey('LIDL 0123 Budapest', '')).toBe('lidl');
    expect(merchantKey('Lidl Magyarország Bt.', '')).toBe('lidl');
    expect(merchantKey('', 'NETFLIX.COM 866-579')).toBe('netflix');
  });
});

describe('Enable Banking mapping', () => {
  it('maps debit and credit entries', () => {
    const out = mapTransaction({
      entry_reference: 'r1', transaction_amount: { amount: '4990.00', currency: 'HUF' }, credit_debit_indicator: 'DBIT', status: 'BOOK',
      booking_date: '2024-03-02', value_date: '2024-03-01', creditor: { name: 'Netflix' }, debtor: { name: 'Me' },
      remittance_information: ['NETFLIX.COM', 'ref 1'], merchant_category_code: '4899',
    });
    expect(out).toMatchObject({ externalId: 'r1', bookedOn: '2024-03-02', amountMinor: -499000, counterparty: 'Netflix', description: 'NETFLIX.COM ref 1', mcc: '4899', status: 'booked' });
    const inc = mapTransaction({ transaction_amount: { amount: '100.5', currency: 'EUR' }, credit_debit_indicator: 'CRDT', status: 'PDNG', value_date: '2024-03-05', debtor: { name: 'Employer' } });
    expect(inc).toMatchObject({ externalId: null, amountMinor: 10050, counterparty: 'Employer', status: 'pending', bookedOn: '2024-03-05' });
    expect(mapTransaction({ transaction_amount: { amount: '1', currency: 'EUR' }, credit_debit_indicator: 'CRDT', status: 'RJCT', booking_date: '2024-03-05' })).toBeNull();
  });

  it('signs requests, follows continuation keys and classifies errors', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls: { url: string; auth: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, auth: String((init?.headers as Record<string, string>).Authorization) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.includes('/balances')) return json({ balances: [{ balance_type: 'CLAV', balance_amount: { amount: '5', currency: 'HUF' } }, { balance_type: 'CLBD', balance_amount: { amount: '1234.50', currency: 'HUF' } }] });
      if (url.includes('/accounts/gone/')) return json({ error: 'EXPIRED_SESSION', message: 'Session expired' }, 401);
      const page = (n: string) => ({ transaction_amount: { amount: n, currency: 'HUF' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2024-03-01' });
      if (url.includes('continuation_key=k2')) return json({ transactions: [page('2')] });
      return json({ transactions: [page('1')], continuation_key: 'k2' });
    };
    const p = new EnableBankingProvider(
      { appId: 'app-123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, privateKeyPath: '', baseUrl: 'https://eb.test' },
      fake,
    );
    expect(await p.getBalance('s', 'acc')).toEqual({ amountMinor: 123450, currency: 'HUF' });
    const txs = await p.getTransactions('s', 'acc', { from: '2024-01-01', to: '2024-03-31', initial: false });
    expect(txs.map((t) => t.amountMinor)).toEqual([-100, -200]);
    const header = JSON.parse(Buffer.from(calls[0].auth.split(' ')[1].split('.')[0], 'base64url').toString());
    expect(header).toMatchObject({ alg: 'RS256', kid: 'app-123' });
    await expect(p.getTransactions('s', 'gone', { from: '2024-01-01', to: '2024-03-31', initial: false })).rejects.toMatchObject({ code: 'expired' });
  });
});
