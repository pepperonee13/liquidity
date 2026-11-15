import { Type as T, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { badRequest, HttpError, notFound } from '../app.js';
import { redirectUrl } from '../config.js';
import { Fx } from '../fx.js';
import { parseCsv } from '../importers/csv.js';
import { fromMinor, toMinor } from '../money.js';
import { Account, AccountType, Currency, IdParams, Nullable, Ok } from '../schemas.js';
import { importTransactions, postImport, syncConnection, type AccountRow, type ConnectionRow } from '../sync.js';

const Connection = T.Object({
  id: T.Integer(),
  provider: T.String(),
  institution_name: T.String(),
  institution_country: T.String(),
  status: T.String({ description: 'pending, active, expired (re-authorise at the bank), error or revoked' }),
  valid_until: Nullable(T.String({ description: 'When the bank consent expires' })),
  last_synced_at: Nullable(T.String()),
  last_error: Nullable(T.String()),
  syncing: T.Boolean(),
  accounts: T.Integer(),
});

const SyncResult = T.Object({
  connection_id: T.Integer(),
  status: T.String(),
  accounts: T.Integer(),
  inserted: T.Integer(),
  updated: T.Integer(),
  error: Nullable(T.String()),
});

export async function bankRoutes(app: FastifyInstance) {
  const { db, providers, syncing } = app.ctx;
  const tags = ['banks'];

  const runSync = async (id: number) => {
    if (syncing.has(id)) throw new HttpError(409, 'conflict', 'A sync is already running for this connection.');
    syncing.add(id);
    try {
      return await syncConnection(db, providers, id);
    } finally {
      syncing.delete(id);
    }
  };

  app.get('/api/providers', {
    schema: { tags, summary: 'Available bank data providers',
      response: { 200: T.Array(T.Object({ id: T.String(), label: T.String(), configured: T.Boolean(), setup_hint: Nullable(T.String()), redirect_url: T.String() })) } },
  }, async () =>
    [...providers.values()].map((p) => ({
      id: p.id, label: p.label, configured: p.configured(), setup_hint: p.configured() ? null : (p.setupHint ?? null), redirect_url: redirectUrl(),
    })),
  );

  app.get('/api/providers/:provider/institutions', {
    schema: { tags, summary: 'Banks a provider can connect to in a country',
      params: T.Object({ provider: T.String() }),
      querystring: T.Object({ country: T.String({ minLength: 2, maxLength: 2, default: 'HU' }) }),
      response: { 200: T.Array(T.Object({ name: T.String(), country: T.String(), logo: T.Optional(T.String()) })) } },
  }, async (req) => {
    const provider = providers.get((req.params as { provider: string }).provider);
    if (!provider) throw notFound('Provider');
    if (!provider.configured()) throw badRequest(provider.setupHint ?? 'Provider is not configured.');
    return provider.listInstitutions((req.query as { country: string }).country.toUpperCase());
  });

  app.get('/api/connections', { schema: { tags, summary: 'List bank connections', response: { 200: T.Array(Connection) } } }, async () => {
    const rows = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM accounts a WHERE a.connection_id = c.id) AS accounts
         FROM connections c WHERE c.status != 'pending' OR c.created_at > datetime('now', '-1 hour') ORDER BY c.id`,
      )
      .all() as (ConnectionRow & { accounts: number })[];
    return rows.map((c) => ({
      id: c.id, provider: c.provider, institution_name: c.institution_name, institution_country: c.institution_country,
      status: c.status, valid_until: c.valid_until, last_synced_at: c.last_synced_at, last_error: c.last_error,
      syncing: syncing.has(c.id), accounts: c.accounts,
    }));
  });

  const startAuth = async (connectionId: number, providerId: string, name: string, country: string) => {
    const provider = providers.get(providerId);
    if (!provider) throw notFound('Provider');
    if (!provider.configured()) throw badRequest(provider.setupHint ?? 'Provider is not configured.');
    const institution = (await provider.listInstitutions(country)).find((i) => i.name === name) ?? { name, country };
    const state = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE connections SET state = ? WHERE id = ?').run(state, connectionId);
    const { url } = await provider.startAuth({ institution, state, redirectUrl: redirectUrl() });
    return { id: connectionId, auth_url: url };
  };

  const NewConnection = T.Object({
    provider: T.String(),
    institution_name: T.String(),
    country: T.String({ minLength: 2, maxLength: 2, default: 'HU' }),
  });
  const AuthStart = T.Object({ id: T.Integer(), auth_url: T.String({ description: 'Open this URL in a browser to authorise at the bank' }) });

  app.post('/api/connections', {
    schema: { tags, summary: 'Start connecting a bank (interactive login only)', body: NewConnection, response: { 200: AuthStart } },
  }, async (req) => {
    const body = req.body as Static<typeof NewConnection>;
    const info = db
      .prepare('INSERT INTO connections (provider, institution_name, institution_country) VALUES (?, ?, ?)')
      .run(body.provider, body.institution_name, body.country.toUpperCase());
    const id = Number(info.lastInsertRowid);
    try {
      return await startAuth(id, body.provider, body.institution_name, body.country.toUpperCase());
    } catch (err) {
      db.prepare('DELETE FROM connections WHERE id = ?').run(id);
      throw err instanceof HttpError ? err : badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/connections/:id/reconnect', {
    schema: { tags, summary: 'Renew an expired bank consent; history and categories are kept', params: IdParams, response: { 200: AuthStart } },
  }, async (req) => {
    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get((req.params as { id: number }).id) as ConnectionRow | undefined;
    if (!conn) throw notFound('Connection');
    try {
      return await startAuth(conn.id, conn.provider, conn.institution_name, conn.institution_country);
    } catch (err) {
      throw err instanceof HttpError ? err : badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  // The bank (via the provider) sends the browser back here after the user has authorised access.
  app.get('/api/connections/callback', { schema: { hide: true } }, async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string };
    const fail = (message: string) => reply.redirect(`/accounts?connect_error=${encodeURIComponent(message)}`);
    const conn = q.state ? (db.prepare('SELECT * FROM connections WHERE state = ?').get(q.state) as ConnectionRow | undefined) : undefined;
    if (!conn) return fail('Unknown or expired authorisation attempt.');
    db.prepare('UPDATE connections SET state = NULL WHERE id = ?').run(conn.id);
    if (q.error || !q.code) {
      if (conn.status === 'pending') db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
      return fail(q.error_description || q.error || 'The bank did not return an authorisation code.');
    }
    const provider = providers.get(conn.provider);
    if (!provider) return fail('Provider unavailable.');
    try {
      const auth = await provider.completeAuth({ code: q.code });
      db.transaction(() => {
        db.prepare("UPDATE connections SET status = 'active', external_session_id = ?, valid_until = ?, last_error = NULL WHERE id = ?").run(
          auth.sessionId, auth.validUntil, conn.id,
        );
        for (const a of auth.accounts) {
          // Re-attach to an existing account (same bank account seen before) so history survives re-consent.
          const existing = db
            .prepare(
              `SELECT a.id FROM accounts a LEFT JOIN connections c ON c.id = a.connection_id
               WHERE (a.external_id = ? OR (a.iban IS NOT NULL AND a.iban = ? AND a.currency = ?))
                 AND (c.provider = ? OR a.connection_id IS NULL) LIMIT 1`,
            )
            .get(a.stableId, a.iban ?? null, a.currency, conn.provider) as { id: number } | undefined;
          if (existing) {
            db.prepare('UPDATE accounts SET connection_id = ?, external_id = ?, provider_uid = ? WHERE id = ?').run(conn.id, a.stableId, a.uid, existing.id);
          } else {
            db.prepare(
              `INSERT INTO accounts (connection_id, external_id, provider_uid, name, institution, iban, currency, type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(conn.id, a.stableId, a.uid, a.name, conn.institution_name, a.iban ?? null, a.currency, a.type);
          }
        }
        // Older connections to the same bank that no longer feed any account are superseded.
        db.prepare(
          `DELETE FROM connections WHERE id != ? AND provider = ? AND institution_name = ?
             AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.connection_id = connections.id)`,
        ).run(conn.id, conn.provider, conn.institution_name);
      })();
    } catch (err) {
      if (conn.status === 'pending') db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
      return fail(err instanceof Error ? err.message : String(err));
    }
    // First sync can take a while; run it in the background and let the UI poll.
    void runSync(conn.id).catch((err) => app.log.error(err));
    return reply.redirect(`/accounts?connected=${conn.id}`);
  });

  app.post('/api/connections/:id/sync', {
    schema: { tags, summary: 'Fetch new balances and transactions for one connection now', params: IdParams, response: { 200: SyncResult } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    if (!db.prepare('SELECT 1 FROM connections WHERE id = ?').get(id)) throw notFound('Connection');
    return runSync(id);
  });

  app.post('/api/sync', {
    schema: { tags, summary: 'Sync every active connection now', description: 'Banks limit unattended refreshes to about four per day per account; avoid calling this in a loop.', response: { 200: T.Array(SyncResult) } },
  }, async () => {
    const ids = db.prepare("SELECT id FROM connections WHERE status IN ('active','error')").all() as { id: number }[];
    const out = [];
    for (const { id } of ids) if (!syncing.has(id)) out.push(await runSync(id));
    return out;
  });

  app.delete('/api/connections/:id', {
    schema: { tags, summary: 'Disconnect a bank', params: IdParams,
      querystring: T.Object({ purge: T.Boolean({ default: false, description: 'Also delete its accounts and transactions' }) }), response: { 200: Ok } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
    if (!conn) throw notFound('Connection');
    if (conn.external_session_id) await providers.get(conn.provider)?.revoke(conn.external_session_id).catch(() => undefined);
    db.transaction(() => {
      if ((req.query as { purge: boolean }).purge) db.prepare('DELETE FROM accounts WHERE connection_id = ?').run(id);
      db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    })();
    return { ok: true };
  });

  // ---- Accounts ----

  const accountView = (where = '', params: unknown[] = []) => {
    const fx = new Fx(db);
    const rows = db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS transactions,
                (SELECT MAX(booked_on) FROM transactions t WHERE t.account_id = a.id) AS last_transaction_on
         FROM accounts a ${where} ORDER BY a.archived, a.institution, a.name`,
      )
      .all(...params) as (AccountRow & { transactions: number; last_transaction_on: string | null })[];
    return rows.map((a) => ({
      id: a.id, name: a.name, institution: a.institution, iban: a.iban, currency: a.currency, type: a.type,
      balance: fromMinor(a.balance_minor), balance_base: fromMinor(fx.toBase(a.balance_minor, a.currency)),
      balance_at: a.balance_at, include_in_net_worth: Boolean(a.include_in_net_worth), archived: Boolean(a.archived),
      connection_id: a.connection_id, source: a.connection_id ? 'bank' : 'manual',
      transactions: a.transactions, last_transaction_on: a.last_transaction_on,
    }));
  };
  const oneAccount = (id: number) => {
    const [a] = accountView('WHERE a.id = ?', [id]);
    if (!a) throw notFound('Account');
    return a;
  };

  app.get('/api/accounts', { schema: { tags: ['accounts'], summary: 'List accounts with balances', response: { 200: T.Array(Account) } } }, async () => accountView());

  const NewAccount = T.Object({
    name: T.String({ minLength: 1 }),
    institution: T.Optional(T.String()),
    currency: Currency,
    type: T.Optional(AccountType),
    balance: T.Optional(T.Number()),
    iban: T.Optional(Nullable(T.String())),
  });
  app.post('/api/accounts', {
    schema: { tags: ['accounts'], summary: 'Create a manual account (cash, an unsupported bank, an investment, a debt)', body: NewAccount, response: { 200: Account } },
  }, async (req) => {
    const b = req.body as Static<typeof NewAccount>;
    const info = db
      .prepare("INSERT INTO accounts (name, institution, currency, type, balance_minor, balance_at, iban) VALUES (?, ?, ?, ?, ?, datetime('now'), ?)")
      .run(b.name, b.institution ?? '', b.currency.toUpperCase(), b.type ?? 'checking', toMinor(b.balance ?? 0), b.iban ?? null);
    return oneAccount(Number(info.lastInsertRowid));
  });

  const PatchAccount = T.Partial(T.Object({
    name: T.String({ minLength: 1 }),
    institution: T.String(),
    type: AccountType,
    balance: T.Number({ description: 'Only for manual accounts; synced balances come from the bank' }),
    include_in_net_worth: T.Boolean(),
    archived: T.Boolean(),
  }));
  app.patch('/api/accounts/:id', {
    schema: { tags: ['accounts'], summary: 'Update an account', params: IdParams, body: PatchAccount, response: { 200: Account } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const b = req.body as Static<typeof PatchAccount>;
    oneAccount(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (b.name !== undefined) (sets.push('name = ?'), params.push(b.name));
    if (b.institution !== undefined) (sets.push('institution = ?'), params.push(b.institution));
    if (b.type !== undefined) (sets.push('type = ?'), params.push(b.type));
    if (b.balance !== undefined) (sets.push("balance_minor = ?, balance_at = datetime('now')"), params.push(toMinor(b.balance)));
    if (b.include_in_net_worth !== undefined) (sets.push('include_in_net_worth = ?'), params.push(b.include_in_net_worth ? 1 : 0));
    if (b.archived !== undefined) (sets.push('archived = ?'), params.push(b.archived ? 1 : 0));
    if (sets.length) db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return oneAccount(id);
  });

  app.delete('/api/accounts/:id', {
    schema: { tags: ['accounts'], summary: 'Delete an account and all of its transactions', params: IdParams, response: { 200: Ok } },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    oneAccount(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return { ok: true };
  });

  const Mapping = T.Partial(T.Object({
    date: T.String(), amount: T.String(), debit: T.String(), credit: T.String(), currency: T.String(),
    description: T.String(), counterparty: T.String(), id: T.String(), status: T.String(), balance: T.String(), fee: T.String(),
  }), { description: 'Column header for each field. Omit to auto-detect (English and Hungarian headers are recognised).' });
  const ImportBody = T.Object({
    csv: T.String({ description: 'The CSV file content as text' }),
    mapping: T.Optional(Mapping),
    dry_run: T.Boolean({ default: false, description: 'Parse and preview without saving' }),
    update_balance: T.Boolean({ default: true, description: 'Set the account balance from the file when it has a balance column' }),
  });
  app.post('/api/accounts/:id/import-csv', {
    schema: {
      tags: ['accounts'], summary: 'Import a bank statement CSV into an account',
      description: 'Re-importing overlapping files is safe: rows already imported are recognised and skipped.',
      params: IdParams, body: ImportBody,
      response: { 200: T.Object({
        headers: T.Array(T.String()), mapping: Mapping, parsed: T.Integer(), inserted: T.Integer(), updated: T.Integer(),
        skipped: T.Array(T.Object({ line: T.Integer(), reason: T.String() })),
        preview: T.Array(T.Object({ booked_on: T.String(), amount: T.Number(), currency: T.String(), counterparty: T.String(), description: T.String() })),
      }) },
    },
  }, async (req) => {
    const id = (req.params as { id: number }).id;
    const body = req.body as Static<typeof ImportBody>;
    const account = oneAccount(id);
    const parsed = parseCsv(body.csv, { mapping: body.mapping, defaultCurrency: account.currency });
    if (!parsed.mapping.date || (!parsed.mapping.amount && !parsed.mapping.debit && !parsed.mapping.credit)) {
      if (!body.dry_run) throw badRequest(`Could not find date and amount columns. Headers: ${parsed.headers.join(', ')}`);
    }
    let result = { inserted: 0, updated: 0 };
    if (!body.dry_run) {
      result = importTransactions(db, id, parsed.transactions, 'csv');
      if (body.update_balance && parsed.latestBalanceMinor !== null && !account.connection_id) {
        db.prepare("UPDATE accounts SET balance_minor = ?, balance_at = datetime('now') WHERE id = ?").run(parsed.latestBalanceMinor, id);
      }
      await postImport(db);
    }
    return {
      headers: parsed.headers, mapping: parsed.mapping, parsed: parsed.transactions.length, ...result,
      skipped: parsed.skipped.slice(0, 50),
      preview: parsed.transactions.slice(0, 8).map((t) => ({
        booked_on: t.bookedOn, amount: fromMinor(t.amountMinor), currency: t.currency, counterparty: t.counterparty, description: t.description,
      })),
    };
  });
}
