import crypto from 'node:crypto';
import { applyRules, detectTransfers } from './categorize.js';
import { baseCurrency, type DB } from './db.js';
import { Fx, syncFxRates } from './fx.js';
import { addDays, normalize, today } from './money.js';
import type { ProviderRegistry } from './providers/index.js';
import { ProviderError, type ProviderTransaction } from './providers/types.js';
import { linkCommitments } from './recurring.js';

export interface AccountRow {
  id: number;
  connection_id: number | null;
  external_id: string | null;
  provider_uid: string | null;
  name: string;
  institution: string;
  iban: string | null;
  currency: string;
  type: string;
  balance_minor: number;
  balance_at: string | null;
  include_in_net_worth: number;
  archived: number;
}

export interface ConnectionRow {
  id: number;
  provider: string;
  institution_name: string;
  institution_country: string;
  status: 'pending' | 'active' | 'expired' | 'error' | 'revoked';
  external_session_id: string | null;
  state: string | null;
  valid_until: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

/**
 * Stable identity for a transaction within its account. Banks do not always provide an id,
 * so we fall back to a content hash plus the occurrence number among identical rows.
 */
export function assignExternalIds(txs: ProviderTransaction[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const base = t.externalId
      ? `id:${t.externalId}`
      : `h:${crypto
          .createHash('sha1')
          .update([t.bookedOn, t.amountMinor, t.currency, normalize(t.counterparty), normalize(t.description)].join('|'))
          .digest('hex')
          .slice(0, 20)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = n === 0 ? base : `${base}#${n}`;
    return t.status === 'pending' ? `pending:${key}` : key;
  });
}

export function importTransactions(
  db: DB,
  accountId: number,
  txs: ProviderTransaction[],
  source: 'bank' | 'csv' | 'manual',
): { inserted: number; updated: number } {
  const fx = new Fx(db);
  const base = baseCurrency(db);
  const ids = assignExternalIds(txs);
  const exists = db.prepare('SELECT id FROM transactions WHERE account_id = ? AND external_id = ?');
  const insert = db.prepare(
    `INSERT INTO transactions
       (account_id, external_id, source, booked_on, value_on, amount_minor, currency, amount_base_minor,
        description, counterparty, counterparty_iban, mcc, status, raw)
     VALUES (@account_id, @external_id, @source, @booked_on, @value_on, @amount_minor, @currency, @amount_base_minor,
        @description, @counterparty, @counterparty_iban, @mcc, @status, @raw)`,
  );
  const update = db.prepare(
    `UPDATE transactions SET booked_on = @booked_on, value_on = @value_on, amount_minor = @amount_minor,
       amount_base_minor = @amount_base_minor, description = @description, counterparty = @counterparty,
       counterparty_iban = @counterparty_iban, mcc = @mcc, raw = @raw
     WHERE id = @id AND (amount_minor != @amount_minor OR booked_on != @booked_on
       OR description != @description OR counterparty != @counterparty)`,
  );
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    if (source === 'bank') {
      // Pending items have no stable identity; replace them wholesale on every sync.
      db.prepare("DELETE FROM transactions WHERE account_id = ? AND source = 'bank' AND status = 'pending'").run(accountId);
    }
    txs.forEach((t, i) => {
      const row = {
        account_id: accountId,
        external_id: ids[i],
        source,
        booked_on: t.bookedOn,
        value_on: t.valueOn ?? null,
        amount_minor: t.amountMinor,
        currency: t.currency,
        amount_base_minor: fx.convertMinor(t.amountMinor, t.currency, base, t.bookedOn),
        description: t.description ?? '',
        counterparty: t.counterparty ?? '',
        counterparty_iban: t.counterpartyIban ?? null,
        mcc: t.mcc ?? null,
        status: t.status,
        raw: t.raw === undefined ? null : JSON.stringify(t.raw),
      };
      const found = exists.get(accountId, ids[i]) as { id: number } | undefined;
      if (found) updated += update.run({ ...row, id: found.id }).changes;
      else {
        insert.run(row);
        inserted++;
      }
    });
  })();
  return { inserted, updated };
}

/** Everything that should happen after new transactions arrive, from any source. */
export async function postImport(db: DB, opts: { fx?: boolean } = {}): Promise<void> {
  if (opts.fx !== false) await syncFxRates(db);
  applyRules(db, 'uncategorized');
  detectTransfers(db);
  linkCommitments(db);
}

export interface SyncResult {
  connection_id: number;
  status: ConnectionRow['status'];
  accounts: number;
  inserted: number;
  updated: number;
  error: string | null;
}

export async function syncConnection(db: DB, providers: ProviderRegistry, connectionId: number): Promise<SyncResult> {
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as ConnectionRow | undefined;
  if (!conn) throw new Error('Connection not found');
  const result: SyncResult = { connection_id: conn.id, status: conn.status, accounts: 0, inserted: 0, updated: 0, error: null };
  const provider = providers.get(conn.provider);
  if (!provider || !conn.external_session_id || conn.status === 'pending' || conn.status === 'revoked') {
    result.error = !provider ? `Provider ${conn.provider} is not available` : 'Connection is not authorised';
    return result;
  }
  if (conn.valid_until && conn.valid_until < new Date().toISOString()) {
    db.prepare("UPDATE connections SET status = 'expired', last_error = ? WHERE id = ?").run(
      'Bank consent expired – reconnect to continue syncing.',
      conn.id,
    );
    return { ...result, status: 'expired', error: 'Bank consent expired – reconnect to continue syncing.' };
  }

  const accounts = db
    .prepare('SELECT * FROM accounts WHERE connection_id = ? AND archived = 0 AND provider_uid IS NOT NULL')
    .all(conn.id) as AccountRow[];
  const errors: string[] = [];
  let expired = false;

  for (const account of accounts) {
    try {
      const balance = await provider.getBalance(conn.external_session_id, account.provider_uid!);
      if (balance) {
        db.prepare("UPDATE accounts SET balance_minor = ?, balance_at = datetime('now') WHERE id = ?").run(
          balance.amountMinor,
          account.id,
        );
      }
      const last = (
        db.prepare("SELECT MAX(booked_on) d FROM transactions WHERE account_id = ? AND source = 'bank'").get(account.id) as {
          d: string | null;
        }
      ).d;
      const range = last
        ? { from: addDays(last, -10), to: today(), initial: false }
        : { from: addDays(today(), -730), to: today(), initial: true };
      const txs = await provider.getTransactions(conn.external_session_id, account.provider_uid!, range);
      const r = importTransactions(db, account.id, txs, 'bank');
      result.accounts++;
      result.inserted += r.inserted;
      result.updated += r.updated;
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'expired') expired = true;
      errors.push(`${account.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await postImport(db);

  result.error = errors.length ? errors.join('; ') : null;
  result.status = expired ? 'expired' : errors.length && result.accounts === 0 && accounts.length > 0 ? 'error' : 'active';
  db.prepare(
    `UPDATE connections SET status = ?, last_error = ?,
       last_synced_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_synced_at END WHERE id = ?`,
  ).run(result.status, result.error, result.accounts, conn.id);
  return result;
}

export async function syncAll(db: DB, providers: ProviderRegistry): Promise<SyncResult[]> {
  const conns = db.prepare("SELECT id FROM connections WHERE status IN ('active','error')").all() as { id: number }[];
  const out: SyncResult[] = [];
  for (const c of conns) out.push(await syncConnection(db, providers, c.id));
  return out;
}
