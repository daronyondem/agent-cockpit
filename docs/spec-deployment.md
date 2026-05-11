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
5. **Structured logging** — uses `console.log`/`console.error`
6. **Multi-user support** — settings are global, not per-user

## Deployment

**Local development:**
```bash
cp .env.example .env   # Fill in values
npm install
npm start              # Listens on PORT (default 3334)
```

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

The Vite dev server listens on port `5174` and proxies `/api`, `/auth`, and `/logo-full-no-text.svg` to the PM2-managed Agent Cockpit backend at `http://localhost:3334`. For production/static serving:

```bash
npm run mobile:build
```

The build writes to `public/mobile/`, including the generated shell, manifest, hashed JS/CSS, SVG icon, PNG manifest icons, and 180x180 `apple-touch-icon.png` for iOS home-screen installs. The existing Express static mount serves these files at `/mobile/` after normal authentication. A phone can open `https://<agent-cockpit-host>/mobile/` and use Add to Home Screen for an installable PWA. No Xcode, Expo Go, EAS, Apple signing, TestFlight, or App Store distribution is required for the supported mobile path.
