import { describe, expect, it } from 'vitest';
import { hashKtPassword, isKalorickeTabulkyError, KalorickeTabulkyClient, KalorickeTabulkyError, toKtDate, toKtRange } from './index.js';
import type { FetchLike } from './index.js';

const TOKEN = 'bead807bac9ceeb6588f10667d78a9f7';
const FRESH = 'fresh0000000000000000000000token';
const PASSWORD = 'tajné heslo';

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const ok = (data: unknown) => json({ requestId: null, code: 0, message: null, data });
const loginPage = (): Response => new Response('<!DOCTYPE html><html>Přihlášení</html>', { headers: { 'Content-Type': 'text/html' } });

const OPTIONAL = [{ type: 'Obvod břicha [cm]', unit: null, values: [{ guid: 'a', from: 1794783600000, to: null, value: 97, valueString: '97' }] }];
const ENERGY = { type: 'energy', unit: 'kcal', values: [{ from: 1794438000000, value: 2900.548, description: null, status: 1 }] };
const NUTRIENTS = {
  type: 'nutrients',
  unit: 'kcal',
  nutrientsValues: [{ createdDate: 1794438000000, fat: { from: null, value: 119.3, status: 1 }, protein: { from: null, value: 148.5, status: 0 } }],
};

interface Sent {
  url: string;
  method: string;
  cookie: string | null;
  body: string | null;
}

/**
 * Fake kaloricketabulky.cz: `/login/create` hands out `FRESH` for the right credentials,
 * statistic endpoints accept only tokens in `valid` (others get the login page).
 */
function fakeKt(opts: { valid?: string[]; loginCode?: number; route?: (url: string) => Response | undefined } = {}) {
  const valid = new Set(opts.valid ?? [TOKEN, FRESH]);
  const sent: Sent[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    sent.push({ url, method: init.method ?? 'GET', cookie: headers.get('cookie'), body });
    if (url.includes('/login/create')) {
      const parsed: unknown = JSON.parse(body ?? '{}');
      const good = typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'password') === hashKtPassword(PASSWORD);
      const code = opts.loginCode ?? (good ? 0 : 1);
      return json(
        { requestId: null, code, message: code === 0 ? null : 'Špatné jméno nebo heslo', data: null },
        code === 0 ? { headers: { 'Set-Cookie': `${'kaloricketabulky_token'}=${FRESH}; Path=/; HttpOnly` } } : {},
      );
    }
    const custom = opts.route?.(url);
    if (custom !== undefined) return custom;
    const token = /kaloricketabulky_token=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
    if (token === undefined || !valid.has(token)) return loginPage();
    if (url.includes('/statistic/optional/')) return ok(OPTIONAL);
    if (url.includes('/statistic/energy/')) return ok(ENERGY);
    if (url.includes('/statistic/nutrients/')) return ok(NUTRIENTS);
    if (url.includes('/statistic/summary/')) return ok({ monthWeight: [{ description: '16.11.2026', value: 79.5 }] });
    if (url.includes('/user/weight/add')) return ok(null);
    return new Response('not found', { status: 404 });
  };
  return { fetchFn, sent };
}

async function caught(promise: Promise<unknown>): Promise<KalorickeTabulkyError> {
  try {
    await promise;
  } catch (e) {
    if (isKalorickeTabulkyError(e)) return e;
    throw e;
  }
  throw new Error('expected a KalorickeTabulkyError');
}

describe('dates', () => {
  it('accepts YYYY-MM-DD, DD.MM.YYYY, D.M.YYYY and Date and emits DD.MM.YYYY', () => {
    expect(toKtDate('2026-11-17')).toBe('17.11.2026');
    expect(toKtDate('17.11.2026')).toBe('17.11.2026');
    expect(toKtDate('1. 2. 2026')).toBe('01.02.2026');
    expect(toKtDate(new Date(2026, 0, 5))).toBe('05.01.2026');
  });

  it('rejects impossible dates and reversed ranges', () => {
    expect(() => toKtDate('2026-02-30')).toThrow(KalorickeTabulkyError);
    expect(() => toKtDate('yesterday')).toThrow(/Invalid date/);
    expect(() => toKtRange('2026-11-17', '01.11.2026')).toThrow(/must not be after/);
    expect(toKtRange('2025-12-31', '2026-01-01')).toEqual({ from: '31.12.2025', to: '01.01.2026' });
  });
});

