import crypto from 'node:crypto';
import { getSetting, setSetting, type DB } from './db.js';

const SESSION_DAYS = 30;

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): string {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function isSetup(db: DB): boolean {
  return Boolean(getSetting(db, 'password_hash'));
}

export function setPassword(db: DB, password: string): void {
  setSetting(db, 'password_hash', hashPassword(password));
}

export function verifyPassword(db: DB, password: string): boolean {
  const stored = getSetting(db, 'password_hash');
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = hashPassword(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

export function createSession(db: DB): { token: string; maxAge: number } {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  db.prepare(`INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', '+${SESSION_DAYS} days'))`).run(
    sha256(token),
  );
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function sessionValid(db: DB, token: string | undefined): boolean {
  if (!token) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(sha256(token)),
  );
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyAllSessions(db: DB): void {
  db.prepare('DELETE FROM sessions').run();
}

export function createApiToken(db: DB, name: string, scope: 'read' | 'write') {
  const token = `lq_${crypto.randomBytes(24).toString('hex')}`;
  const prefix = token.slice(0, 9);
  const info = db
    .prepare('INSERT INTO api_tokens (name, token_hash, prefix, scope) VALUES (?, ?, ?, ?)')
    .run(name, sha256(token), prefix, scope);
  return { id: Number(info.lastInsertRowid), name, scope, prefix, token };
}

export function checkApiToken(db: DB, token: string): { id: number; scope: 'read' | 'write' } | null {
  const row = db.prepare('SELECT id, scope FROM api_tokens WHERE token_hash = ?').get(sha256(token)) as
    | { id: number; scope: 'read' | 'write' }
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

/** Tiny in-memory throttle for password attempts. */
export class LoginThrottle {
  private failures: number[] = [];
  constructor(private max = 8, private windowMs = 10 * 60 * 1000) {}
  blocked(): boolean {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= this.max;
  }
  fail(): void {
    this.failures.push(Date.now());
  }
  reset(): void {
    this.failures = [];
  }
}
