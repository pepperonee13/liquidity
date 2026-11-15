/** All amounts are stored as integer minor units with two decimals (1.00 == 100). */

export function toMinor(value: number | string): number {
  if (typeof value === 'number') return Math.round(value * 100);
  const n = parseAmount(value);
  if (n === null) throw new Error(`Invalid amount: ${value}`);
  return Math.round(n * 100);
}

export function fromMinor(minor: number | null | undefined): number {
  return Math.round(minor ?? 0) / 100;
}

/**
 * Parse a human/bank formatted number: "1 234,56", "-1.234,56", "1,234.56", "(12.00)", "12,5 HUF".
 * Returns null when no number can be read.
 */
export function parseAmount(input: string): number | null {
  let s = input.trim().replace(/[  \s']/g, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,+\-−]/g, '');
  if (/^[-−]/.test(s) || /[-−]$/.test(s)) negative = true;
  s = s.replace(/[+\-−]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // The later one is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const count = s.split(',').length - 1;
    // "1,234" or "1,234,567" is a thousands grouping; "12,5" / "12,50" is a decimal comma.
    if (count > 1 || decimals === 3) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    const count = s.split('.').length - 1;
    if (count > 1 || (decimals === 3 && s.length > 5)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Lowercase, strip diacritics and collapse whitespace – used for matching. */
export function normalize(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dom = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dom, last));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** [first day, first day of next month) for a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  return { from, to: addDays(addMonths(from, 1), -1) };
}
