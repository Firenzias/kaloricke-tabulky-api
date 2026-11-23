import { describe, expect, it } from 'vitest';
import { flattenKtSeriesValues, hashKtPassword, ktWeightPoints, isKalorickeTabulkyError, KalorickeTabulkyClient, KalorickeTabulkyError, toKtDate, toKtRange } from './index.js';
import type { FetchLike } from './index.js';

const TOKEN = 'bead807bac9ceeb6588f10667d78a9f7';
const FRESH = 'fresh0000000000000000000000token';
/** The server-side session KT binds the fresh token to at login (real KT: a 302 to /login without it). */
const JSESSION = 'J-SESSION-0001';
const PASSWORD = 'tajné heslo';

const json = (body: unknown, init: ResponseInit = {}): Response => {
  // `new Headers(init)` keeps repeated Set-Cookie lines; spreading a Headers object would drop them.
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json;charset=UTF-8');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
};
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
        code === 0 ? { headers: loginCookies() } : {},
      );
    }
    const custom = opts.route?.(url);
    if (custom !== undefined) return custom;
    const cookie = headers.get('cookie') ?? '';
    const token = /kaloricketabulky_token=([^;]+)/.exec(cookie)?.[1];
    if (token === undefined || !valid.has(token)) return loginPage();
    // Like KT: the token from /login/create is only valid together with its JSESSIONID.
    if (token === FRESH && !cookie.includes(`JSESSIONID=${JSESSION}`)) return new Response(null, { status: 302, headers: { Location: '/login' } });
    if (url.includes('/statistic/optional/')) return ok(OPTIONAL);
    if (url.includes('/statistic/energy/')) return ok(ENERGY);
    if (url.includes('/statistic/nutrients/')) return ok(NUTRIENTS);
    if (url.includes('/statistic/summary/')) return ok({ monthWeight: [{ description: '16.11.2026', value: 79.5 }] });
    if (url.includes('/user/weight/add')) return ok(null);
    return new Response('not found', { status: 404 });
  };
  return { fetchFn, sent };
}

