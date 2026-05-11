import type { Request, Response } from '../../types';

/** Extract a named route param as a string (Express 5 types them as string | string[]). */
export function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

export function queryStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => queryStrings(item));
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function isCliProfileResolutionError(err: unknown): boolean {
  const message = (err as Error).message || '';
  return message.startsWith('CLI profile') || message.includes('CLI profile vendor');
}

export function sendError(res: Response, status: number, err: unknown): void {
  res.status(status).json({ error: (err as Error).message || String(err) });
}
