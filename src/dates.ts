import { KalorickeTabulkyError } from './errors.js';

/** A local calendar date: `YYYY-MM-DD`, `DD.MM.YYYY` (also `D.M.YYYY`) or a `Date` (its local day). */
export type KtDateInput = string | Date;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const CZECH = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/;

const pad = (n: number): string => String(n).padStart(2, '0');

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parts(input: KtDateInput): { y: number; m: number; d: number } | null {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return { y: input.getFullYear(), m: input.getMonth() + 1, d: input.getDate() };
  }
  const text = input.trim();
  const iso = ISO.exec(text);
  if (iso !== null) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const cz = CZECH.exec(text);
  if (cz !== null) return { y: Number(cz[3]), m: Number(cz[2]), d: Number(cz[1]) };
  return null;
}

/** Normalizes any accepted date to the `DD.MM.YYYY` form Kalorické tabulky uses in its URLs. */
export function toKtDate(input: KtDateInput): string {
  const p = parts(input);
  if (p === null || !isRealDate(p.y, p.m, p.d)) {
    throw new KalorickeTabulkyError('INVALID_ARGUMENT', `Invalid date "${String(input)}" – use YYYY-MM-DD or DD.MM.YYYY.`);
  }
  return `${pad(p.d)}.${pad(p.m)}.${p.y}`;
}

/** Validates a `from`–`to` range and returns both ends as `DD.MM.YYYY`. */
export function toKtRange(from: KtDateInput, to: KtDateInput): { from: string; to: string } {
  const a = toKtDate(from);
  const b = toKtDate(to);
  const key = (kt: string): string => kt.split('.').reverse().join('');
  if (key(a) > key(b)) throw new KalorickeTabulkyError('INVALID_ARGUMENT', `"from" (${a}) must not be after "to" (${b}).`);
  return { from: a, to: b };
}