function loginCookies(): Headers {
  const h = new Headers();
  h.append('Set-Cookie', 'org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE=cs; Path=/');
  h.append('Set-Cookie', `JSESSIONID=${JSESSION}; Path=/; Secure; HttpOnly`);
  h.append('Set-Cookie', `kaloricketabulky_token=${FRESH}; Max-Age=2592000; Path=/; Secure; HttpOnly`);
  return h;
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

  it('accepts a session as a Cookie header (also with a Cookie: prefix) and rejects one without the token', () => {
    const client = new KalorickeTabulkyClient({ session: `Cookie: JSESSIONID=${JSESSION}; kaloricketabulky_token=${TOKEN};` });
    expect(client.getToken()).toBe(TOKEN);
    expect(client.getSession()).toBe(`JSESSIONID=${JSESSION}; kaloricketabulky_token=${TOKEN}`);
    expect(() => new KalorickeTabulkyClient({ session: 'JSESSIONID=x' })).toThrow(/no valid kaloricketabulky_token/);
    expect(() => new KalorickeTabulkyClient({ session: 'a=1; =2' })).toThrow(/malformed cookie/);
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
    expect(flattenKtSeriesValues(optional.data?.[0]?.values ?? [])[0]?.value).toBe(97);
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
    const optionalShape = await caught(client(() => ok({ type: 'x', values: [] })).getOptionalStats('2026-11-01', '2026-11-17'));
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

describe('optional series with wrapped values', () => {
  const A = { guid: 'a', from: 1764198000000, to: null, value: 20.3, valueString: '20,3' };
  const B = { guid: 'b', from: 1765062000000, to: null, value: 21.3, valueString: '21,3' };
  const fat = { type: 'Tuky [%]', from: 1763766000000, to: 1795302000000, unit: null, graph: true, values: [A, { value: B, target: null }, { value: A, target: null }] };
  const optional = (data: unknown) =>
    new KalorickeTabulkyClient({ token: TOKEN, fetch: fakeKt({ route: (url) => (url.includes('/optional/') ? ok(data) : undefined) }).fetchFn }).getOptionalStats(
      '2025-01-01',
      '2026-11-17',
    );

  it('keeps the response raw and lossless; the helper flattens and dedupes by guid', async () => {
    const res = await optional([fat]);
    expect(res.data?.[0]?.values).toEqual(fat.values);
    expect(flattenKtSeriesValues(res.data?.[0]?.values ?? []).map((v) => v.guid)).toEqual(['a', 'b']);
  });

  it('reads a series that has only wrapped entries (waist)', async () => {
    const w = { guid: 'w', from: 1794783600000, to: null, value: 97, valueString: '97' };
    const res = await optional([{ type: 'Obvod břicha [cm]', unit: null, values: [{ value: w, target: null }] }]);
    expect(flattenKtSeriesValues(res.data?.[0]?.values ?? [])).toEqual([w]);
  });

  it('does not fail on a malformed entry: it stays raw and the helper drops it', async () => {
    const values = [{ from: 'yesterday' }, A, { value: { from: 'x' }, target: null }, 'junk', null];
    const res = await optional([{ type: 'Tuky [%]', values }]);
    expect(res.data?.[0]?.values).toEqual(values);
    expect(flattenKtSeriesValues(res.data?.[0]?.values ?? [])).toEqual([A]);
  });

  it('a JSON round-trip of the raw optional response equals the raw payload', async () => {
    const payload = { requestId: null, code: 0, message: null, data: [{ ...fat, extra: { k: 1 } }] };
    const kt = fakeKt({ route: (url) => (url.includes('/optional/') ? new Response(JSON.stringify(payload)) : undefined) });
    const res = await new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn }).getOptionalStats('2025-01-01', '2026-11-17');
    expect(JSON.parse(JSON.stringify(res))).toEqual(payload);
  });

  it('dedupes by from when there is no guid, and exports flattenKtSeriesValues', () => {
    const p = { from: 5, value: 1 };
    expect(flattenKtSeriesValues([p, { value: p, target: null }, { from: 6, value: 2 }])).toEqual([p, { from: 6, value: 2 }]);
    expect(flattenKtSeriesValues([])).toEqual([]);
  });
});

describe('weight statistic', () => {
  const G1 = { guid: 'g1', from: 1764198000000, to: null, value: 72.5, valueString: '72,5', description: null, status: null, systemTime: null, source: null };
  const G2 = { guid: 'g2', from: 1764284400000, to: null, value: 72.1, valueString: '72,1' };
  const real = {
    guid: null, type: 'weight', from: null, to: null, unit: 'kcal', graph: null, nutrientsTarget: [], nutrientsValues: [], nutrientsTableData: [],
    target: [G1, G2], page: 1, limit: 25, targetPaged: null, valuesPaged: null, tableDataPaged: null, min: 72.1, max: 83.28,
  };
  const weight = async (data: unknown) => {
    const kt = fakeKt({ route: (url) => (url.includes('/statistic/weight/') ? ok(data) : undefined) });
    const res = await new KalorickeTabulkyClient({ token: TOKEN, fetch: kt.fetchFn }).getWeight('2026-10-18', '2026-11-17');
    return { res, kt };
  };

  it('requests /statistic/weight/{from}/{to}/get?format=json with the token cookie', async () => {
    const { kt } = await weight(real);
    expect(kt.sent.map((s) => s.url)).toEqual(['https://www.kaloricketabulky.cz/statistic/weight/18.10.2026/17.11.2026/get?format=json']);
    expect(kt.sent[0]?.cookie).toContain(`kaloricketabulky_token=${TOKEN}`);
  });

  it('reads the real object shape, keeps it raw and returns the points', async () => {
    const { res } = await weight(real);
    expect(JSON.parse(JSON.stringify(res))).toEqual({ requestId: null, code: 0, message: null, data: real });
    expect(ktWeightPoints(res.data)).toEqual([G1, G2]);
  });

  it('reads the plain-array shape', async () => {
    const { res } = await weight([G1, G2]);
    expect(ktWeightPoints(res.data)).toEqual([G1, G2]);
  });

  it('drops a malformed entry without failing the response', async () => {
    const { res } = await weight({ ...real, target: [{ from: 'yesterday' }, G1, 'junk', null] });
    expect(ktWeightPoints(res.data)).toEqual([G1]);
  });

  it('returns no points for null data, a missing target, and rejects a wrong type', async () => {
    expect(ktWeightPoints((await weight(null)).res.data)).toEqual([]);
    expect(ktWeightPoints((await weight({ type: 'weight', target: null })).res.data)).toEqual([]);
    const bad = await caught(new KalorickeTabulkyClient({ token: TOKEN, fetch: fakeKt({ route: () => ok({ type: 'energy' }) }).fetchFn }).getWeight('2026-10-18', '2026-11-17'));
    expect(bad.code).toBe('BAD_RESPONSE');
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
    expect(client.getSession()).toBe(
      `org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE=cs; JSESSIONID=${JSESSION}; kaloricketabulky_token=${FRESH}`,
    );
    // Regression: every statistic call carries the JSESSIONID from the login, not just the token.
    for (const sent of kt.sent.filter((x) => x.url.includes('/statistic/'))) expect(sent.cookie).toContain(`JSESSIONID=${JSESSION}`);
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

  it('a saved getSession() works in a new client without logging in again', async () => {
    const kt = fakeKt();
    const first = new KalorickeTabulkyClient({ email: 'me@example.cz', password: PASSWORD, fetch: kt.fetchFn });
    await first.getEnergy('2026-11-01', '2026-11-17');
    const saved = first.getSession();
    if (saved === null) throw new Error('no session');
    const second = new KalorickeTabulkyClient({ email: 'me@example.cz', password: PASSWORD, session: saved, fetch: kt.fetchFn });
    await second.getNutrients('2026-11-01', '2026-11-17');
    expect(kt.sent.filter((x) => x.url.includes('/login/'))).toHaveLength(1);
  });

  it('follows a rotated JSESSIONID but ignores a cleared token', async () => {
    const answers = [
      ok(ENERGY),
      new Response(JSON.stringify({ requestId: null, code: 0, message: null, data: ENERGY }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'JSESSIONID=J-ROTATED; Path=/' },
      }),
    ];
    const seen: (string | null)[] = [];
    const client = new KalorickeTabulkyClient({
      session: `JSESSIONID=${JSESSION}; kaloricketabulky_token=${TOKEN}`,
      fetch: async (_url, init) => {
        seen.push(new Headers(init.headers).get('cookie'));
        const h = new Headers({ 'Content-Type': 'application/json' });
        h.append('Set-Cookie', 'JSESSIONID=J-ROTATED; Path=/');
        h.append('Set-Cookie', 'kaloricketabulky_token=; Max-Age=0; Path=/');
        return answers.shift() ?? new Response(JSON.stringify({ requestId: null, code: 0, message: null, data: ENERGY }), { headers: h });
      },
    });
    await client.getEnergy('2026-11-01', '2026-11-17');
    await client.getEnergy('2026-11-01', '2026-11-17');
    await client.getEnergy('2026-11-01', '2026-11-17');
    expect(seen[2]).toContain('JSESSIONID=J-ROTATED');
    expect(client.getToken()).toBe(TOKEN);
  });

  it('login() can be called explicitly to verify credentials', async () => {
    const client = new KalorickeTabulkyClient({ email: 'me@example.cz', password: PASSWORD, fetch: fakeKt().fetchFn });
    expect(client.canLogin()).toBe(true);
    expect(await client.login()).toBe(FRESH);
    expect(new KalorickeTabulkyClient({ token: TOKEN }).canLogin()).toBe(false);
    expect((await caught(new KalorickeTabulkyClient({ token: TOKEN }).login())).code).toBe('SESSION_EXPIRED');
  });
});
