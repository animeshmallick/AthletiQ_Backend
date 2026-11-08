import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { mapPgError } from '../lib/pg-errors.js';
import { validationError } from '../lib/validation.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = validationError(err);
  } else if (isBodyParserError(err)) {
    appError =
      err.type === 'entity.too.large'
        ? new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large')
        : AppError.badRequest('Malformed request body');
  } else {
    appError =
      mapPgError(err) ?? new AppError('INTERNAL', 'Something went wrong. Please try again.');
  }

  if (appError.status >= 500) {
    logger.error({ err, requestId: req.id, path: req.path }, 'Unhandled error');
  } else if (appError.code !== 'NOT_FOUND' && appError.code !== 'UNAUTHENTICATED') {
    logger.debug({ code: appError.code, requestId: req.id }, appError.message);
  }

  if (res.headersSent) return;

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      requestId: req.id,
    },
  });
};
