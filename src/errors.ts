export type KalorickeTabulkyErrorCode =
  /** A method was called with an unusable argument (bad date, empty token, …). */
  | 'INVALID_ARGUMENT'
  /** The session token is missing, expired or rejected and the client has no e-mail/password to log in again. */
  | 'SESSION_EXPIRED'
  /** Logging in with e-mail/password was rejected by Kalorické tabulky. */
  | 'LOGIN_FAILED'
  /** The request never got an answer (DNS, TLS, timeout, …). */
  | 'NETWORK'
  /** Kalorické tabulky answered with an unexpected HTTP status. */
  | 'HTTP'
  /** The answer was not JSON or did not match the expected shape. */
  | 'BAD_RESPONSE';

/** The only error type thrown by this package. Messages never contain the token, cookies or password. */
export class KalorickeTabulkyError extends Error {
  override readonly name = 'KalorickeTabulkyError';
  readonly code: KalorickeTabulkyErrorCode;
  /** HTTP status of the failing answer, when there was one. */
  readonly status: number | null;

  constructor(code: KalorickeTabulkyErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status ?? null;
  }
}

export const isKalorickeTabulkyError = (value: unknown): value is KalorickeTabulkyError => value instanceof KalorickeTabulkyError;
