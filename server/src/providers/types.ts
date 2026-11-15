export interface Institution {
  name: string;
  country: string;
  logo?: string;
  /** Maximum consent lifetime in seconds, if the bank publishes one. */
  maxConsentSeconds?: number;
}

export type AccountType = 'checking' | 'savings' | 'credit' | 'cash' | 'investment' | 'loan' | 'other';

export interface ProviderAccount {
  /** Identifier used for API calls in this session. May change on re-authorisation. */
  uid: string;
  /** Identifier that stays the same across re-authorisations (used to re-attach history). */
  stableId: string;
  name: string;
  iban?: string;
  currency: string;
  type: AccountType;
}

export interface ProviderTransaction {
  externalId: string | null;
  bookedOn: string;
  valueOn?: string | null;
  /** Signed: negative is money leaving the account. */
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string;
  counterpartyIban?: string | null;
  mcc?: string | null;
  status: 'booked' | 'pending';
  raw?: unknown;
}

export interface AuthResult {
  sessionId: string;
  validUntil: string | null;
  accounts: ProviderAccount[];
}

export interface BankProvider {
  id: string;
  label: string;
  /** Whether credentials are present; unconfigured providers are listed but cannot connect. */
  configured(): boolean;
  setupHint?: string;
  listInstitutions(country: string): Promise<Institution[]>;
  startAuth(input: { institution: Institution; state: string; redirectUrl: string }): Promise<{ url: string }>;
  completeAuth(input: { code: string }): Promise<AuthResult>;
  getBalance(sessionId: string, accountUid: string): Promise<{ amountMinor: number; currency: string } | null>;
  getTransactions(
    sessionId: string,
    accountUid: string,
    range: { from: string; to: string; initial: boolean },
  ): Promise<ProviderTransaction[]>;
  revoke(sessionId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public code: 'expired' | 'rate_limited' | 'bank_error' | 'config' = 'bank_error',
  ) {
    super(message);
  }
}
