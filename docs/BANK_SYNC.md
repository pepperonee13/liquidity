# Connecting your banks

Liquidity reads bank data through a licensed PSD2 account-information provider. You approve
read-only access at your bank; Liquidity never sees your bank credentials and cannot move money.

## Provider: Enable Banking

[Enable Banking](https://enablebanking.com) is used because it lets an individual link their
**own** accounts free of charge ("restricted production" mode), without a company contract.

| Bank | Status |
| --- | --- |
| MBH Bank (incl. former Budapest Bank, MKB, Takarékbank) | Listed in Enable Banking's Hungary coverage. MBH still runs three separate APIs for the merged banks, so pick the entry that matches where your account came from. |
| Revolut | Covered by Enable Banking. Look for it under your Revolut account's country. Each currency pocket appears as its own account. |
| Erste Bank Hungary | **Not confirmed.** It was not in Enable Banking's published Hungary list when this was written. The bank list in the app comes live from the provider, so check there first. If it is missing, use CSV import (below). |

### One-time setup

1. Create an account at <https://enablebanking.com> and open the Control Panel.
2. Register a new application, environment **Production**.
   - Redirect URL: `<PUBLIC_URL>/api/connections/callback` (the exact value is shown in the app
     under Accounts → Connect a bank).
   - Let the browser generate the key pair and download the private key (`.pem`), or upload
     your own public certificate.
3. Activate the application with **"Activate by linking accounts"** and link each of your bank
   accounts there. A restricted application can only read accounts linked this way.
4. Put the key and application id where Liquidity can read them:

   ```
   secrets/enablebanking.pem          # the private key
   .env:
     ENABLE_BANKING_APP_ID=<application id>
     ENABLE_BANKING_PRIVATE_KEY_PATH=/secrets/enablebanking.pem
   ```

5. Restart, then Accounts → **Connect a bank** → pick the bank → approve at the bank.

Things that were not verified here, because they need your Enable Banking account:

- Whether a plain `http://localhost` redirect URL is accepted for a production application.
  Third-party guides say HTTPS on your own domain is expected. If it is refused, serve Liquidity
  over HTTPS (a reverse proxy such as Caddy, or a Tailscale/Cloudflare tunnel) and set `PUBLIC_URL`.
- The live flow against your three banks. The client is tested against the documented API with
  a mocked server, not against real bank sessions.

### How syncing behaves

- The first sync asks for as much history as the bank will give (often 90 days to 2 years).
- Afterwards the app syncs every `SYNC_INTERVAL_HOURS` (default 6). PSD2 limits unattended
  refreshes to roughly four per day per account.
- Bank consent expires (typically after 90–180 days). The connection then shows **expired**;
  press **Renew consent**. History, categories and rules are kept.
- Pending card payments are shown greyed out and replaced when they are booked.

## Fallback: CSV import

Works for any bank and is the way to backfill older history.

1. Accounts → **Add manual account** (or use an existing account) → **Import CSV**.
2. Choose the statement exported from your netbank. Columns are detected from English and
   Hungarian headers (`Könyvelés dátuma`, `Összeg`, `Partner neve`, `Közlemény`, `Terhelés` /
   `Jóváírás`, …) and can be corrected in the preview. Windows-1250 files are handled.
3. Importing overlapping periods again is safe: rows already imported are skipped.

Notes: Revolut's CSV export works as is. Erste and MBH netbank export formats vary by
product; if only XLSX is offered, save it as CSV first. If the same account is later connected
through the bank API and has the same IBAN and currency, the connection attaches to the
existing account, but API rows and earlier CSV rows for the same period are not de-duplicated
against each other, so avoid importing CSV for dates the API already covers.

## Adding another provider

Implement `BankProvider` (`server/src/providers/types.ts`) and register it in
`server/src/providers/index.ts`. The demo bank (`demo.ts`) is a compact example.
