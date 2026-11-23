import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { toKtDate, toKtRange } from './dates.js';
import type { KtDateInput } from './dates.js';
import { KalorickeTabulkyError } from './errors.js';
import {
  ktEnergyResponseSchema,
  ktEnvelopeSchema,
  ktLoginResponseSchema,
  ktNutrientsResponseSchema,
  ktOptionalStatsResponseSchema,
  ktWeightResponseSchema,
  ktWeightSummaryResponseSchema,
} from './schemas.js';
import type { KtEnergyResponse, KtNutrientsResponse, KtOptionalStatsResponse, KtWeightResponse } from './schemas.js';

export const KT_BASE_URL = 'https://www.kaloricketabulky.cz';
export const KT_TOKEN_COOKIE = 'kaloricketabulky_token';
const LOCALE_COOKIE = 'org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A saved session. KT needs **all** its session cookies (`JSESSIONID` and `kaloricketabulky_token`), so pass what
 * `getSession()` returned, a Cookie header or a browser's cookie string. A bare token value is accepted too, but KT
 * rejects it unless the server-side session still knows it.
 */
export interface KtSessionCredentials {
  session: string;
}

/** @deprecated Use `{ session }`; `token` takes the same values. */
export interface KtTokenCredentials {
  token: string;
}

/** Auto-login; `session` (optional) is a previously saved session tried first. */
export interface KtPasswordCredentials {
  email: string;
  password: string;
  session?: string | null;
  /** @deprecated Use `session`. */
  token?: string | null;
}

/** Like `KtPasswordCredentials`, but with the MD5 hex digest KT expects instead of the plain password. */
export interface KtPasswordHashCredentials {
  email: string;
  passwordMd5: string;
  session?: string | null;
  /** @deprecated Use `session`. */
  token?: string | null;
}

export type KtCredentials = KtSessionCredentials | KtTokenCredentials | KtPasswordCredentials | KtPasswordHashCredentials;

export interface KtClientSettings {
  /** Injected `fetch` (tests, proxies). Defaults to the global `fetch`. */
  fetch?: FetchLike;
  baseUrl?: string;
  /** Per-request timeout; default 20 s. */
  timeoutMs?: number;
  userAgent?: string;
}

export type KalorickeTabulkyClientOptions = KtCredentials & KtClientSettings;

/** The statistic endpoints, `/statistic/{kind}/{from}/{to}/get?format=json`. */
export type KtStatisticKind = 'optional' | 'energy' | 'nutrients' | 'weight';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** KT does not take the password itself, only its MD5 hex digest. */
export const hashKtPassword = (password: string): string => createHash('md5').update(password, 'utf8').digest('hex');

const TOKEN_SHAPE = /^[A-Za-z0-9._~-]+$/;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[^;,\s]*$/;

type CookieJar = Map<string, string>;

/** A session as given by the caller (Cookie header, `getSession()` output or a bare token) → cookie jar. */
function parseSession(input: string): CookieJar {
  const text = input.trim().replace(/^cookie\s*:\s*/i, '');
  const jar: CookieJar = new Map();
  if (!text.includes('=')) {
    if (!TOKEN_SHAPE.test(text)) throw new KalorickeTabulkyError('INVALID_ARGUMENT', `The ${KT_TOKEN_COOKIE} value is empty or malformed.`);
    jar.set(KT_TOKEN_COOKIE, text);
    return jar;
  }
  for (const part of text.split(';')) {
    const pair = part.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (eq <= 0 || !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
      throw new KalorickeTabulkyError('INVALID_ARGUMENT', `The session has a malformed cookie ("${name.slice(0, 40)}").`);
    }
    if (value !== '') jar.set(name, value);
  }
  const token = jar.get(KT_TOKEN_COOKIE);
  if (token === undefined || !TOKEN_SHAPE.test(token)) {
    throw new KalorickeTabulkyError('INVALID_ARGUMENT', `The session has no valid ${KT_TOKEN_COOKIE} cookie.`);
  }
  return jar;
}

/** Applies `Set-Cookie` headers to the jar; an empty value or `Max-Age=0` deletes the cookie (logout). */
function absorbSetCookies(jar: CookieJar, headers: Headers): void {
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : splitSetCookie(headers.get('set-cookie'));
  for (const line of lines) {
    const [pair, ...attributes] = line.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair === undefined || eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
    if (value === '' || expired) jar.delete(name);
    else jar.set(name, value);
  }
}

/** Fallback for runtimes without `Headers.getSetCookie()`: split a folded header at cookie boundaries. */
const splitSetCookie = (folded: string | null): string[] => (folded === null ? [] : folded.split(/,(?=\s*[^;,=\s]+=)/));

const MD5_HEX = /^[0-9a-f]{32}$/i;

type Answer = { kind: 'auth' } | { kind: 'json'; value: unknown };

