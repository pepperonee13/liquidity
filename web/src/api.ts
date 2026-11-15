export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('lq:unauthorized'));
    throw new ApiError(res.status, (data as { message?: string })?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export interface Account {
  id: number; name: string; institution: string; iban: string | null; currency: string; type: string;
  balance: number; balance_base: number; balance_at: string | null; include_in_net_worth: boolean; archived: boolean;
  connection_id: number | null; source: string; transactions: number; last_transaction_on: string | null;
}
export interface Transaction {
  id: number; account_id: number; account_name: string; booked_on: string; amount: number; currency: string; amount_base: number;
  counterparty: string; description: string; status: 'booked' | 'pending'; category_id: number | null; category_name: string | null;
  category_source: string | null; flow: 'expense' | 'income' | 'transfer'; commitment_id: number | null; notes: string | null; source: string;
}
export interface TransactionList { total: number; sum_base: number; base_currency: string; items: Transaction[] }
export interface Category { id: number; name: string; kind: 'expense' | 'income' | 'transfer'; group: string; essential: boolean; transactions: number }
export interface Rule { id: number; priority: number; field: string; match_type: string; pattern: string; direction: string; category_id: number; category_name: string; builtin: boolean }
export interface Totals { income: number; expenses: number; net: number; savings_rate: number | null }
export interface Overview {
  base_currency: string; month: string; net_worth: number;
  accounts: { id: number; name: string; institution: string; type: string; currency: string; balance: number; balance_base: number }[];
  totals: Totals; previous_month_totals: Totals;
  categories: { category_id: number | null; category: string; category_group: string; spent: number; previous_month_spent: number; budget: number | null; transactions: number }[];
  daily_spending: { day: string; spent: number }[]; previous_month_daily_spending: { day: string; spent: number }[];
  uncategorized_transactions: number; commitments_monthly_total: number;
  upcoming_commitments: { id: number; name: string; kind: string; amount: number; currency: string; amount_base: number; next_due_on: string | null; days_until_due: number | null }[];
}
export interface Budget { category_id: number; category: string; category_group: string; amount: number; spent: number; remaining: number; used_ratio: number | null; projected: number; status: 'on_track' | 'at_risk' | 'over' }
export interface Commitment {
  id: number; kind: string; name: string; provider: string; amount: number; currency: string; cadence: string; amount_base: number;
  monthly_cost_base: number; yearly_cost_base: number; next_due_on: string | null; days_until_due: number | null; start_on: string | null;
  end_on: string | null; cancel_notice_days: number | null; cancel_by: string | null; policy_number: string | null; account_id: number | null;
  category_id: number | null; category_name: string | null; match_pattern: string | null; status: string; url: string | null; notes: string | null;
  last_paid_on: string | null; payments: number; paid_last_12_months_base: number;
}
export interface CommitmentList { base_currency: string; monthly_total_base: number; yearly_total_base: number; commitments: Commitment[] }
export interface Candidate {
  key: string; name: string; cadence: string; amount: number; currency: string; amount_type: string; occurrences: number; last_on: string;
  next_expected_on: string; yearly_cost_base: number; suggested_kind: string; category_id: number | null; category_name: string | null;
  price_change: number; suggested_match_pattern: string;
}
export interface Opportunity { type: string; title: string; detail: string; estimated_yearly_saving: number | null; related: Record<string, unknown> }
export interface Connection { id: number; provider: string; institution_name: string; status: string; valid_until: string | null; last_synced_at: string | null; last_error: string | null; syncing: boolean; accounts: number }
export interface Provider { id: string; label: string; configured: boolean; setup_hint: string | null; redirect_url: string }
export interface ApiToken { id: number; name: string; scope: string; prefix: string; created_at: string; last_used_at: string | null }
