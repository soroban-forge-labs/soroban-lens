/** Every non-2xx response carries this body. */
export interface ApiErrorBody {
  error: {
    /** Stable machine-readable code, e.g. "invalid_parameter". */
    code: string;
    message: string;
    /** Present when one specific query parameter is at fault. */
    parameter?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly parameter: string | undefined;
  /** Methods to advertise in `Allow`, which RFC 9110 requires on a 405. */
  readonly allow: string | undefined;

  constructor(status: number, code: string, message: string, parameter?: string, allow?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.parameter = parameter;
    this.allow = allow;
  }

  static badRequest(message: string, parameter?: string): ApiError {
    return new ApiError(400, 'invalid_parameter', message, parameter);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.parameter ? { parameter: this.parameter } : {}),
      },
    };
  }
}