describe('construction', () => {
  it('validates credentials without touching the network', () => {
    expect(() => new KalorickeTabulkyClient({ token: '' })).toThrow(/malformed/);
    expect(() => new KalorickeTabulkyClient({ token: 'a b' })).toThrow(/malformed/);
    expect(() => new KalorickeTabulkyClient({ email: ' ', password: 'x' })).toThrow(/e-mail/);
    expect(() => new KalorickeTabulkyClient({ email: 'a@b.cz', password: '' })).toThrow(/password/);
    expect(() => new KalorickeTabulkyClient({ email: 'a@b.cz', passwordMd5: 'nope' })).toThrow(/MD5/);
  });

  it('exposes the token it was given', () => {
    expect(new KalorickeTabulkyClient({ token: ` ${TOKEN}\n` }).getToken()).toBe(TOKEN);
    expect(new KalorickeTabulkyClient({ email: 'a@b.cz', password: PASSWORD }).getToken()).toBeNull();
    expect(new KalorickeTabulkyClient({ email: 'a@b.cz', password: PASSWORD, token: TOKEN }).getToken()).toBe(TOKEN);
  });

  it('hashes the password with MD5 the way KT expects', () => {
    expect(hashKtPassword('password')).toBe('5f4dcc3b5aa765d61d8327deb882cf99');
  });
});

describe('token client', () => {
  it('fetches the three statistics with the token cookie and DD.MM.YYYY URLs', async () => {
    const kt = fakeKt();
    const client = new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn });
    const [optional, energy, nutrients] = await Promise.all([
      client.getOptionalStats('2026-10-18', '2026-11-17'),
      client.getEnergy('18.10.2026', '17.11.2026'),
      client.getNutrients('2026-10-18', '17.11.2026'),
    ]);
    expect(optional.data?.[0]?.values?.[0]?.value).toBe(97);
    expect(energy.data?.type).toBe('energy');
    expect(nutrients.data?.nutrientsValues).toHaveLength(1);
    expect(kt.sent.map((s) => s.url).sort()).toEqual([
      'https://www.kaloricketabulky.cz/statistic/energy/18.10.2026/17.11.2026/get?format=json',
      'https://www.kaloricketabulky.cz/statistic/nutrients/18.10.2026/17.11.2026/get?format=json',
      'https://www.kaloricketabulky.cz/statistic/optional/18.10.2026/17.11.2026/get?format=json',
    ]);
    expect(new Set(kt.sent.map((s) => s.cookie))).toEqual(
      new Set([`org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE=cs; kaloricketabulky_token=${TOKEN}`]),
    );
  });

  it('keeps unknown keys so the raw payload can be archived losslessly', async () => {
    const extra = { ...ENERGY, somethingNew: { nested: [1, 2] } };
    const kt = fakeKt({ route: (url) => (url.includes('/energy/') ? ok(extra) : undefined) });
    const res = await new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn }).getEnergy('2026-11-01', '2026-11-17');
    expect(JSON.parse(JSON.stringify(res))).toEqual({ requestId: null, code: 0, message: null, data: extra });
  });

  it.each([
    ['the login page (HTML)', loginPage],
    ['a redirect', () => new Response(null, { status: 302, headers: { Location: '/login' } })],
    ['401', () => json({}, { status: 401 })],
    ['code !== 0', () => json({ requestId: null, code: 3, message: 'Unauthorized', data: null })],
  ])('reports %s as SESSION_EXPIRED without trying to log in', async (_label, answer) => {
    const kt = fakeKt({ route: answer });
    const e = await caught(new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn }).getOptionalStats('2026-11-01', '2026-11-17'));
    expect(e.code).toBe('SESSION_EXPIRED');
    expect(kt.sent.some((s) => s.url.includes('/login'))).toBe(false);
  });

  it('classifies HTTP errors, non-JSON, schema mismatches and network failures', async () => {
    const client = (route: (url: string) => Response) => new KalorickeTabulkyClient({ token: TOKEN, fetch: fakeKt({ route }).fetchFn });
    const http = await caught(client(() => json({}, { status: 500 })).getEnergy('2026-11-01', '2026-11-17'));
    expect([http.code, http.status, http.message]).toEqual(['HTTP', 500, 'energy: HTTP 500']);
    expect((await caught(client(() => new Response('nope')).getEnergy('2026-11-01', '2026-11-17'))).code).toBe('BAD_RESPONSE');
    const shape = await caught(client(() => ok({ unit: 'kcal' })).getEnergy('2026-11-01', '2026-11-17'));
    expect([shape.code, shape.message]).toEqual(['BAD_RESPONSE', 'Unexpected energy response at data.type: Required.']);
    const optionalShape = await caught(client(() => ok([{ type: 'x', values: [{ from: 'yesterday' }] }])).getOptionalStats('2026-11-01', '2026-11-17'));
    expect(optionalShape.code).toBe('BAD_RESPONSE');

    const down = new KalorickeTabulkyClient({ token: TOKEN, fetch: () => Promise.reject(new Error('ENOTFOUND')) });
    const net = await caught(down.getNutrients('2026-11-01', '2026-11-17'));
    expect([net.code, net.message]).toEqual(['NETWORK', 'nutrients: Kalorické tabulky is unreachable (ENOTFOUND).']);
  });

  it('rejects bad dates before sending anything', async () => {
    const kt = fakeKt();
    const e = await caught(new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn }).getEnergy('2026-13-01', '2026-11-17'));
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(kt.sent).toEqual([]);
  });

  it('reads the monthly weight summary and records a weight', async () => {
    const kt = fakeKt();
    const client = new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn });
    expect(await client.getWeightSummary('2026-11-17')).toEqual([{ date: '16.11.2026', weightKg: 79.5 }]);
    await client.recordWeight(79.2, '2026-11-17');
    const post = kt.sent.find((s) => s.url.includes('/user/weight/add'));
    expect(post?.method).toBe('POST');
    expect(JSON.parse(post?.body ?? 'null')).toEqual({ weight: 79.2, date: '17.11.2026' });
    await expect(client.recordWeight(-1)).rejects.toThrow(/Invalid weight/);
  });
});

