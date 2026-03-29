const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

function setupAuth(app, config) {
  passport.use(new GoogleStrategy(
    {
      clientID: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL: config.GOOGLE_CALLBACK_URL
    },
    (accessToken, refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value;
      if (email === config.ALLOWED_EMAIL) {
        return done(null, { id: profile.id, email, displayName: profile.displayName });
      }
      return done(null, false, { message: 'Access denied: unauthorized email.' });
    }
  ));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj, done) => done(null, obj));

  app.use(passport.initialize());
  app.use(passport.session());

  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/auth/denied' }),
    (req, res) => res.redirect('/'));

  app.get('/auth/denied', (req, res) => {
    res.status(403).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Access Denied</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center;padding:2rem;border:1px solid #334155;border-radius:12px}h1{color:#ef4444;font-size:2rem;margin-bottom:.5rem}p{color:#94a3b8}a{color:#60a5fa;text-decoration:none}</style></head><body><div class="box"><h1>🚫 Access Denied</h1><p>This dashboard is private. Your Google account is not authorized.</p><p><a href="/auth/google">Try a different account</a></p></div></body></html>`);
  });

  app.get('/auth/logout', (req, res) => {
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

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/auth/google');
}

module.exports = { setupAuth, requireAuth };
