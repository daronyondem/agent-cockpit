import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction, Express } from '../types';
import type { AppConfig } from '../types';

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many authentication attempts, please try again later.',
});

function verifyEmail(config: AppConfig) {
  const allowed = (config.ALLOWED_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return (
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: (err: Error | null, user?: AuthUser | false, info?: { message: string }) => void,
  ) => {
    const email = profile.emails?.[0]?.value;
    if (email && allowed.includes(email.toLowerCase())) {
      return done(null, { id: profile.id, email, displayName: profile.displayName });
    }
    return done(null, false, { message: 'Access denied: unauthorized email.' });
  };
}

export function setupAuth(app: Express, config: AppConfig): void {
  const hasGitHub = config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET;

  passport.use(new GoogleStrategy(
    {
      clientID: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL: config.GOOGLE_CALLBACK_URL,
    },
    verifyEmail(config),
  ));

  if (hasGitHub) {
    passport.use(new GitHubStrategy(
      {
        clientID: config.GITHUB_CLIENT_ID!,
        clientSecret: config.GITHUB_CLIENT_SECRET!,
        callbackURL: config.GITHUB_CALLBACK_URL || '',
        scope: ['user:email'],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verifyEmail(config) as any,
    ));
  }

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj: Express.User, done) => done(null, obj));

  app.use(passport.initialize());
  app.use(passport.session());

  // ── Login page ──────────────────────────────────────────────────────────────
  app.get('/auth/login', (_req: Request, res: Response) => {
    const githubBtn = hasGitHub
      ? '<a class="btn github" href="/auth/github"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>Sign in with GitHub</a>'
      : '';
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Sign In</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh}
.box{text-align:center;padding:2.5rem;border:1px solid #334155;border-radius:16px;min-width:320px}
h1{font-size:1.5rem;margin-bottom:.5rem}
p{color:#94a3b8;margin-bottom:1.5rem;font-size:.9rem}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;color:#fff;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn+.btn{margin-top:10px}
.google{background:#4285f4}
.github{background:#24292f}
</style></head><body>
<div class="box">
<h1>Agent Cockpit</h1>
<p>Sign in to continue</p>
<a class="btn google" href="/auth/google"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Sign in with Google</a>
${githubBtn}
</div></body></html>`);
  });

  // ── Google OAuth ────────────────────────────────────────────────────────────
  app.get('/auth/google', authLimiter, passport.authenticate('google', { scope: ['profile', 'email'] }));

  app.get('/auth/google/callback', authLimiter,
    passport.authenticate('google', { failureRedirect: '/auth/denied' }),
    (_req: Request, res: Response) => res.redirect('/'));

  // ── GitHub OAuth ────────────────────────────────────────────────────────────
  if (hasGitHub) {
    app.get('/auth/github', authLimiter, passport.authenticate('github', { scope: ['user:email'] }));

    app.get('/auth/github/callback', authLimiter,
      passport.authenticate('github', { failureRedirect: '/auth/denied' }),
      (_req: Request, res: Response) => res.redirect('/'));
  }

  // ── Denied / Logout ─────────────────────────────────────────────────────────
  app.get('/auth/denied', (_req: Request, res: Response) => {
    res.status(403).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Access Denied</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center;padding:2rem;border:1px solid #334155;border-radius:12px}h1{color:#ef4444;font-size:2rem;margin-bottom:.5rem}p{color:#94a3b8}a{color:#60a5fa;text-decoration:none}</style></head><body><div class="box"><h1>Access Denied</h1><p>This dashboard is private. Your account is not authorized.</p><p><a href="/auth/login">Try a different account</a></p></div></body></html>`);
  });

  app.get('/auth/logout', (req: Request, res: Response) => {
    try {
      if (req.session) {
        req.session.destroy((err) => {
          if (err) console.error('Session destroy error:', err);
          res.clearCookie('connect.sid', { path: '/' });
          res.redirect('/');
        });
      } else {
        res.clearCookie('connect.sid', { path: '/' });
        res.redirect('/');
      }
    } catch (err) {
      console.error('Logout error:', err);
      res.clearCookie('connect.sid', { path: '/' });
      res.redirect('/');
    }
  });
}

function isLocalRequest(req: Request): boolean {
  const host = req.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isLocalRequest(req) || req.isAuthenticated()) return next();
  res.redirect('/auth/login');
}
