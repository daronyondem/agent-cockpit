import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction, Express } from '../types';
import type { AppConfig } from '../types';

export type AuthProvider = 'google' | 'github';

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many authentication attempts, please try again later.',
});

function verifyEmail(config: AppConfig, provider: AuthProvider) {
  const allowed = (config.ALLOWED_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return (
    _accessToken: string,
    _refreshToken: string,
    profile: passport.Profile,
    done: (err: Error | null, user?: AuthUser | false, info?: { message: string }) => void,
  ) => {
    const email = profile.emails?.[0]?.value;
    if (email && allowed.includes(email.toLowerCase())) {
      return done(null, { id: profile.id, email, displayName: profile.displayName, provider });
    }
    return done(null, false, { message: 'Access denied: unauthorized email.' });
  };
}

// ── Login page assets ────────────────────────────────────────────────────────
// SVGs and CSS are extracted to module scope to keep the /auth/login handler
// readable. The CSS is lifted (editorial-only rules) from the V2 design-system
// handoff's login.css; tokens mirror public/v2/src/tokens.css and are inlined
// here because /v2/src/tokens.css sits behind requireAuth.

const GOOGLE_G_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

const GITHUB_OCTO_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;

const ARROW_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>`;

const LOGIN_CSS = `
:root{
  --brand-cyan:#02A6F5;
  --status-running:#02A6F5;
  --status-done:#3FB27F;
  --status-subagent:#8B72E0;
  --dur-1:120ms;
  --easing:cubic-bezier(.2,.7,.2,1);
}
html[data-direction="editorial"]{
  --bg:#FAF8F4; --bg-sunk:#F3EFE8;
  --surface:#FFFFFF; --surface-2:#F7F3EC;
  --border:rgba(30,25,18,.09); --border-strong:rgba(30,25,18,.16);
  --text:#1A1613; --text-2:#4A453E; --text-3:#847D72; --text-4:#B2AB9F;
  --accent:var(--brand-cyan); --accent-ink:#0587C3; --accent-soft:rgba(2,166,245,.10);
  --shadow-1:0 1px 0 rgba(30,25,18,.04),0 1px 2px rgba(30,25,18,.04);
  --shadow-2:0 2px 6px rgba(30,25,18,.06),0 10px 24px -12px rgba(30,25,18,.10);
  --focus-ring:0 0 0 3px rgba(2,166,245,.22);
  --ui-font:"General Sans",ui-sans-serif,system-ui,sans-serif;
  --prose-font:"Instrument Serif","Iowan Old Style",Georgia,serif;
  --mono-font:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-md:11px;
}
html[data-direction="editorial"][data-theme="dark"]{
  --bg:#14110E; --bg-sunk:#0E0C0A;
  --surface:#1B1714; --surface-2:#221D19;
  --border:rgba(255,248,232,.07); --border-strong:rgba(255,248,232,.13);
  --text:#F2ECE0; --text-2:#C7BFB1; --text-3:#8F877A; --text-4:#5C564C;
  --accent-ink:#5BC7FF; --accent-soft:rgba(2,166,245,.14);
  --shadow-1:0 1px 0 rgba(0,0,0,.5),0 1px 2px rgba(0,0,0,.4);
  --shadow-2:0 2px 6px rgba(0,0,0,.4),0 16px 32px -12px rgba(0,0,0,.6);
}

*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{
  font-family:var(--ui-font);
  background:var(--bg); color:var(--text);
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}

.login{
  display:grid;
  grid-template-columns:minmax(460px,1fr) minmax(480px,1.2fr);
  height:100%; width:100%;
  background:var(--bg); color:var(--text);
  font-family:var(--ui-font); min-height:0;
}

.login-left{
  display:flex; flex-direction:column;
  padding:28px 40px;
  min-width:0; min-height:0;
  background:var(--bg); position:relative;
}
.login-topbar{
  display:flex; align-items:center; gap:10px;
  color:var(--text); margin-bottom:28px;
}
.login-topbar .mark{ color:var(--accent); display:inline-flex; align-items:center; }
.login-topbar .mark img{ width:90px; height:35px; display:block; }
.login-topbar .wordmark{
  font-weight:600; letter-spacing:-.01em; font-size:14.5px; color:var(--text);
}
.login-topbar .wordmark em{
  font-style:normal; color:var(--text-3); font-weight:500; margin-left:6px;
}
.login-topbar .right{
  margin-left:auto;
  display:inline-flex; align-items:center; gap:10px;
  font-size:12.5px; color:var(--text-3);
}
.login-topbar .right a{
  color:var(--text-2); text-decoration:none;
  border-bottom:1px solid transparent;
  transition:border-color var(--dur-1) var(--easing);
}
.login-topbar .right a:hover{ border-bottom-color:var(--text-3); color:var(--text); }

.login-body{
  flex:1; min-height:0;
  display:flex; flex-direction:column; justify-content:center;
  max-width:420px; margin:0 auto; width:100%; padding:0 8px;
}
.login-eyebrow{
  font-family:var(--mono-font);
  font-size:11px; letter-spacing:.18em; text-transform:uppercase;
  color:var(--text-3); margin-bottom:14px;
  display:inline-flex; align-items:center; gap:8px;
}
.login-eyebrow .dot{
  width:5px; height:5px; border-radius:999px;
  background:var(--status-running);
  box-shadow:0 0 0 3px color-mix(in oklch,var(--status-running),transparent 80%);
  animation:pulse 1.8s infinite;
}
@keyframes pulse{
  0%,100%{ box-shadow:0 0 0 3px color-mix(in oklch,var(--status-running),transparent 80%); }
  50%    { box-shadow:0 0 0 5px color-mix(in oklch,var(--status-running),transparent 90%); }
}

.login-title{
  font-family:var(--prose-font);
  font-size:46px; line-height:1.05; letter-spacing:-.015em;
  font-weight:500; margin:0 0 14px; color:var(--text); text-wrap:pretty;
}
.login-title em{ font-style:italic; color:var(--accent); }
.login-sub{
  font-size:14.5px; line-height:1.55;
  color:var(--text-2); margin:0 0 28px; max-width:380px;
}
.login-sub b{ color:var(--text); font-weight:600; }

.providers{
  display:flex; flex-direction:column; gap:10px; margin-bottom:20px;
}
.provider-btn{
  display:grid;
  grid-template-columns:22px 1fr auto;
  align-items:center; gap:14px; width:100%;
  padding:13px 16px;
  background:var(--surface);
  border:1px solid var(--border-strong);
  color:var(--text);
  border-radius:var(--r-md);
  font:inherit; font-size:14.5px; font-weight:500; letter-spacing:-.005em;
  text-align:left; text-decoration:none;
  box-shadow:var(--shadow-1);
  transition:
    transform var(--dur-1) var(--easing),
    border-color var(--dur-1) var(--easing),
    background-color var(--dur-1) var(--easing);
  position:relative;
}
.provider-btn:hover{
  border-color:var(--accent);
  transform:translateY(-1px);
  box-shadow:
    0 0 0 3px color-mix(in oklch,var(--accent),transparent 85%),
    var(--shadow-2);
}
.provider-btn:active{ transform:translateY(0); }
.provider-btn:focus-visible{
  outline:none;
  box-shadow:var(--focus-ring), var(--shadow-1);
  border-color:var(--accent);
}
.provider-btn .mark{
  width:22px; height:22px;
  display:inline-flex; align-items:center; justify-content:center;
}
.provider-btn .right{ display:inline-flex; align-items:center; gap:8px; }
.provider-btn .arrow{
  color:var(--text-3);
  display:inline-flex;
  transition:transform var(--dur-1) var(--easing), color var(--dur-1) var(--easing);
}
.provider-btn:hover .arrow{ transform:translateX(2px); color:var(--accent); }
.provider-btn .tag{
  font-family:var(--mono-font);
  font-size:10px; letter-spacing:.1em; text-transform:uppercase;
  color:var(--accent);
  background:var(--accent-soft);
  border:1px solid color-mix(in oklch,var(--accent),transparent 70%);
  padding:1px 6px; border-radius:4px; margin-right:4px;
}

.login-legal{
  font-size:11.5px; line-height:1.55;
  color:var(--text-3); margin-top:16px;
}
.login-legal a{
  color:var(--text-2); text-decoration:none;
  border-bottom:1px solid var(--border-strong);
}
.login-legal a:hover{ color:var(--text); border-color:var(--text-3); }

.login-foot{
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding-top:20px; margin-top:auto;
  font-family:var(--mono-font); font-size:10.5px;
  color:var(--text-3); letter-spacing:.06em;
}
.login-foot .links{ display:inline-flex; gap:14px; }
.login-foot a{ color:var(--text-3); text-decoration:none; }
.login-foot a:hover{ color:var(--text); }
.login-foot .status{
  display:inline-flex; align-items:center; gap:6px;
  color:var(--status-done);
}
.login-foot .status .dot{
  width:6px; height:6px; border-radius:999px; background:var(--status-done);
}

.login-right{
  position:relative; overflow:hidden;
  background:var(--bg-sunk);
  border-left:1px solid var(--border);
  display:flex; flex-direction:column;
  min-width:0; min-height:0;
}
.preview-editorial{
  position:relative; width:100%; height:100%;
  padding:32px;
  display:flex; flex-direction:column; gap:20px;
  background:
    radial-gradient(600px 300px at 85% 10%, color-mix(in oklch,var(--accent),transparent 92%), transparent 70%),
    radial-gradient(500px 360px at 15% 90%, color-mix(in oklch,var(--status-subagent),transparent 94%), transparent 70%),
    var(--bg-sunk);
}
.preview-editorial .pe-quote{
  font-family:var(--prose-font);
  font-size:28px; line-height:1.25; letter-spacing:-.01em;
  color:var(--text); max-width:440px; margin:0; text-wrap:pretty;
}
.preview-editorial .pe-quote em{ font-style:italic; color:var(--accent); }
.preview-editorial .pe-attr{
  font-family:var(--mono-font);
  font-size:11px; letter-spacing:.12em; text-transform:uppercase;
  color:var(--text-3); margin-top:8px;
}

@media (max-width:960px){
  .login{ grid-template-columns:1fr; }
  .login-right{ display:none; }
}
`;

export function setupAuth(app: Express, config: AppConfig): void {
  const hasGitHub = config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET;

  passport.use(new GoogleStrategy(
    {
      clientID: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL: config.GOOGLE_CALLBACK_URL,
    },
    verifyEmail(config, 'google'),
  ));

  if (hasGitHub) {
    passport.use(new GitHubStrategy(
      {
        clientID: config.GITHUB_CLIENT_ID!,
        clientSecret: config.GITHUB_CLIENT_SECRET!,
        callbackURL: config.GITHUB_CALLBACK_URL || '',
        scope: ['user:email'],
      },
      verifyEmail(config, 'github'),
    ));
  }

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj: Express.User, done) => done(null, obj));

  app.use(passport.initialize());
  app.use(passport.session());

  // Marks the session as "opened from a popup re-auth window" so the final
  // callback lands on /auth/popup-done (which self-closes) instead of /.
  // The flag survives the Google/GitHub roundtrip because express-session
  // persists through the OAuth redirect.
  const markPopupIfRequested = (req: Request, _res: Response, next: NextFunction): void => {
    if (req.query.popup === '1' && req.session) {
      (req.session as unknown as { reAuthPopup?: boolean }).reAuthPopup = true;
    }
    next();
  };

  const finishAuth = (req: Request, res: Response): void => {
    const sess = req.session as unknown as { reAuthPopup?: boolean } | undefined;
    if (sess && sess.reAuthPopup) {
      delete sess.reAuthPopup;
      res.redirect('/auth/popup-done');
      return;
    }
    res.redirect('/');
  };

  // ── Login page ──────────────────────────────────────────────────────────────
  // Editorial two-column layout: auth card on the left, editorial pull-quote +
  // floating "live session" card on the right. Real brand logos on the OAuth
  // buttons (standard OAuth UX). Theme follows the main V2 app's `ac:v2:theme`
  // localStorage key or prefers-color-scheme.
  app.get('/auth/login', (req: Request, res: Response) => {
    const popup = req.query.popup === '1' ? '?popup=1' : '';
    const githubBtn = hasGitHub
      ? `<a class="provider-btn" href="/auth/github${popup}">
          <span class="mark">${GITHUB_OCTO_SVG}</span>
          <span class="label">Continue with GitHub</span>
          <span class="right">
            <span class="tag">Recommended</span>
            <span class="arrow">${ARROW_SVG}</span>
          </span>
        </a>`
      : '';
    res.send(`<!DOCTYPE html>
<html lang="en" data-direction="editorial" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Agent Cockpit</title>
<script>
(function(){
  try {
    var saved = localStorage.getItem('ac:v2:theme') || 'system';
    var resolved = saved;
    if (saved === 'system') {
      resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (e) {}
})();
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap" rel="stylesheet">
<style>${LOGIN_CSS}</style>
</head>
<body>
<div class="login">
  <div class="login-left">
    <div class="login-topbar">
      <span class="mark"><img src="/logo-full-no-text.svg" alt="Agent Cockpit"></span>
      <span class="wordmark">Agent Cockpit</span>
      <span class="right">
        <a href="https://github.com/daronyondem/agent-cockpit" target="_blank" rel="noopener">Readme.md here</a>
      </span>
    </div>

    <div class="login-body">
      <div class="login-eyebrow"><span class="dot"></span>Ready</div>
      <h1 class="login-title">The cockpit <em>is listening.</em><br>Sign in to take the controls.</h1>
      <p class="login-sub">Agent Cockpit is where you <b>plan, watch, and steer</b> long-running agents across your workspace. One account. Two ways in.</p>

      <div class="providers">
        <a class="provider-btn" href="/auth/google${popup}">
          <span class="mark">${GOOGLE_G_SVG}</span>
          <span class="label">Continue with Google</span>
          <span class="right">
            <span class="arrow">${ARROW_SVG}</span>
          </span>
        </a>
        ${githubBtn}
      </div>

      <p class="login-legal">
        By continuing you agree to our <a href="#">Terms</a> and
        <a href="#">Privacy&nbsp;Policy</a>. We only use your account to
        identify you — never to post, read, or email on your behalf.
      </p>
    </div>

    <div class="login-foot">
      <span class="status"><span class="dot"></span>All systems operational</span>
      <span class="links">
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
        <a href="https://github.com/daronyondem/agent-cockpit/tree/main/docs" target="_blank" rel="noopener">Docs</a>
      </span>
    </div>
  </div>

  <div class="login-right">
    <div class="preview-editorial">
      <p class="pe-quote">
        &ldquo;Keeping my entire <em>knowledge base</em>, <em>memory</em> in my hands, accessing from anywhere I need, using the
        <em>multiple CLI vendors</em>, subscriptions I have. A central cockpit for my day to day AI work.&rdquo;
      </p>
      <div class="pe-attr">Daron Yondem · Sr AI/ML Architect, AWS</div>
    </div>
  </div>
</div>
</body>
</html>`);
  });

  // Popup-mode terminal page: the re-auth popup lands here instead of /, posts
  // a message to the opener so the main window can dismiss its "session
  // expired" dialog, then self-closes. Same-origin by construction — the
  // postMessage targetOrigin is this response's origin.
  app.get('/auth/popup-done', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}p{color:#94a3b8}</style>
</head><body><p>Signed in. You can close this window.</p>
<script>
(function(){
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'ac-reauth-ok' }, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch(e){} }, 50);
})();
</script></body></html>`);
  });

  // ── Google OAuth ────────────────────────────────────────────────────────────
  app.get('/auth/google', authLimiter, markPopupIfRequested, passport.authenticate('google', { scope: ['profile', 'email'] }));

  app.get('/auth/google/callback', authLimiter,
    passport.authenticate('google', { failureRedirect: '/auth/denied' }),
    finishAuth);

  // ── GitHub OAuth ────────────────────────────────────────────────────────────
  if (hasGitHub) {
    app.get('/auth/github', authLimiter, markPopupIfRequested, passport.authenticate('github', { scope: ['user:email'] }));

    app.get('/auth/github/callback', authLimiter,
      passport.authenticate('github', { failureRedirect: '/auth/denied' }),
      finishAuth);
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
  // API requests get a JSON 401 so the client can show a session-expired UI
  // instead of receiving the HTML login page (which breaks `res.json()`).
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.redirect('/auth/login');
}

// Returns the logged-in user's display name + identity provider for the
// sidebar footer. Requests that bypass OAuth (localhost) and arrive without a
// user object get null fields so the client can render a neutral placeholder.
export function meHandler(req: Request, res: Response): void {
  const u = req.user as { displayName?: string; email?: string; provider?: AuthProvider } | undefined;
  res.json({
    displayName: u?.displayName ?? null,
    email: u?.email ?? null,
    provider: u?.provider ?? null,
  });
}
