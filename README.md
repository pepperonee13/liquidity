# Liquidity

A self-hosted personal finance hub: bank accounts synced over PSD2, automatic categorisation,
budgets, a register of recurring commitments (subscriptions, insurance policies, utilities,
loans), and an API documented for AI agents so one can help you find savings.

Your data stays in a single SQLite file on your own machine.

## What it does

- **Bank sync** through Enable Banking (Revolut, MBH and other European banks), a **CSV
  importer** for anything else, and manual accounts for cash, investments and debts.
  See [docs/BANK_SYNC.md](docs/BANK_SYNC.md) for setup and per-bank status.
- **Categorisation** with editable rules (starter set tuned for Hungarian merchants), MCC
  fallbacks, and automatic detection of transfers between your own accounts.
- **Multi-currency**: everything is also converted to a base currency (default HUF) at ECB rates.
- **Budgets** per category with pace projection.
- **Recurring**: detects repeating payments, tracks them with next due date, contract end,
  cancellation deadline and policy number, and links each payment.
- **Insights**: cashflow, net worth history, category trends, and rule-based savings leads
  (price rises, subscription load, renewal windows, bank fees, budgets at risk, idle cash).
- **Agent API**: OpenAPI spec at `/api/openapi.json`, a workflow guide at `/api/agent-guide`
  ([docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md)), and scoped tokens (read-only, or read and organise).

## Run it

```bash
cp .env.example .env
docker compose up -d --build      # http://localhost:3000
```

or without Docker (Node 22+):

```bash
npm install
npm run build
npm start                         # http://localhost:3000, data in ./data
```

On first visit you set a password. To look around before connecting real banks, go to
Accounts → Connect a bank → **Demo bank** and add the three demo institutions.

Development: `npm run dev` (API on :3000, UI with hot reload on :5173), `npm test`, `npm run typecheck`.

## Give an AI agent access

Settings → **AI agent access** → create a token. The page gives you a ready-to-paste
instruction containing the guide URL and the token. A `read` token can only call `GET`
endpoints; no token can touch bank consents, the password or other tokens.

The agent has to be able to reach the app, so for a cloud-hosted agent the app needs a public
HTTPS URL (set `PUBLIC_URL`); a local agent can use `http://localhost:3000`.

## Security notes

- The app binds to `127.0.0.1` by default and Docker publishes the port on localhost only.
  Put it behind HTTPS before exposing it beyond your machine.
- Bank access is read-only (account information only). Provider credentials live in
  environment variables / a mounted key file, not in the database.
- The SQLite file in the data volume contains your full transaction history. Back it up and
  protect it accordingly; it is not encrypted at rest.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | External origin; used for the bank redirect URL and secure cookies |
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Listen address |
| `DATA_DIR` | `./data` | Location of `liquidity.db` |
| `ENABLE_BANKING_APP_ID` | – | Enable Banking application id |
| `ENABLE_BANKING_PRIVATE_KEY_PATH` | – | Path to the application's private key (PEM) |
| `SYNC_INTERVAL_HOURS` | `6` | Automatic sync interval, `0` to disable |
| `DEMO_PROVIDER` | `1` | Set `0` to hide the demo bank |

## Layout

```
server/   Fastify + SQLite API (providers, sync, categorisation, insights)
web/      React UI
docs/     Bank setup and the agent guide served by the API
```
