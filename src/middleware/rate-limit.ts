import { rateLimit } from 'express-rate-limit';
import { isTest } from '../config/env.js';

const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please slow down and try again shortly.',
    },
  });
};

/** Broad protection for the whole API. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});

/** Tight limit for credential endpoints (per IP); per-account lockout is enforced separately. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});
