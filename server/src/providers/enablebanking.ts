import crypto from 'node:crypto';
import fs from 'node:fs';
import { SignJWT } from 'jose';
import { config } from '../config.js';
import { toMinor } from '../money.js';
import {
  ProviderError,
  type AccountType,
  type AuthResult,
  type BankProvider,
  type Institution,
  type ProviderAccount,
  type ProviderTransaction,
} from './types.js';

/** Enable Banking (https://enablebanking.com) – PSD2 account information for European banks. */

interface EbAmount { amount: string; currency: string }
interface EbParty { name?: string | null }
export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  merchant_category_code?: string | null;
  transaction_amount: EbAmount;
  creditor?: EbParty | null;
  debtor?: EbParty | null;
  creditor_account?: { iban?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  bank_transaction_code?: { description?: string | null } | null;
  credit_debit_indicator: 'CRDT' | 'DBIT';
  status: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  note?: string | null;
}
export interface EbAccount {
  uid: string;
  identification_hash?: string | null;
  account_id?: { iban?: string | null } | null;
  name?: string | null;
  details?: string | null;
  product?: string | null;
  cash_account_type?: string | null;
  currency: string;
}

const BALANCE_PREFERENCE = ['ITBD', 'CLBD', 'XPCD', 'ITAV', 'CLAV', 'OTHR'];

export function mapAccount(a: EbAccount, institution: string): ProviderAccount {
  const types: Record<string, AccountType> = { CACC: 'checking', SVGS: 'savings', CARD: 'credit', LOAN: 'loan', CASH: 'cash' };
  const iban = a.account_id?.iban ?? undefined;
  return {
    uid: a.uid,
    stableId: a.identification_hash ?? iban ?? a.uid,
    name: a.name || a.product || a.details || `${institution} ${a.currency}`,
    iban,
    currency: a.currency,
    type: types[a.cash_account_type ?? ''] ?? 'checking',
  };
}

export function mapTransaction(t: EbTransaction): ProviderTransaction | null {
  const status = t.status === 'BOOK' ? 'booked' : t.status === 'PDNG' || t.status === 'HOLD' ? 'pending' : null;
  const bookedOn = t.booking_date ?? t.value_date ?? t.transaction_date;
  if (!status || !bookedOn) return null;
  const outgoing = t.credit_debit_indicator === 'DBIT';
  const magnitude = Math.abs(toMinor(t.transaction_amount.amount));
  const counterparty = (outgoing ? t.creditor?.name : t.debtor?.name) ?? '';
  const description =
    (t.remittance_information ?? []).filter(Boolean).join(' ').trim() ||
    t.bank_transaction_code?.description ||
    t.note ||
    '';
  return {
    externalId: t.entry_reference || t.transaction_id || null,
    bookedOn: bookedOn.slice(0, 10),
    valueOn: t.value_date?.slice(0, 10) ?? null,
    amountMinor: outgoing ? -magnitude : magnitude,
    currency: t.transaction_amount.currency,
    description,
    counterparty,
    counterpartyIban: (outgoing ? t.creditor_account?.iban : t.debtor_account?.iban) ?? null,
    mcc: t.merchant_category_code ?? null,
    status,
    raw: t,
  };
}

export class EnableBankingProvider implements BankProvider {
  id = 'enablebanking';
  label = 'Enable Banking (PSD2)';
  setupHint =
    'Set ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY_PATH. See docs/BANK_SYNC.md for the registration steps.';
  private key?: crypto.KeyObject;
  private jwt?: { token: string; expires: number };

