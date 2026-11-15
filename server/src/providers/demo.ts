import { addDays, addMonths, today } from '../money.js';
import type { AuthResult, BankProvider, Institution, ProviderAccount, ProviderTransaction } from './types.js';

/**
 * A fake bank that produces realistic, deterministic sample data so the app can be
 * explored (and tested) without real credentials. Clearly labelled as demo data in the UI.
 */

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSTITUTIONS: Institution[] = [
  { name: 'Demo Revolut', country: 'HU' },
  { name: 'Demo Erste Bank Hungary', country: 'HU' },
  { name: 'Demo MBH Bank', country: 'HU' },
];

const ACCOUNTS: Record<string, (ProviderAccount & { balance: number })[]> = {
  'Demo Revolut': [
    { uid: 'demo-rev-huf', stableId: 'demo-rev-huf', name: 'Revolut HUF', currency: 'HUF', type: 'checking', balance: 184_320 },
    { uid: 'demo-rev-eur', stableId: 'demo-rev-eur', name: 'Revolut EUR', currency: 'EUR', type: 'checking', balance: 612.4 },
  ],
  'Demo Erste Bank Hungary': [
    { uid: 'demo-erste-huf', stableId: 'demo-erste-huf', name: 'Erste folyószámla', iban: 'HU42116000060000000012345678', currency: 'HUF', type: 'checking', balance: 742_150 },
    { uid: 'demo-erste-sav', stableId: 'demo-erste-sav', name: 'Erste megtakarítás', iban: 'HU42116000060000000087654321', currency: 'HUF', type: 'savings', balance: 2_350_000 },
  ],
  'Demo MBH Bank': [
    { uid: 'demo-mbh-huf', stableId: 'demo-mbh-huf', name: 'MBH számla', iban: 'HU93101000000000000011223344', currency: 'HUF', type: 'checking', balance: 96_480 },
  ],
};

type Draft = Omit<ProviderTransaction, 'externalId' | 'status' | 'currency'>;

function tx(day: string, amount: number, counterparty: string, description = '', mcc?: string): Draft {
  return { bookedOn: day, amountMinor: Math.round(amount * 100), counterparty, description, mcc: mcc ?? null };
}

function dayIn(month: string, dom: number): string {
  const last = Number(addDays(addMonths(`${month}-01`, 1), -1).slice(8));
  return `${month}-${String(Math.min(dom, last)).padStart(2, '0')}`;
}

