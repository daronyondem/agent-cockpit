import crypto from 'crypto';
import type { Request, Response, NextFunction } from '../types';

export function ensureCsrfToken(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const token = req.get('x-csrf-token') || (req.body as Record<string, unknown>)?._csrf;
  if (!token || token !== req.session.csrfToken) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}