  constructor(
    private opts = config.enableBanking,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  configured(): boolean {
    return Boolean(this.opts.appId && (this.opts.privateKey || this.opts.privateKeyPath));
  }

  private async token(): Promise<string> {
    if (!this.configured()) throw new ProviderError('Enable Banking is not configured', 'config');
    if (this.jwt && this.jwt.expires > Date.now() + 60_000) return this.jwt.token;
    if (!this.key) {
      const pem = this.opts.privateKey
        ? this.opts.privateKey.replace(/\\n/g, '\n')
        : fs.readFileSync(this.opts.privateKeyPath, 'utf8');
      this.key = crypto.createPrivateKey(pem);
    }
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.opts.appId })
      .setIssuer('enablebanking.com')
      .setAudience('api.enablebanking.com')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.key);
    this.jwt = { token, expires: Date.now() + 3600_000 };
    return token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const code = String(json?.error ?? '');
      const message = `Enable Banking ${res.status}${code ? ` ${code}` : ''}: ${json?.message ?? text.slice(0, 200)}`;
      if (/EXPIRED_SESSION|REVOKED_SESSION|CLOSED_SESSION|SESSION_DOES_NOT_EXIST|INVALID_SESSION/.test(code)) {
        throw new ProviderError(message, 'expired');
      }
      if (res.status === 429 || /RATE_LIMIT/.test(code)) throw new ProviderError(message, 'rate_limited');
      throw new ProviderError(message);
    }
    return json as T;
  }

  async listInstitutions(country: string): Promise<Institution[]> {
    const data = await this.call<{ aspsps: any[] }>('GET', `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
    return data.aspsps
      .filter((a) => !a.sandbox)
      .map((a) => ({
        name: a.name,
        country: a.country,
        logo: a.logo,
        maxConsentSeconds: typeof a.maximum_consent_validity === 'number' ? a.maximum_consent_validity : undefined,
      }));
  }

  async startAuth(input: { institution: Institution; state: string; redirectUrl: string }): Promise<{ url: string }> {
    const maxSeconds = Math.min(input.institution.maxConsentSeconds ?? 90 * 86400, 180 * 86400);
    // Stay a minute under the bank's limit so clock skew cannot push us over it.
    const validUntil = new Date(Date.now() + (maxSeconds - 60) * 1000).toISOString();
    const data = await this.call<{ url: string }>('POST', '/auth', {
      access: { valid_until: validUntil },
      aspsp: { name: input.institution.name, country: input.institution.country },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: 'personal',
    });
    return { url: data.url };
  }

  async completeAuth(input: { code: string }): Promise<AuthResult> {
    const data = await this.call<{
      session_id: string;
      accounts: EbAccount[];
      aspsp: { name: string };
      access?: { valid_until?: string };
    }>('POST', '/sessions', { code: input.code });
    return {
      sessionId: data.session_id,
      validUntil: data.access?.valid_until ?? null,
      accounts: data.accounts.map((a) => mapAccount(a, data.aspsp?.name ?? 'Bank')),
    };
  }

  async getBalance(_sessionId: string, accountUid: string) {
    const data = await this.call<{ balances: { balance_amount: EbAmount; balance_type: string }[] }>(
      'GET',
      `/accounts/${accountUid}/balances`,
    );
    const sorted = [...(data.balances ?? [])].sort(
      (a, b) => rank(a.balance_type) - rank(b.balance_type),
    );
    const best = sorted[0];
    if (!best) return null;
    return { amountMinor: toMinor(best.balance_amount.amount), currency: best.balance_amount.currency };
  }

  async getTransactions(
    _sessionId: string,
    accountUid: string,
    range: { from: string; to: string; initial: boolean },
  ): Promise<ProviderTransaction[]> {
    const fetchAll = async (from: string, strategy?: string) => {
      const out: ProviderTransaction[] = [];
      let continuation: string | undefined;
      for (let page = 0; page < 200; page++) {
        const q = new URLSearchParams({ date_from: from, date_to: range.to });
        if (strategy) q.set('strategy', strategy);
        if (continuation) q.set('continuation_key', continuation);
        const data = await this.call<{ transactions: EbTransaction[]; continuation_key?: string | null }>(
          'GET',
          `/accounts/${accountUid}/transactions?${q}`,
        );
        for (const t of data.transactions ?? []) {
          const mapped = mapTransaction(t);
          if (mapped) out.push(mapped);
        }
        if (!data.continuation_key) break;
        continuation = data.continuation_key;
      }
      return out;
    };
    if (!range.initial) return fetchAll(range.from);
    try {
      return await fetchAll(range.from, 'longest');
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'bank_error') {
        // Many banks only serve ~90 days without a fresh strong authentication.
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 89);
        return fetchAll(d.toISOString().slice(0, 10));
      }
      throw err;
    }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.call('DELETE', `/sessions/${sessionId}`);
  }
}

function rank(type: string): number {
  const i = BALANCE_PREFERENCE.indexOf(type);
  return i < 0 ? BALANCE_PREFERENCE.length : i;
}
