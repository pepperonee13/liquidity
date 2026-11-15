# Liquidity – guide for AI agents

You are helping one person understand and improve their personal finances. This API is their
finance hub: bank accounts synced over PSD2, categorised transactions, budgets, and recurring
commitments (subscriptions, insurance policies, utilities, loans, rent).

- Base URL: `{{BASE_URL}}`
- Machine-readable reference: `GET {{BASE_URL}}/api/openapi.json` (OpenAPI 3; browsable at `/api/docs`)
- Auth: send `Authorization: Bearer <token>`. A `read` token can call every `GET`; a `write`
  token can also change categories, rules, budgets and commitments. Tokens can never manage
  bank consents, passwords or other tokens.

## Conventions

| Topic | Rule |
| --- | --- |
| Amounts | Decimal major units. In transactions, negative = money out, positive = money in. |
| Currencies | `amount` is in the row's own `currency`. Fields ending in `_base` are converted to the base currency (`GET /api/settings`) at the ECB rate of the booking date. Compare and sum `_base` fields only. |
| Insights | `spent` / `expenses` are positive. Refunds are netted against spending. Transfers between the user's own accounts (`flow = "transfer"`) are excluded. |
| Dates | `YYYY-MM-DD`; months `YYYY-MM`. The current month is incomplete: compare complete months when judging trends. |
| Paging | `GET /api/transactions` returns `total`; page with `limit` (max 1000) and `offset`. |
| Errors | JSON `{ "error": code, "message": text }` with a 4xx/5xx status. |

## Where to start

1. `GET /api/insights/overview` – net worth, this month's income and spending by category,
   budgets, bills due in the next 30 days.
2. `GET /api/insights/cashflow?months=12` – income, expenses and savings rate per month.
3. `GET /api/insights/savings-opportunities` – rule-based leads. Verify each one against the
   underlying data before presenting it; they are heuristics, not conclusions.

## Recipes

**"Where does my money go?"**
`GET /api/insights/spending?from=…&to=…&group_by=category`, then drill into a category with
`group_by=counterparty&category_id=…`, then list the rows with
`GET /api/transactions?category_id=…&from=…&to=…&sort=amount_desc`.

**"What changed recently?"**
`GET /api/insights/category-trends?months=6` gives a category × month matrix.

**"What am I paying for every month?"**
`GET /api/commitments` lists what is tracked, with monthly and yearly cost, next due date,
contract end and cancellation deadline (`cancel_by`). `GET /api/insights/recurring` lists
repeating payments found in the transactions that are not tracked yet, including
`price_change` (latest price ÷ first price).

**Track a detected recurring payment** (write token)
`POST /api/commitments` with `name`, `kind`, `amount`, `currency`, `cadence` and
`match_pattern` set to the candidate's `suggested_match_pattern`. Existing and future payments
are linked automatically and `next_due_on` follows the latest payment.

**Record an insurance policy** (write token)
`POST /api/commitments` with `kind: "insurance"`, `provider`, `policy_number`, `end_on`
(renewal anniversary) and `cancel_notice_days`. The API then exposes `cancel_by` and reports a
`renewal_window` opportunity 60 days ahead.

**Clean up categories** (write token)
`GET /api/transactions?uncategorized=true&sort=amount_desc` → find merchants that repeat →
`POST /api/rules` `{ "pattern": "merchant name", "category_id": N }`. The rule is applied to
existing transactions immediately (`recategorized` in the response) and to everything synced
later. For one-offs use `PATCH /api/transactions/{id}` or `POST /api/transactions/bulk-categorize`.
Categories set by hand are never overwritten by rules.

**Propose a budget**
Use `monthly_average` from `GET /api/insights/category-trends?months=6` per category as the
baseline, check `essential` to separate needs from wants, then (with consent, write token)
`PUT /api/budgets/{category_id}` `{ "amount": N }` in base currency. Track with `GET /api/budgets`.

## Caveats to keep in mind

- Categorisation is rule-based and can be wrong; check `category_source` (`rule` vs `manual`)
  and look at the raw `counterparty` / `description` when a number looks surprising.
- `status: "pending"` transactions may still change or disappear.
- Net worth history is reconstructed from current balances and transactions, so it is only
  as deep as each account's transaction history.
- Banks allow about four unattended refreshes per day. Do not call `POST /api/sync` repeatedly.
- Ask before writing. Creating rules, budgets and commitments changes what the user sees.
