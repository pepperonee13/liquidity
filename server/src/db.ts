import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { DEFAULT_CATEGORIES, DEFAULT_RULES } from './defaults.js';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read','write')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE connections (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    institution_name TEXT NOT NULL,
    institution_country TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','error','revoked')),
    external_session_id TEXT,
    state TEXT UNIQUE,
    valid_until TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    external_id TEXT,
    provider_uid TEXT,
    name TEXT NOT NULL,
    institution TEXT NOT NULL DEFAULT '',
    iban TEXT,
    currency TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'checking'
      CHECK (type IN ('checking','savings','credit','cash','investment','loan','other')),
    balance_minor INTEGER NOT NULL DEFAULT 0,
    balance_at TEXT,
    include_in_net_worth INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_accounts_external ON accounts(external_id);

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
    grp TEXT NOT NULL DEFAULT 'Other',
    essential INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE commitments (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('subscription','insurance','utility','loan','rent','tax','membership','other')),
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    cadence TEXT NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly','semiannual','yearly')),
    next_due_on TEXT,
    start_on TEXT,
    end_on TEXT,
    cancel_notice_days INTEGER,
    policy_number TEXT,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    match_pattern TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
    url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    booked_on TEXT NOT NULL,
    value_on TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    amount_base_minor INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    counterparty TEXT NOT NULL DEFAULT '',
    counterparty_iban TEXT,
    mcc TEXT,
    status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','pending')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    category_source TEXT CHECK (category_source IN ('rule','manual','transfer','commitment')),
    commitment_id INTEGER REFERENCES commitments(id) ON DELETE SET NULL,
    transfer_peer_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    notes TEXT,
    raw TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, external_id)
  );
  CREATE INDEX idx_tx_booked ON transactions(booked_on);
  CREATE INDEX idx_tx_category ON transactions(category_id, booked_on);
  CREATE INDEX idx_tx_account ON transactions(account_id, booked_on);

  CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 100,
    field TEXT NOT NULL DEFAULT 'any' CHECK (field IN ('any','counterparty','description','mcc')),
    match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','regex')),
    pattern TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','in','out')),
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE budgets (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL
  );

  CREATE TABLE fx_rates (
    day TEXT NOT NULL,
    currency TEXT NOT NULL,
    per_eur REAL NOT NULL,
    PRIMARY KEY (day, currency)
  );

  CREATE VIEW v_tx AS
    SELECT t.*, a.name AS account_name, c.name AS category_name, c.grp AS category_group,
           COALESCE(c.essential, 0) AS essential,
           COALESCE(c.kind, CASE WHEN t.amount_minor < 0 THEN 'expense' ELSE 'income' END) AS flow
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id;
  `,
];

export function openDb(file?: string): DB {
  let target = file;
  if (!target) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    target = path.join(config.dataDir, 'liquidity.db');
  }
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  if (current === 0) seed(db);
}

function seed(db: DB): void {
  const insCat = db.prepare('INSERT INTO categories (name, kind, grp, essential) VALUES (?, ?, ?, ?)');
  const ids = new Map<string, number>();
  for (const c of DEFAULT_CATEGORIES) {
    ids.set(c.name, Number(insCat.run(c.name, c.kind, c.group, c.essential ? 1 : 0).lastInsertRowid));
  }
  const insRule = db.prepare(
    `INSERT INTO rules (priority, field, match_type, pattern, direction, category_id, builtin)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const r of DEFAULT_RULES) {
    const cat = ids.get(r.category);
    if (!cat) throw new Error(`Default rule references unknown category ${r.category}`);
    for (const p of r.patterns) {
      insRule.run(r.priority ?? 500, r.field ?? 'any', r.regex ? 'regex' : 'contains', p, r.direction ?? 'any', cat);
    }
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('base_currency', 'HUF')").run();
}

export function getSetting(db: DB, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function baseCurrency(db: DB): string {
  return getSetting(db, 'base_currency') ?? 'HUF';
}