function generate(uid: string, from: string, to: string): Draft[] {
  const out: Draft[] = [];
  const firstMonth = from.slice(0, 7);
  for (let m = firstMonth; m <= to.slice(0, 7); m = addMonths(`${m}-01`, 1).slice(0, 7)) {
    const r = rng(`${uid}:${m}`);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const between = (lo: number, hi: number, step = 10) => Math.round((lo + r() * (hi - lo)) / step) * step;
    // Prices creep up over time so that trends and price-rise insights have something to show.
    const monthsAgo = (Date.parse(`${today().slice(0, 7)}-01`) - Date.parse(`${m}-01`)) / (86400000 * 30.4);
    const recent = monthsAgo < 4.5;

    if (uid === 'demo-erste-huf') {
      out.push(tx(dayIn(m, 5), 785_000, 'ACME Software Kft.', 'Munkabér'));
      out.push(tx(dayIn(m, 6), -220_000, 'Kovács Péter', 'Lakbér bérleti díj'));
      out.push(tx(dayIn(m, 6), -150_000, 'Revolut', 'Top-up Revolut'));
      out.push(tx(dayIn(m, 7), -50_000, 'Saját megtakarítás', 'Megtakarítás átvezetés'));
      out.push(tx(dayIn(m, 12), -between(14_000, 38_000), 'MVM Next Energiakereskedelmi Zrt.', 'Áram és gáz számla'));
      out.push(tx(dayIn(m, 14), -between(5_200, 7_400), 'Fővárosi Vízművek Zrt.', 'Vízdíj'));
      out.push(tx(dayIn(m, 15), recent ? -9_990 : -8_490, 'Magyar Telekom Nyrt.', 'Otthoni internet és TV'));
      out.push(tx(dayIn(m, 15), -6_500, 'Yettel Magyarország Zrt.', 'Mobil előfizetés'));
      out.push(tx(dayIn(m, 18), -18_500, 'Társasház Közös Képviselet', 'Közös költség'));
      out.push(tx(dayIn(m, 20), -7_840, 'Generali Biztosító Zrt.', 'Lakásbiztosítás díj'));
      out.push(tx(dayIn(m, 28), -1_985, 'Erste Bank', 'Számlavezetési díj csomagdíj'));
      if (m.endsWith('-03')) out.push(tx(dayIn(m, 9), -64_300, 'Allianz Hungária Zrt.', 'Életbiztosítás éves díj'));
      for (let i = 0; i < 3; i++) {
        out.push(tx(dayIn(m, 2 + Math.floor(r() * 26)), -between(6_000, 24_000), pick(['SPAR Magyarország', 'TESCO Expressz', 'ALDI 112 Budapest']), 'Kártyás vásárlás', '5411'));
      }
      if (r() < 0.5) out.push(tx(dayIn(m, 10 + Math.floor(r() * 15)), -between(20_000, 60_000, 1000), 'ATM Budapest Erste', 'Készpénzfelvétel', '6011'));
    }

    if (uid === 'demo-erste-sav') {
      out.push(tx(dayIn(m, 7), 50_000, 'Saját számla', 'Megtakarítás átvezetés'));
      if (m.endsWith('-12')) out.push(tx(dayIn(m, 31), 41_200, 'Erste Bank', 'Kamat jóváírás'));
    }

    if (uid === 'demo-mbh-huf') {
      out.push(tx(dayIn(m, 8), 120_000, 'ACME Software Kft.', 'Cafeteria és bónusz munkabér'));
      out.push(tx(dayIn(m, 10), -68_400, 'MBH Bank Nyrt.', 'Személyi kölcsön törlesztés'));
      out.push(tx(dayIn(m, 11), -1_490, 'MBH Bank Nyrt.', 'Számlavezetési díj'));
      if (['-02', '-05', '-08', '-11'].some((s) => m.endsWith(s))) {
        out.push(tx(dayIn(m, 16), -21_600, 'Groupama Biztosító Zrt.', 'KGFB kötelező biztosítás negyedéves díj'));
      }
      if (m.endsWith('-06')) out.push(tx(dayIn(m, 3), -98_000, 'Uniqa Biztosító Zrt.', 'Casco éves díj'));
      for (let i = 0; i < 2; i++) {
        out.push(tx(dayIn(m, 3 + Math.floor(r() * 24)), -between(14_000, 26_000), pick(['MOL töltőállomás', 'SHELL Hungary', 'OMV 4412']), 'Üzemanyag', '5541'));
      }
      if (r() < 0.35) out.push(tx(dayIn(m, 20), -between(8_000, 30_000), 'Budapest Parkolás', 'Parkolás', '7523'));
    }

    if (uid === 'demo-rev-huf') {
      out.push(tx(dayIn(m, 6), 150_000, 'Erste Bank', 'Top-up'));
      out.push(tx(dayIn(m, 3), recent ? -4_990 : -4_490, 'Netflix.com', 'NETFLIX.COM', '4899'));
      out.push(tx(dayIn(m, 9), -1_990, 'Spotify AB', 'Spotify Premium', '5815'));
      out.push(tx(dayIn(m, 11), -3_490, 'HBO Max', 'HBO MAX Help.max.com', '4899'));
      out.push(tx(dayIn(m, 17), -990, 'Apple', 'APPLE.COM/BILL iCloud', '5818'));
      out.push(tx(dayIn(m, 2), -2_990, 'Revolut', 'Premium plan fee'));
      out.push(tx(dayIn(m, 4), -16_900, 'All You Can Move', 'AYCM SportPass', '7997'));
      out.push(tx(dayIn(m, 1), -9_500, 'BKK Zrt.', 'BudapestGO havi bérlet', '4111'));
      const groceries = 5 + Math.floor(r() * 4);
      for (let i = 0; i < groceries; i++) {
        out.push(tx(dayIn(m, 1 + Math.floor(r() * 28)), -between(2_500, 16_000), pick(['Lidl Magyarország', 'ALDI 045', 'SPAR Market', 'Kifli.hu', 'Auchan Budaörs']), 'Card payment', '5411'));
      }
      const dining = 4 + Math.floor(r() * (recent ? 9 : 5));
      for (let i = 0; i < dining; i++) {
        out.push(tx(dayIn(m, 1 + Math.floor(r() * 28)), -between(2_800, 13_500), pick(['Wolt', 'Foodora', 'Bolt Food', "McDonald's", 'Starbucks', 'Bors Gasztrobár', 'Mazel Tov étterem']), 'Card payment', '5812'));
      }
      for (let i = 0; i < 2; i++) {
        out.push(tx(dayIn(m, 2 + Math.floor(r() * 26)), -between(1_800, 5_400), 'Bolt.eu', 'Bolt ride', '4121'));
      }
      if (r() < 0.8) out.push(tx(dayIn(m, 8 + Math.floor(r() * 18)), -between(4_000, 15_000), pick(['Rossmann', 'DM-drogerie markt']), 'Card payment', '5912'));
      if (r() < 0.7) out.push(tx(dayIn(m, 5 + Math.floor(r() * 20)), -between(8_000, 45_000), pick(['H&M', 'Zara', 'Decathlon', 'IKEA Budapest', 'Alza.hu', 'eMAG', 'Libri Könyvesbolt']), 'Card payment', '5311'));
      if (r() < 0.4) out.push(tx(dayIn(m, 13 + Math.floor(r() * 12)), -between(3_000, 9_000), pick(['Cinema City', 'Jegy.hu']), 'Card payment', '7832'));
      if (r() < 0.3) out.push(tx(dayIn(m, 21), -between(3_500, 12_000), 'BENU Gyógyszertár', 'Card payment', '5912'));
      if (m.endsWith('-07') || m.endsWith('-12')) out.push(tx(dayIn(m, 14), -40_000, 'Revolut', 'Exchanged to EUR'));
      if (m.endsWith('-01')) out.push(tx(dayIn(m, 22), -23_988, 'Adobe Systems', 'Adobe Photography plan annual', '5734'));
    }

    if (uid === 'demo-rev-eur') {
      if (m.endsWith('-07') || m.endsWith('-12')) {
        out.push(tx(dayIn(m, 14), 101.3, 'Revolut', 'Exchanged from HUF'));
        out.push(tx(dayIn(m, 19), -between(60, 240, 1), pick(['Booking.com', 'Airbnb', 'Ryanair']), 'Card payment', '7011'));
        out.push(tx(dayIn(m, 20), -between(15, 60, 1), 'Trattoria Da Marco', 'Card payment', '5812'));
      }
      out.push(tx(dayIn(m, 23), -10, 'GitHub', 'GitHub Copilot', '5734'));
      if (r() < 0.3) out.push(tx(dayIn(m, 12), -between(12, 55, 1), 'Amazon.de', 'Card payment', '5942'));
    }
  }
  return out.filter((t) => t.bookedOn >= from && t.bookedOn <= to).sort((a, b) => a.bookedOn.localeCompare(b.bookedOn));
}

