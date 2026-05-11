# 9. Export, Limitations & Deployment

[← Back to index](SPEC.md)

---

## Markdown Export Format

**Entire conversation:**
```markdown
# {title}

**Created:** {createdAt}
**Backend:** {backend}

---

### User — {timestamp}
*Backend: {backend}*

{content}

### Assistant — {timestamp}
*Backend: {backend}*

{content}

---
*Session reset — {timestamp}*
---
```

**Single session:**
```markdown
# {title}

**Session {number}** | Started: {startedAt}
**Conversation ID:** {id}

---

### User — {timestamp}
*Backend: {backend}*

{content}
```

## Known Limitations

1. **Input validation** — no validation library, minimal file upload name sanitization, no request body type/length validation
2. **Linting & formatting** — no ESLint or Prettier
3. **Conversation pagination** — `listConversations()` loads all into memory
4. **Conversation attachment MIME validation** — Multer accepts any file type for chat attachments; Knowledge Base ingestion has separate format handlers and pre-flight guards
5. **Structured logging coverage** — `src/utils/logger.ts` exists and the WebSocket server uses it for the first operational slice, but many older backend modules still write directly to `console`
6. **Multi-user support** — settings are global, not per-user

## Deployment

**Local development:**
```bash
cp .env.example .env   # Fill in values
npm install
npm start              # Listens on PORT (default 3334)
```

`LOG_LEVEL` controls the structured logger threshold for modules that have migrated to `src/utils/logger.ts`. Supported values are `error`, `warn`, `info`, and `debug`; invalid or missing values fall back to `info`. Metadata keys that look like credentials or session material are redacted before log lines are written.

The main `/v2/` web UI is built with Vite from `web/AgentCockpitWeb/` into `public/v2-built/`. Normal development and production both use the same one-server architecture: Express serves backend routes and the built web UI. A separate Vite dev server is not required for the normal `agent-cockpit-dev` workflow. After editing V2 frontend source, restart the PM2-managed dev server; startup preflight detects missing or stale main V2 web assets, runs `npm run web:build`, writes `public/v2-built/.agent-cockpit-build.json`, then starts serving `/v2/`. The same startup preflight also detects missing or stale mobile PWA assets, runs `npm run mobile:build`, and writes `public/mobile-built/.agent-cockpit-build.json` before listen. Explicit local checks are available:

```bash
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run mobile:build
```

`WEB_BUILD_MODE=skip` disables both main V2 web and mobile startup preflights for tests or unusual deployments that provision assets out of band. If no previous build exists and the build fails, startup fails. If a previous build exists and a rebuild fails, the server logs the error and serves the previous build.

Self-update runs root `npm install`, mobile `npm --prefix mobile/AgentCockpitPWA install`, the V2 web build, and the mobile PWA build before PM2 restart. If either dependency install or either build fails, the update returns a failed result and does not restart; startup preflight remains the fallback for manual git operations or interrupted updates. This keeps every generated asset tree served by Express (`/v2/` and `/mobile/`) in sync with the pulled source. See [ADR-0049](adr/0049-retire-v2-globals-and-build-mobile-assets-during-updates.md) and [ADR-0050](adr/0050-serve-mobile-pwa-from-ignored-build-output.md).

**Remote access via ngrok:**
```bash
ngrok http 3334
```
For a fresh exposed backend, set `AUTH_SETUP_TOKEN` before first-run setup so a remote visitor cannot claim the owner account. Legacy OAuth callback URLs are only relevant when `AUTH_ENABLE_LEGACY_OAUTH=true`.

**Local auth reset:**
```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```
The reset command requires local filesystem access. It can reset the owner password, disable passkey-required mode, delete session files under `data/sessions`, and print replacement recovery codes.

**Mobile PWA development, build, and install:**
```bash
npm install
npm run mobile:dev
```

The mobile Vite dev server listens on port `5174` and proxies `/api`, `/auth`, and `/logo-full-no-text.svg` to the PM2-managed Agent Cockpit backend at `http://localhost:3334`. For production/static serving:

```bash
npm run mobile:build
```

The build writes to ignored `public/mobile-built/`, including the generated shell, manifest, hashed JS/CSS, SVG icon, PNG manifest icons, 180x180 `apple-touch-icon.png` for iOS home-screen installs, and `.agent-cockpit-build.json` when produced by startup/self-update preflight. Express explicitly mounts that directory at `/mobile/` after normal authentication, before the general `public/` static mount. A phone can open `https://<agent-cockpit-host>/mobile/` and use Add to Home Screen for an installable PWA. No Xcode, Expo Go, EAS, Apple signing, TestFlight, or App Store distribution is required for the supported mobile path.
