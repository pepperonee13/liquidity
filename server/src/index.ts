import { buildApp } from './app.js';
import { config } from './config.js';
import { syncFxRates } from './fx.js';
import { syncAll } from './sync.js';

const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: config.host });

void syncFxRates(app.ctx.db).then((r) => r.error && app.log.warn(`FX rates not refreshed: ${r.error}`));

if (config.syncIntervalHours > 0) {
  // PSD2 allows roughly four unattended refreshes per account per day, hence the 6 h default.
  setInterval(() => {
    syncAll(app.ctx.db, app.ctx.providers)
      .then((results) => app.log.info({ results }, 'scheduled bank sync finished'))
      .catch((err) => app.log.error(err, 'scheduled bank sync failed'));
  }, config.syncIntervalHours * 3600_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
