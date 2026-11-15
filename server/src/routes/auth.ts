import { Type as T, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { badRequest, HttpError, SESSION_COOKIE } from '../app.js';
import {
  createApiToken, createSession, destroyAllSessions, destroySession, isSetup, setPassword, verifyPassword,
} from '../auth.js';
import { config } from '../config.js';
import { IdParams, Nullable, Ok } from '../schemas.js';

const Password = T.Object({ password: T.String({ minLength: 8, maxLength: 200 }) });
const TokenInfo = T.Object({
  id: T.Integer(),
  name: T.String(),
  scope: T.Union([T.Literal('read'), T.Literal('write')]),
  prefix: T.String(),
  created_at: T.String(),
  last_used_at: Nullable(T.String()),
});

export async function authRoutes(app: FastifyInstance) {
  const { db, throttle } = app.ctx;
  const tags = ['settings'];
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.publicUrl.startsWith('https://') };

  const login = (reply: any) => {
    const s = createSession(db);
    reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts, maxAge: s.maxAge });
  };

  app.get('/api/auth/status', {
    schema: { tags, summary: 'Whether a password has been set and whether this request is authenticated', security: [],
      response: { 200: T.Object({ setup_required: T.Boolean(), authenticated: T.Boolean() }) } },
  }, async (req) => ({ setup_required: !isSetup(db), authenticated: Boolean(req.auth) }));

  app.post('/api/auth/setup', {
    schema: { tags, summary: 'Set the password on first run', security: [], body: Password, response: { 200: Ok } },
  }, async (req, reply) => {
    if (isSetup(db)) throw new HttpError(409, 'conflict', 'A password is already set.');
    setPassword(db, (req.body as Static<typeof Password>).password);
    login(reply);
    return { ok: true };
  });

  app.post('/api/auth/login', {
    schema: { tags, summary: 'Log in with the password (sets a session cookie)', security: [],
      body: T.Object({ password: T.String() }), response: { 200: Ok } },
  }, async (req, reply) => {
    if (throttle.blocked()) throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts. Try again in a few minutes.');
    if (!verifyPassword(db, (req.body as { password: string }).password)) {
      throttle.fail();
      throw new HttpError(401, 'unauthorized', 'Wrong password.');
    }
    throttle.reset();
    login(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', { schema: { tags, summary: 'Log out', security: [], response: { 200: Ok } } }, async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.post('/api/auth/password', {
    schema: { tags, summary: 'Change the password (logs out other sessions)',
      body: T.Object({ current: T.String(), password: T.String({ minLength: 8, maxLength: 200 }) }), response: { 200: Ok } },
  }, async (req, reply) => {
    const body = req.body as { current: string; password: string };
    if (!verifyPassword(db, body.current)) throw badRequest('Current password is wrong.');
    setPassword(db, body.password);
    destroyAllSessions(db);
    login(reply);
    return { ok: true };
  });

  app.get('/api/tokens', { schema: { tags, summary: 'List API tokens', response: { 200: T.Array(TokenInfo) } } }, async () =>
    db.prepare('SELECT id, name, scope, prefix, created_at, last_used_at FROM api_tokens ORDER BY id DESC').all(),
  );

  const NewToken = T.Object({
    name: T.String({ minLength: 1, maxLength: 80 }),
    scope: T.Union([T.Literal('read'), T.Literal('write')], { default: 'read' }),
  });
  app.post('/api/tokens', {
    schema: { tags, summary: 'Create an API token. The secret is returned once.', body: NewToken,
      response: { 200: T.Object({ id: T.Integer(), name: T.String(), scope: T.String(), prefix: T.String(), token: T.String() }) } },
  }, async (req) => {
    const body = req.body as Static<typeof NewToken>;
    return createApiToken(db, body.name, body.scope);
  });

  app.delete('/api/tokens/:id', { schema: { tags, summary: 'Revoke an API token', params: IdParams, response: { 200: Ok } } }, async (req) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ?').run((req.params as { id: number }).id);
    return { ok: true };
  });
}
