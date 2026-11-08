export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * Expected, client-facing error. Anything that is not an AppError is treated as an
 * unexpected 500 and its message is never leaked to the client.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError('BAD_REQUEST', message, details);
  }
  static unauthenticated(message = 'Authentication required') {
    return new AppError('UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError('FORBIDDEN', message);
  }
  static notFound(entity = 'Resource') {
    return new AppError('NOT_FOUND', `${entity} not found`);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError('CONFLICT', message, details);
  }
  static unprocessable(message: string, details?: unknown) {
    return new AppError('UNPROCESSABLE', message, details);
  }
}
