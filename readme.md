# kaloricke-tabulky-api

A typed Node.js (≥ 20) client for the unofficial JSON API behind
[kaloricketabulky.cz](https://www.kaloricketabulky.cz). Every response is validated with Zod before it is
returned, and the package never holds credentials in its source. You pass them in at runtime.

## Install

```sh
npm install kaloricke-tabulky-api            # once published
npm install file:../kaloricke-tabulky-api    # local checkout (run `npm run build` in it first)
```

## Usage

```ts
import { KalorickeTabulkyClient, KalorickeTabulkyError } from 'kaloricke-tabulky-api';

// Auto-login: logs in on first use and renews an expired session by itself.
const client = new KalorickeTabulkyClient({ email: process.env.KT_EMAIL ?? '', password: process.env.KT_PASSWORD ?? '' });

// …or reuse a saved session (the `kaloricketabulky_token` cookie value):
const client = new KalorickeTabulkyClient({ token: 'bead807b…' });

// …or both: try the saved session first, log in again only when it has expired.
const client = new KalorickeTabulkyClient({ email, passwordMd5, token: savedToken });

const optional = await client.getOptionalStats('2026-10-18', '2026-11-17'); // waist, body composition, …
const energy = await client.getEnergy('18.10.2026', '17.11.2026'); // kcal per day
const nutrients = await client.getNutrients('2026-10-18', '2026-11-17'); // P / F / C grams per day

// Persist the (possibly renewed) session so the next start does not need to log in.
const token = client.getToken();
```

Dates are local calendar days given as `YYYY-MM-DD`, `DD.MM.YYYY` or a `Date`.

| Method | Endpoint |
| --- | --- |
| `getOptionalStats(from, to)` | `/statistic/optional/{from}/{to}/get?format=json` |
| `getEnergy(from, to)` | `/statistic/energy/{from}/{to}/get?format=json` |
| `getNutrients(from, to)` | `/statistic/nutrients/{from}/{to}/get?format=json` |
| `getWeightSummary(date?)` | `/statistic/summary/{date}/get?format=json` |
| `recordWeight(kg, date?)` | `POST /user/weight/add?format=json` |
| `login()` | `POST /login/create?format=json` (returns the new token) |
| `getToken()` / `canLogin()` | the current session token, and whether e-mail/password is set |

Each method returns the full validated envelope (`{ requestId, code, message, data }`). Unknown keys are
kept, so `JSON.stringify(response)` gives back the original payload. The schemas are exported
(`ktOptionalStatsResponseSchema`, `ktDayValueSchema`, `ktNutrientsEntrySchema`, …) for validating
individual entries.

### Errors

Every failure is a `KalorickeTabulkyError` with a `code`:

| `code` | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | bad date, empty token / e-mail / password |
| `SESSION_EXPIRED` | the token is invalid or expired, and there is no e-mail/password to renew it |
| `LOGIN_FAILED` | KT rejected the e-mail/password (or the fresh session) |
| `NETWORK` | no answer (DNS, TLS, timeout) |
| `HTTP` | unexpected HTTP status (`error.status`) |
| `BAD_RESPONSE` | not JSON, or JSON that does not match the schema |

Error messages never include the token, cookies or password.

### Options

`fetch` (an injectable `fetch`, for tests or proxies), `baseUrl`, `timeoutMs` (default 20 000) and
`userAgent` can be passed next to the credentials.

## Security notes

- KT's login takes the MD5 hex digest of the password, never the password itself. Use
  `hashKtPassword(password)` and keep only the digest (`{ email, passwordMd5 }`) if you need to store
  credentials. It still works as a login for KT, so protect it like a password (e.g. file mode `0600`).
- A logged-out KT call answers with a redirect, the HTML login page, 401/403 or `code !== 0`. The client
  treats all of these as an expired session. It logs in again at most once per call, so it never loops.

## Development

```sh
npm install      # also builds dist/
npm run verify   # typecheck + lint + test + build
```

The code uses no type assertions, `any`, non-null assertions or `@ts-ignore`, and ESLint enforces this.