describe('e-mail/password client', () => {
  it('logs in lazily with the MD5 password, once for concurrent calls, and exposes the new token', async () => {
    const kt = fakeKt();
    const client = new KalorickeTabulkyClient({ email: 'me@example.cz', password: PASSWORD, fetch: kt.fetchFn });
    await Promise.all([client.getOptionalStats('2026-11-01', '2026-11-17'), client.getEnergy('2026-11-01', '2026-11-17'), client.getNutrients('2026-11-01', '2026-11-17')]);
    const logins = kt.sent.filter((s) => s.url.endsWith('/login/create?format=json'));
    expect(logins).toHaveLength(1);
    expect(JSON.parse(logins[0]?.body ?? 'null')).toEqual({ email: 'me@example.cz', password: hashKtPassword(PASSWORD) });
    expect(client.getToken()).toBe(FRESH);
    // The plain password never leaves the process.
    expect(JSON.stringify(kt.sent)).not.toContain(PASSWORD);
  });

  it('renews an expired saved token once and retries', async () => {
    const kt = fakeKt({ valid: [FRESH] });
    const client = new KalorickeTabulkyClient({ email: 'me@example.cz', passwordMd5: hashKtPassword(PASSWORD), token: TOKEN, fetch: kt.fetchFn });
    const results = await Promise.all([client.getOptionalStats('2026-11-01', '2026-11-17'), client.getEnergy('2026-11-01', '2026-11-17')]);
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    expect(client.getToken()).toBe(FRESH);
    expect(kt.sent.filter((s) => s.url.includes('/login/'))).toHaveLength(1);
    expect(kt.sent.filter((s) => s.url.includes('/statistic/')).map((s) => s.cookie?.includes(FRESH))).toEqual([false, false, true, true]);
  });

  it('reports wrong credentials as LOGIN_FAILED without leaking them', async () => {
    const kt = fakeKt();
    const client = new KalorickeTabulkyClient({ email: 'me@example.cz', password: 'wrong', fetch: kt.fetchFn });
    const e = await caught(client.getEnergy('2026-11-01', '2026-11-17'));
    expect(e.code).toBe('LOGIN_FAILED');
    expect(e.message).toBe('Login rejected – check the e-mail and password: Špatné jméno nebo heslo.');
    expect(client.getToken()).toBeNull();
  });

  it('fails with LOGIN_FAILED when the fresh session is rejected too (no endless loop)', async () => {
    const kt = fakeKt({ valid: [] });
    const e = await caught(new KalorickeTabulkyClient({ email: 'me@example.cz', password: PASSWORD, fetch: kt.fetchFn }).getEnergy('2026-11-01', '2026-11-17'));
    expect(e.code).toBe('LOGIN_FAILED');
    expect(kt.sent.filter((s) => s.url.includes('/login/'))).toHaveLength(1);
    expect(kt.sent.filter((s) => s.url.includes('/statistic/'))).toHaveLength(1);
  });

  it('login() can be called explicitly to verify credentials', async () => {
    const client = new KalorickeTabulkyClient({ email: 'me@example.cz', password: PASSWORD, fetch: fakeKt().fetchFn });
    expect(client.canLogin()).toBe(true);
    expect(await client.login()).toBe(FRESH);
    expect(new KalorickeTabulkyClient({ token: TOKEN }).canLogin()).toBe(false);
    expect((await caught(new KalorickeTabulkyClient({ token: TOKEN }).login())).code).toBe('SESSION_EXPIRED');
  });
});
