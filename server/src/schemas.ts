import { Type as T, type TSchema } from '@sinclair/typebox';

export const Nullable = <S extends TSchema>(schema: S) => T.Union([schema, T.Null()]);
export const Day = T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date, YYYY-MM-DD' });
export const Month = T.String({ pattern: '^\\d{4}-\\d{2}$', description: 'Month, YYYY-MM' });
export const Currency = T.String({ minLength: 3, maxLength: 3, description: 'ISO 4217 code, e.g. HUF, EUR' });
export const IdParams = T.Object({ id: T.Integer() });
export const Ok = T.Object({ ok: T.Boolean() });
export const ErrorBody = T.Object({ error: T.String(), message: T.String() });

export const AccountType = T.Union(
  ['checking', 'savings', 'credit', 'cash', 'investment', 'loan', 'other'].map((v) => T.Literal(v)),
);

export const Account = T.Object({
  id: T.Integer(),
  name: T.String(),
  institution: T.String(),
  iban: Nullable(T.String()),
  currency: Currency,
  type: AccountType,
  balance: T.Number({ description: 'Current balance in the account currency' }),
  balance_base: T.Number({ description: 'Balance converted to the base currency' }),
  balance_at: Nullable(T.String({ description: 'When the balance was last refreshed (UTC)' })),
  include_in_net_worth: T.Boolean(),
  archived: T.Boolean(),
  connection_id: Nullable(T.Integer({ description: 'Bank connection feeding this account; null for manual accounts' })),
  source: T.String({ description: '"bank" when synced from a connection, otherwise "manual"' }),
  transactions: T.Integer(),
  last_transaction_on: Nullable(Day),
});

export const Transaction = T.Object({
  id: T.Integer(),
  account_id: T.Integer(),
  account_name: T.String(),
  booked_on: Day,
  amount: T.Number({ description: 'Signed amount in `currency`; negative = money out' }),
  currency: Currency,
  amount_base: T.Number({ description: 'Signed amount in the base currency' }),
  counterparty: T.String({ description: 'Merchant or other party' }),
  description: T.String(),
  status: T.Union([T.Literal('booked'), T.Literal('pending')]),
  category_id: Nullable(T.Integer()),
  category_name: Nullable(T.String()),
  category_source: Nullable(T.String({ description: 'How the category was set: rule, manual, transfer or commitment' })),
  flow: T.Union([T.Literal('expense'), T.Literal('income'), T.Literal('transfer')], {
    description: 'How the transaction counts in analytics. Transfers are ignored in income/expense totals.',
  }),
  commitment_id: Nullable(T.Integer()),
  transfer_peer_id: Nullable(T.Integer({ description: 'The matching transaction in another own account' })),
  mcc: Nullable(T.String({ description: 'Merchant category code for card payments' })),
  notes: Nullable(T.String()),
  source: T.String({ description: 'bank, csv or manual' }),
});

export const Category = T.Object({
  id: T.Integer(),
  name: T.String(),
  kind: T.Union([T.Literal('expense'), T.Literal('income'), T.Literal('transfer')]),
  group: T.String(),
  essential: T.Boolean({ description: 'Essential (needs) vs discretionary (wants)' }),
  transactions: T.Integer(),
});

export const Rule = T.Object({
  id: T.Integer(),
  priority: T.Integer({ description: 'Lower numbers are evaluated first; the first matching rule wins' }),
  field: T.Union([T.Literal('any'), T.Literal('counterparty'), T.Literal('description'), T.Literal('mcc')]),
  match_type: T.Union([T.Literal('contains'), T.Literal('regex')]),
  pattern: T.String({ description: 'Matched case- and accent-insensitively. "contains" must start at a word boundary.' }),
  direction: T.Union([T.Literal('any'), T.Literal('in'), T.Literal('out')]),
  category_id: T.Integer(),
  category_name: T.String(),
  builtin: T.Boolean(),
});

export const CommitmentKind = T.Union(
  ['subscription', 'insurance', 'utility', 'loan', 'rent', 'tax', 'membership', 'other'].map((v) => T.Literal(v)),
);
export const Cadence = T.Union(['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly'].map((v) => T.Literal(v)));
export const CommitmentStatus = T.Union(['active', 'paused', 'cancelled'].map((v) => T.Literal(v)));

export const CommitmentInput = T.Object({
  kind: CommitmentKind,
  name: T.String({ minLength: 1 }),
  provider: T.Optional(T.String({ description: 'Company providing the service or policy' })),
  amount: T.Number({ description: 'Cost per billing period, positive' }),
  currency: Currency,
  cadence: Cadence,
  next_due_on: T.Optional(Nullable(Day)),
  start_on: T.Optional(Nullable(Day)),
  end_on: T.Optional(Nullable(Day)),
  cancel_notice_days: T.Optional(Nullable(T.Integer({ minimum: 0 }))),
  policy_number: T.Optional(Nullable(T.String())),
  account_id: T.Optional(Nullable(T.Integer())),
  category_id: T.Optional(Nullable(T.Integer())),
  match_pattern: T.Optional(
    Nullable(T.String({ description: 'Text that identifies its payments in counterparty/description; matching transactions are linked automatically' })),
  ),
  status: T.Optional(CommitmentStatus),
  url: T.Optional(Nullable(T.String())),
  notes: T.Optional(Nullable(T.String())),
});

export const Commitment = T.Object({
  id: T.Integer(),
  kind: CommitmentKind,
  name: T.String(),
  provider: T.String(),
  amount: T.Number(),
  currency: Currency,
  cadence: Cadence,
  amount_base: T.Number(),
  monthly_cost_base: T.Number({ description: 'Cost normalised to one month, base currency' }),
  yearly_cost_base: T.Number(),
  next_due_on: Nullable(Day),
  days_until_due: Nullable(T.Integer()),
  start_on: Nullable(Day),
  end_on: Nullable(T.String({ description: 'Contract end / renewal anniversary' })),
  cancel_notice_days: Nullable(T.Integer()),
  cancel_by: Nullable(T.String({ description: 'Last day to cancel before renewal (end_on minus notice)' })),
  policy_number: Nullable(T.String()),
  account_id: Nullable(T.Integer()),
  account_name: Nullable(T.String()),
  category_id: Nullable(T.Integer()),
  category_name: Nullable(T.String()),
  match_pattern: Nullable(T.String()),
  status: CommitmentStatus,
  url: Nullable(T.String()),
  notes: Nullable(T.String()),
  last_paid_on: Nullable(Day),
  payments: T.Integer({ description: 'Number of linked transactions' }),
  paid_last_12_months_base: T.Number(),
});

export const RecurringCandidate = T.Object({
  key: T.String(),
  name: T.String(),
  cadence: Cadence,
  amount: T.Number(),
  currency: Currency,
  amount_type: T.Union([T.Literal('fixed'), T.Literal('variable')]),
  occurrences: T.Integer(),
  first_on: Day,
  last_on: Day,
  next_expected_on: Day,
  yearly_cost_base: T.Number(),
  suggested_kind: T.String(),
  category_id: Nullable(T.Integer()),
  category_name: Nullable(T.String()),
  price_change: T.Number({ description: 'Latest amount divided by the first amount in the series' }),
  suggested_match_pattern: T.String(),
  transaction_ids: T.Array(T.Integer()),
});

export const Totals = T.Object({
  income: T.Number(),
  expenses: T.Number({ description: 'Positive number' }),
  net: T.Number(),
  savings_rate: Nullable(T.Number({ description: 'net / income, 0..1' })),
});