/**
 * Client for the (unofficial) Kalorické tabulky JSON API.
 *
 * ```ts
 * const client = new KalorickeTabulkyClient({ email, password }); // logs in on first use
 * const client = new KalorickeTabulkyClient({ session: saved }); // reuses a saved `getSession()`
 * ```
 *
 * The client keeps every session cookie KT sets (`JSESSIONID`, `kaloricketabulky_token`, …) and updates them from
 * each answer. With e-mail/password an expired session is renewed transparently (once per call); persist
 * `getSession()` to skip the login next time.
 */
export class KalorickeTabulkyClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #login: { email: string; passwordMd5: string } | null;
  /** Session cookies; empty before the first login. */
  #jar: CookieJar;
  #pendingLogin: Promise<string> | null = null;

  constructor(options: KalorickeTabulkyClientOptions) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#baseUrl = (options.baseUrl ?? KT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    if ('email' in options) {
      const email = options.email.trim();
      if (email === '') throw new KalorickeTabulkyError('INVALID_ARGUMENT', 'The e-mail is empty.');
      let passwordMd5: string;
      if ('passwordMd5' in options) {
        if (!MD5_HEX.test(options.passwordMd5)) throw new KalorickeTabulkyError('INVALID_ARGUMENT', 'passwordMd5 must be a 32-character hex MD5 digest.');
        passwordMd5 = options.passwordMd5.toLowerCase();
      } else {
        if (options.password === '') throw new KalorickeTabulkyError('INVALID_ARGUMENT', 'The password is empty.');
        passwordMd5 = hashKtPassword(options.password);
      }
      this.#login = { email, passwordMd5 };
      const saved = options.session ?? options.token ?? null;
      this.#jar = saved === null || saved.trim() === '' ? new Map() : parseSession(saved);
    } else {
      this.#login = null;
      this.#jar = parseSession('session' in options ? options.session : options.token);
    }
  }

  /** The current `kaloricketabulky_token` (after an auto-login the new one), or `null` before the first login. */
  getToken(): string | null {
    return this.#jar.get(KT_TOKEN_COOKIE) ?? null;
  }

  /**
   * The whole current session as a Cookie header (`JSESSIONID=…; kaloricketabulky_token=…`), or `null` before the
   * first login. This – not `getToken()` – is what to persist and pass back as `{ session }`. It is a secret.
   */
  getSession(): string | null {
    if (!this.#jar.has(KT_TOKEN_COOKIE)) return null;
    return [...this.#jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Whether the client can log in by itself (was given e-mail/password). */
  canLogin(): boolean {
    return this.#login !== null;
  }

  /**
   * Logs in with the configured e-mail/password and returns the new session token.
   * Concurrent calls share one login request.
   */
  login(): Promise<string> {
    this.#pendingLogin ??= this.#doLogin().finally(() => {
      this.#pendingLogin = null;
    });
    return this.#pendingLogin;
  }

  /** `/statistic/optional/{from}/{to}` – waist, body composition and other optional measurements. */
  getOptionalStats(from: KtDateInput, to: KtDateInput): Promise<KtOptionalStatsResponse> {
    return this.#statistic('optional', from, to, ktOptionalStatsResponseSchema);
  }

  /** `/statistic/energy/{from}/{to}` – consumed energy per day. */
  getEnergy(from: KtDateInput, to: KtDateInput): Promise<KtEnergyResponse> {
    return this.#statistic('energy', from, to, ktEnergyResponseSchema);
  }

  /** `/statistic/nutrients/{from}/{to}` – protein, fat, carbs (and fiber) per day, in grams. */
  getNutrients(from: KtDateInput, to: KtDateInput): Promise<KtNutrientsResponse> {
    return this.#statistic('nutrients', from, to, ktNutrientsResponseSchema);
  }

  /** `/statistic/weight/{from}/{to}` – every weight in the range; read it with `ktWeightPoints`. */
  getWeight(from: KtDateInput, to: KtDateInput): Promise<KtWeightResponse> {
    return this.#statistic('weight', from, to, ktWeightResponseSchema);
  }

  /** `/statistic/summary/{date}` – the weights recorded in the month around `date` (default today). */
  async getWeightSummary(date: KtDateInput = new Date()): Promise<{ date: string; weightKg: number }[]> {
    const res = await this.#authed(`/statistic/summary/${toKtDate(date)}/get?format=json`, ktWeightSummaryResponseSchema, 'summary');
    return res.data.monthWeight.map((item) => ({ date: item.description, weightKg: item.value }));
  }

  /** `/user/weight/add` – records a weight for `date` (default today). */
  async recordWeight(weightKg: number, date: KtDateInput = new Date()): Promise<void> {
    if (!Number.isFinite(weightKg) || weightKg <= 0) throw new KalorickeTabulkyError('INVALID_ARGUMENT', `Invalid weight ${weightKg}.`);
    await this.#authed('/user/weight/add?format=json', ktEnvelopeSchema, 'weight/add', {
      method: 'POST',
      body: JSON.stringify({ weight: weightKg, date: toKtDate(date) }),
    });
  }

  async #statistic<S extends z.ZodTypeAny>(kind: KtStatisticKind, from: KtDateInput, to: KtDateInput, schema: S): Promise<z.output<S>> {
    const range = toKtRange(from, to);
    return this.#authed(`/statistic/${kind}/${range.from}/${range.to}/get?format=json`, schema, kind);
  }

  async #doLogin(): Promise<string> {
    const login = this.#login;
    if (login === null) throw new KalorickeTabulkyError('SESSION_EXPIRED', 'The session token expired and no e-mail/password is configured to log in again.');
    // Log in without the old session's cookies: KT then starts a fresh server-side session.
    const res = await this.#send('/login/create?format=json', 'login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${LOCALE_COOKIE}=cs` },
      body: JSON.stringify({ email: login.email, password: login.passwordMd5 }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new KalorickeTabulkyError('LOGIN_FAILED', `Login failed (HTTP ${res.status}, not a JSON answer).`, { status: res.status });
    }
    const body = ktLoginResponseSchema.safeParse(json);
    if (!body.success || body.data.code !== 0) {
      const reason = body.success && body.data.message != null && body.data.message !== '' ? `: ${body.data.message}` : '';
      throw new KalorickeTabulkyError('LOGIN_FAILED', `Login rejected – check the e-mail and password${reason}.`, { status: res.status });
    }
    const jar: CookieJar = new Map([[LOCALE_COOKIE, 'cs']]);
    absorbSetCookies(jar, res.headers);
    const token = jar.get(KT_TOKEN_COOKIE);
    if (token === undefined || !TOKEN_SHAPE.test(token)) {
      throw new KalorickeTabulkyError('LOGIN_FAILED', `Login succeeded but no ${KT_TOKEN_COOKIE} cookie was returned.`, { status: res.status });
    }
    this.#jar = jar;
    return token;
  }

  /** Sends an authenticated request; on an expired session logs in again (when it can) and retries once. */
  async #authed<S extends z.ZodTypeAny>(path: string, schema: S, label: string, init: RequestInit = {}): Promise<z.output<S>> {
    // A session obtained just now is not retried: a second login would get the same answer.
    const fresh = this.getToken() === null;
    if (fresh) await this.login();
    const usedToken = this.getToken();
    let answer = await this.#request(path, label, init);
    if (answer.kind === 'auth' && this.#login !== null && !fresh) {
      // Another call may already have renewed the session while this one was in flight.
      if (this.getToken() === usedToken) await this.login();
      answer = await this.#request(path, label, init);
    }
    if (answer.kind === 'auth') {
      throw this.#login === null
        ? new KalorickeTabulkyError('SESSION_EXPIRED', 'The session token has expired or is invalid.')
        : new KalorickeTabulkyError('LOGIN_FAILED', 'Kalorické tabulky rejected the session right after logging in.');
    }
    const parsed = schema.safeParse(answer.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
      throw new KalorickeTabulkyError('BAD_RESPONSE', `Unexpected ${label} response${where}.`);
    }
    return parsed.data;
  }

  async #request(path: string, label: string, init: RequestInit): Promise<Answer> {
    const cookies: CookieJar = new Map([[LOCALE_COOKIE, 'cs'], ...this.#jar]);
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const res = await this.#send(path, label, {
      ...init,
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), Cookie: cookie },
    });
    // KT may rotate JSESSIONID (or clear the session) on any answer; keep the jar in step. A cleared token is not
    // applied here, so a concurrent call's renewal is not undone by an answer to the old session.
    const updated = new Map(this.#jar);
    absorbSetCookies(updated, res.headers);
    if (updated.has(KT_TOKEN_COOKIE)) this.#jar = updated;
    // A redirect from KT is always to the login page; so is any HTML answer.
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) return { kind: 'auth' };
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (/text\/html/i.test(contentType) || /^\s*</.test(text)) return { kind: 'auth' };
    if (res.status < 200 || res.status >= 300) throw new KalorickeTabulkyError('HTTP', `${label}: HTTP ${res.status}`, { status: res.status });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new KalorickeTabulkyError('BAD_RESPONSE', `${label}: the answer is not JSON.`, { status: res.status });
    }
    const envelope = ktEnvelopeSchema.safeParse(json);
    if (!envelope.success) throw new KalorickeTabulkyError('BAD_RESPONSE', `${label}: the answer has no "code".`, { status: res.status });
    // KT answers a logged-out JSON call with 200 and a non-zero code.
    if (envelope.data.code !== 0) return { kind: 'auth' };
    return { kind: 'json', value: json };
  }

  async #send(path: string, label: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `${this.#baseUrl}/statistic`,
          'User-Agent': this.#userAgent,
          ...init.headers,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new KalorickeTabulkyError('NETWORK', `${label}: Kalorické tabulky is unreachable (${reason}).`, { cause: e });
    }
  }
}
