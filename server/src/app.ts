import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { checkApiToken, LoginThrottle, sessionValid } from './auth.js';
import { config } from './config.js';
import { openDb, type DB } from './db.js';
import { defaultProviders, type ProviderRegistry } from './providers/index.js';
import { authRoutes } from './routes/auth.js';
import { bankRoutes } from './routes/banks.js';
import { ledgerRoutes } from './routes/ledger.js';
import { planningRoutes } from './routes/planning.js';
import { insightRoutes } from './routes/insights.js';

export interface AppContext {
  db: DB;
  providers: ProviderRegistry;
  throttle: LoginThrottle;
  /** Connection ids with a sync currently running. */
  syncing: Set<number>;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth?: { kind: 'session' } | { kind: 'token'; scope: 'read' | 'write' };
  }
}

export const SESSION_COOKIE = 'lq_session';

/** Routes reachable without credentials. They expose no financial data. */
const PUBLIC = [
  /^\/api\/health$/,
  /^\/api\/auth\/(status|setup|login|logout)$/,
  /^\/api\/connections\/callback$/, // protected by the unguessable `state` value instead
  /^\/api\/openapi\.json$/,
  /^\/api\/agent-guide$/,
  /^\/api\/docs(\/|$)/,
];

/** Only a logged-in human may manage credentials and bank consents. */
const SESSION_ONLY = [/^\/api\/tokens/, /^\/api\/auth\//, /^\/api\/connections$/, /^\/api\/connections\/\d+\/reconnect$/];

export async function buildApp(opts: { db?: DB; providers?: ProviderRegistry; logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 25 * 1024 * 1024,
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: true, useDefaults: true } },
  });
  // Response schemas document the API; they are not used to filter output.
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  app.decorate('ctx', {
    db: opts.db ?? openDb(),
    providers: opts.providers ?? defaultProviders(),
    throttle: new LoginThrottle(),
    syncing: new Set<number>(),
  });

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Liquidity API',
        version: '0.1.0',
        description:
          'Personal finance hub: bank accounts, transactions, categories, budgets, recurring commitments ' +
          '(subscriptions, insurance, loans) and spending insights.\n\n' +
          '**Conventions**\n' +
          '- Amounts are decimal numbers in major units. Negative = money leaving an account, positive = money arriving.\n' +
          '- `amount` is in the transaction/account currency; fields ending in `_base` are converted to the base currency (see `GET /api/settings`) using ECB rates of the booking date.\n' +
          '- Insight endpoints report `spent`/`expenses` as positive numbers and exclude transfers between own accounts.\n' +
          '- Dates are `YYYY-MM-DD`, months are `YYYY-MM`.\n' +
          '- Authenticate with `Authorization: Bearer <token>`; tokens are created in Settings. `read` tokens may only call GET endpoints.\n' +
          '- A workflow guide for AI agents is served at `GET /api/agent-guide`.',
      },
      servers: [{ url: config.publicUrl }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
      tags: [
        { name: 'insights', description: 'Aggregated analytics. Start here for questions about spending and saving.' },
        { name: 'transactions', description: 'Individual money movements' },
        { name: 'accounts', description: 'Bank, cash and other accounts' },
        { name: 'categories', description: 'Categories and auto-categorisation rules' },
        { name: 'budgets', description: 'Monthly budgets per category (base currency)' },
        { name: 'commitments', description: 'Recurring obligations: subscriptions, insurance policies, utilities, loans, rent' },
        { name: 'banks', description: 'Bank connections and synchronisation' },
        { name: 'settings', description: 'Settings, authentication and API tokens' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (sessionValid(app.ctx.db, req.cookies[SESSION_COOKIE])) req.auth = { kind: 'session' };
    else {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const token = checkApiToken(app.ctx.db, header.slice(7).trim());
        if (token) req.auth = { kind: 'token', scope: token.scope };
      }
    }
    if (PUBLIC.some((re) => re.test(url))) return;
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized', message: 'Log in or send a valid Bearer token.' });
    if (req.auth.kind === 'token') {
      if (SESSION_ONLY.some((re) => re.test(url))) {
        return reply.code(403).send({ error: 'forbidden', message: 'This endpoint requires an interactive login.' });
      }
      if (req.auth.scope === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return reply.code(403).send({ error: 'forbidden', message: 'This token is read-only.' });
      }
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // Cookie-authenticated writes must come from our own pages (CSRF defence in depth on top of SameSite).
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host && origin !== config.publicUrl) {
        return reply.code(403).send({ error: 'forbidden', message: 'Cross-origin request rejected.' });
      }
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'validation', message: err.message });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (String(err.code ?? '').startsWith('SQLITE_CONSTRAINT')) {
      return reply.code(409).send({ error: 'conflict', message: 'That conflicts with existing data (duplicate or still referenced).' });
    }
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: 'internal', message: err.statusCode ? err.message : 'Internal error' });
  });

  app.get('/api/health', { schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/api/agent-guide', { schema: { hide: true } }, async (_req, reply) => {
    const file = [path.join(import.meta.dirname, '../../docs/AGENT_GUIDE.md'), path.join(import.meta.dirname, '../docs/AGENT_GUIDE.md')].find((f) => fs.existsSync(f));
    const text = file ? fs.readFileSync(file, 'utf8') : '# Liquidity agent guide\n\nSee /api/openapi.json.';
    return reply.type('text/markdown; charset=utf-8').send(text.replaceAll('{{BASE_URL}}', config.publicUrl));
  });

  await app.register(authRoutes);
  await app.register(bankRoutes);
  await app.register(ledgerRoutes);
  await app.register(planningRoutes);
  await app.register(insightRoutes);

  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'No such endpoint.' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found.' }));
  }

  return app;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found.`);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
