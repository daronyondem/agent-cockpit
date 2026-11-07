// ── HTTP Types ───────────────────────────────────────────────────────

import type { Request, Response, NextFunction, Express } from 'express';
import type {} from 'express-session';

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    passport?: { user?: unknown };
    reAuthPopup?: boolean;
    passkeyRegistration?: {
      challenge: string;
      rpId: string;
      origin: string;
      name?: string;
    };
    passkeyAuthentication?: {
      challenge: string;
      rpId: string;
      origin: string;
      popup?: boolean;
      next?: string;
    };
  }
}

// Re-export Express types for convenience
export type { Request, Response, NextFunction, Express };
