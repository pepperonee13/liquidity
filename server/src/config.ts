import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  /** Externally reachable origin of this app; used to build the bank redirect URL. */
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
  webDist: path.resolve(env.WEB_DIST ?? path.join(import.meta.dirname, '../../web/dist')),
  syncIntervalHours: Number(env.SYNC_INTERVAL_HOURS ?? 6),
  enableBanking: {
    appId: env.ENABLE_BANKING_APP_ID ?? '',
    privateKeyPath: env.ENABLE_BANKING_PRIVATE_KEY_PATH ?? '',
    privateKey: env.ENABLE_BANKING_PRIVATE_KEY ?? '',
    baseUrl: env.ENABLE_BANKING_BASE_URL ?? 'https://api.enablebanking.com',
  },
  demoProvider: env.DEMO_PROVIDER !== '0',
  fxUrl: env.FX_URL ?? 'https://api.frankfurter.dev/v1',
};

export function redirectUrl(): string {
  return `${config.publicUrl}/api/connections/callback`;
}
