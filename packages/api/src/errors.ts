/** Every non-2xx response carries this body. */
export interface ApiErrorBody {
  error: {
    /** Stable machine-readable code, e.g. "invalid_parameter". */
    code: string;
    message: string;
    /** Present when one specific query parameter is at fault. */
    parameter?: string;
    /**
     * Matches X-Request-Id and every structured log record for this request
     * (#46) — quote it in a bug report and it finds the whole story server-side.
     */
    requestId?: string;
  };
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** RFC 9457 problem details, with the existing parameter and request id as extension members. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  parameter?: string;
  requestId?: string;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Whether the client asked for problem details by name. Only an explicit
 * `application/problem+json` counts (not `*\/*` or `application/*`), so every
 * existing client keeps today's body.
 */
export function wantsProblemJson(accept: string | string[] | undefined): boolean {
  const header = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return header.split(',').some((part) => {
    const [range = '', ...params] = part.trim().split(';');
    if (range.trim().toLowerCase() !== 'application/problem+json') return false;
    const q = params.map((p) => p.trim()).find((p) => /^q\s*=/i.test(p));
    return q ? Number(q.split('=')[1]) > 0 : true;
  });
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly parameter: string | undefined;
  /** Methods to advertise in `Allow`, which RFC 9110 requires on a 405. */
  readonly allow: string | undefined;
  /** Seconds to advertise in `Retry-After` on a 429 or 503. */
  retryAfterSeconds: number | undefined;
  /** Challenge to advertise in `WWW-Authenticate`, which RFC 9110 requires on a 401. */
  wwwAuthenticate: string | undefined;

  constructor(status: number, code: string, message: string, parameter?: string, allow?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.parameter = parameter;
    this.allow = allow;
    this.retryAfterSeconds = undefined;
    this.wwwAuthenticate = undefined;
  }

  static badRequest(message: string, parameter?: string): ApiError {
    return new ApiError(400, 'invalid_parameter', message, parameter);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  /** No valid API key was presented. */
  static unauthorized(message: string): ApiError {
    const error = new ApiError(401, 'unauthorized', message);
    error.wwwAuthenticate = 'Bearer realm="soroban-lens"';
    return error;
  }

  /** The client exhausted its token bucket, with the wait before one token is available. */
  static tooManyRequests(message: string, retryAfterSeconds: number): ApiError {
    const error = new ApiError(429, 'rate_limited', message);
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }

  /** Temporarily unable to serve, with the wait a client should honour. */
  static unavailable(message: string, retryAfterSeconds: number): ApiError {
    const error = new ApiError(503, 'unavailable', message);
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }

  toProblem(requestId?: string): ProblemDetails {
    return {
      type: `urn:soroban-lens:problem:${this.code}`,
      title: TITLES[this.status] ?? 'Error',
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(this.parameter ? { parameter: this.parameter } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.parameter ? { parameter: this.parameter } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}
