import type { AuthUser } from '../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. */
      user?: AuthUser;
      /** Correlation id; echoed in the `X-Request-Id` response header and error bodies. */
      id: string;
    }
  }
}

export {};