export class DemoProvider implements BankProvider {
  id = 'demo';
  label = 'Demo bank (sample data)';

  configured(): boolean {
    return true;
  }

  async listInstitutions(): Promise<Institution[]> {
    return INSTITUTIONS;
  }

  async startAuth(input: { institution: Institution; state: string; redirectUrl: string }) {
    const q = new URLSearchParams({ state: input.state, code: `demo:${input.institution.name}` });
    return { url: `${input.redirectUrl}?${q}` };
  }

  async completeAuth(input: { code: string }): Promise<AuthResult> {
    const name = input.code.replace(/^demo:/, '');
    const accounts = ACCOUNTS[name];
    if (!accounts) throw new Error(`Unknown demo institution ${name}`);
    return {
      sessionId: `demo-session:${name}`,
      validUntil: new Date(Date.now() + 180 * 86400_000).toISOString(),
      accounts: accounts.map(({ balance: _b, ...a }) => a),
    };
  }

  async getBalance(_sessionId: string, accountUid: string) {
    const acc = Object.values(ACCOUNTS).flat().find((a) => a.uid === accountUid);
    return acc ? { amountMinor: Math.round(acc.balance * 100), currency: acc.currency } : null;
  }

  async getTransactions(_sessionId: string, accountUid: string, range: { from: string; to: string }) {
    const acc = Object.values(ACCOUNTS).flat().find((a) => a.uid === accountUid);
    if (!acc) return [];
    const from = range.from < addMonths(today(), -14) ? addMonths(today(), -14) : range.from;
    return generate(accountUid, from, range.to).map((t, i) => ({
      ...t,
      externalId: null,
      currency: acc.currency,
      status: 'booked' as const,
      raw: { demo: true, n: i },
    }));
  }

  async revoke(): Promise<void> {}
}
