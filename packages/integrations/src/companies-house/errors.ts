export type CompaniesHouseErrorKind =
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'rate_limited'
  | 'server_error'
  | 'invalid_response'
  | 'http';

const RETRYABLE: Record<CompaniesHouseErrorKind, boolean> = {
  timeout: true,
  network: true,
  rate_limited: true, // after retryAt
  unauthorized: false, // a wrong key stays wrong
  server_error: true, // with backoff
  invalid_response: false, // retrying returns the same bad data
  http: false, // any other 4xx request is wrong
};

const RATE_LIMIT_RESET = 'x-ratelimit-reset';
const DEFAULT_RETRY_DELAY_MS = 60_000 * 5; // Companies House Window

interface Details {
  status?: number;
  retryAt?: Date;
  cause?: unknown;
}

function retryAtFrom(headers: Headers, now: Date): Date {
  const seconds = Number(headers.get(RATE_LIMIT_RESET));
  if (!Number.isFinite(seconds) || seconds <= 0)
    return new Date(now.getTime() + DEFAULT_RETRY_DELAY_MS);
  return new Date(Math.max(seconds * 1000, now.getTime()));
}

export class CompaniesHouseError extends Error {
  readonly kind: CompaniesHouseErrorKind;
  readonly status: number | undefined;
  readonly retryAt: Date | undefined;

  private constructor(kind: CompaniesHouseErrorKind, message: string, details: Details = {}) {
    super(message, { cause: details.cause }); // cause keeps the original low-level error
    this.name = 'CompaniesHouseError'; // shows in stack traces and logs instead of plain "Error"
    this.kind = kind;
    this.status = details.status;
    this.retryAt = details.retryAt;
  }

  get retryable(): boolean {
    return RETRYABLE[this.kind];
  }

  // Named constructors ("static factory methods"): each one requires exactly what its kind needs.
  static unauthorized(where: string, status: number): CompaniesHouseError {
    return new CompaniesHouseError('unauthorized', `${where} → ${status}: check the API key`, {
      status,
    });
  }
  static rateLimited(where: string, retryAt: Date): CompaniesHouseError {
    return new CompaniesHouseError(
      'rate_limited',
      `${where} → 429: retry after ${retryAt.toISOString()}`,
      {
        status: 429,
        retryAt,
      },
    );
  }
  static serverError(where: string, status: number): CompaniesHouseError {
    return new CompaniesHouseError('server_error', `${where} → ${status}`, { status });
  }
  static timeout(where: string, cause: unknown): CompaniesHouseError {
    return new CompaniesHouseError('timeout', `${where}: no response in time`, { cause });
  }
  static network(where: string, cause: unknown): CompaniesHouseError {
    return new CompaniesHouseError('network', `${where}: could not reach the API`, { cause });
  }
  static invalidResponse(where: string, cause: unknown): CompaniesHouseError {
    return new CompaniesHouseError(
      'invalid_response',
      `${where}: response did not match the schema`,
      { cause },
    );
  }
  static http(where: string, status: number): CompaniesHouseError {
    return new CompaniesHouseError('http', `${where} → ${status}: unexpected HTTP response`, {
      status,
    });
  }
}

// 404 handled in client by returning null (not an error)
export function errorFromResponse(
  status: number,
  headers: Headers,
  where: string,
  now: Date = new Date(),
): CompaniesHouseError | null {
  if (status < 400) return null;
  // 403 because the API key might not have the necessary permissions
  if (status === 401 || status === 403) return CompaniesHouseError.unauthorized(where, status);
  if (status === 429) {
    return CompaniesHouseError.rateLimited(where, retryAtFrom(headers, now));
  }
  if (status >= 500) return CompaniesHouseError.serverError(where, status);
  return CompaniesHouseError.http(where, status);
}
