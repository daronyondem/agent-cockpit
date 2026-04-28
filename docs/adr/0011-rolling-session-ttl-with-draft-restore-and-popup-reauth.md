---
id: 0011
title: Rolling 24h session TTL with localStorage draft restore and popup re-auth
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [auth, sessions, ux, historical]
affects:
  - server.ts
  - src/middleware/auth.ts
  - public/v2/src/streamStore.js
  - public/v2/src/shell.jsx
  - public/v2/src/api.js
  - test/auth.test.ts
  - test/streamStore.test.ts
  - docs/spec-server-security.md
---

## Context

Three coupled user pain points:

1. **Session expiry mid-workflow.** `express-session` was configured with `cookie.maxAge = 24h` and `rolling: false`. The 24-hour clock started ticking the moment the user logged in and ran down regardless of activity. Users mid-conversation would hit "session expired" with no warning and lose their place.
2. **Lost typed input on session expiry.** When `POST /conversations/:id/message` returned 401, the optimistic UI had already cleared the composer. The user's typed message — sometimes paragraphs of carefully-constructed prompt — was gone. The user's reaction in the issue: *"I have lost the message that I wrote."*
3. **Full-page redirect on re-auth lost everything else.** Even if the user was willing to re-login, the redirect blew away their open conversations, scroll position, attachments, in-flight streams, and dialog state. They came back to a blank cockpit.

These three are coupled because each fix on its own is incomplete: longer TTL alone still loses input on the expiry it doesn't fully prevent; draft restore alone doesn't help if the user closes the tab assuming all is lost; popup re-auth alone is wasteful when sessions could simply not expire on active users.

## Decision

Ship all three together:

**1. Rolling 24h session TTL.** `server.ts` configures `express-session` with `rolling: true` + `cookie.maxAge = 24h` (and `FileStore.ttl = 24h`). Because the session middleware runs *before* `requireAuth`, every request — authenticated or not — re-issues the cookie with a fresh 24h expiry. Active users effectively never expire; idle users still revoke after 24h of inactivity.

**2. localStorage draft restore.** `streamStore.js` writes `{ text, attachments }` to `localStorage` under key `ac:v2:draft:<convId>` on every input change. Critically, `flushDraftNow(convId)` is called **synchronously before the optimistic input wipe** at send-time, so a failure between optimistic-clear and POST-resolve still leaves a recoverable draft on reload. Restore triggers on conversation load (`readDraft` hydrates `ConvState`) and on POST failure (input snapshot rolled back into `ConvState.input` + `ConvState.pendingAttachments`). Clear triggers only on send success.

**3. Popup re-auth.** When `requireAuth` returns 401 mid-session, `shell.jsx` opens `window.open('/auth/login?popup=1', 'ac-reauth', ...)` instead of redirecting the parent tab. `?popup=1` flows through `markPopupIfRequested` which sets `req.session.reAuthPopup = true`, surviving the OAuth roundtrip. After OAuth callback, `finishAuth` redirects to `/auth/popup-done` instead of `/`. That terminal page calls `window.opener.postMessage({type:'ac-reauth-ok'}, window.location.origin)` then `window.close()`. The parent tab's listener invalidates the cached CSRF token (`AgentApi.invalidateCsrfToken()`) and sweeps stale "session expired" stream-error cards (`StreamStore.clearAllStreamErrors()`). No reload. Re-entrancy is guarded by `reAuthInFlightRef`.

**Fallbacks.** Popup blocked → full-page `/auth/login` redirect (draft survives via localStorage). Popup closed without success → `GET /api/csrf-token` probe; still 401 → error alert.

## Alternatives Considered

- **Long-lived absolute TTL (e.g. 30 days) instead of rolling.** Rejected: doesn't solve mid-workflow expiry, only delays it. Active users would still hit the 30-day wall someday, and inactive users would have month-old cookies sitting around. Rolling gives "indefinite for active users, 24h idle revocation" which matches the security goal exactly.
- **No draft restore — accept that the user types it again.** Rejected: this was the actual user-pain trigger. The original feedback message was specifically about lost typed input. Shipping rolling TTL alone wouldn't have addressed it because expiry can still happen (24h idle, server restart, cookie eviction).
- **Server-side draft store** (POST partial drafts to the server periodically). Rejected: attachments already live server-side under `data/chat/artifacts/`; only client *references* needed persisting. Server-side draft sync would add an endpoint, a write path, an eviction story, and a cross-tab sync semantic for vanishingly-rare benefit (cross-device drafts).
- **`sessionStorage` instead of `localStorage` for drafts.** Rejected: `sessionStorage` doesn't survive a page reload in the worst case (some browsers clear it on unload-without-navigation). The point of the draft is to survive exactly that.
- **Full-page redirect for re-auth (no popup).** Considered as the cheaper option — *"rolling is the headline fix; ship it first and see if you still hit it."* Decided against: full-page redirect blows away everything not in localStorage, including in-flight streams, dialog state, and scroll position. Popup preserves the parent tab's full state. Full-page redirect retained as the popup-blocker fallback.
- **Inline iframe re-auth.** Rejected: OAuth providers (Google, GitHub) refuse to render in iframes (`X-Frame-Options: DENY`). Popup is the only mechanism that works for OAuth.
- **Silent token refresh** (issue a refresh token, swap it for a new session in the background). Rejected: requires re-architecting the auth model around refresh tokens, which is a much larger change. Rolling TTL is the much smaller delta that achieves the same user-visible result for active sessions.
- **MCP write filter / API-key bypass for the draft endpoint.** Not raised — drafts are localStorage-only.
- **No `?popup=1` flag — let the OAuth callback always go to `/auth/popup-done`.** Rejected: full-page logins (first-time visit, popup-blocked fallback) need to land on the cockpit, not on a self-closing terminal page. The flag distinguishes the two flows cleanly through the OAuth roundtrip via `req.session.reAuthPopup`.
- **Add an absolute upper-bound TTL on top of the rolling window.** Not implemented. Discussed: the rolling sliding-window has no absolute cap, so an attacker who has stolen a cookie and keeps making requests never has the session forcibly expire. Accepted as the cost of eliminating daily user pain. If a security audit ever demands an absolute cap, that's a follow-up — likely a separate "max session age" check that revokes regardless of activity.

## Consequences

- + Active users effectively never expire mid-workflow. The pain that motivated this work disappears for the common case.
- + Idle users still revoke after 24h, preserving the "stolen laptop" recovery story.
- + Lost typed input is impossible (or recoverable on reload) because `flushDraftNow` runs before the optimistic clear.
- + Re-auth preserves the parent tab's full state. Open conversations, streams, attachments, scroll position all survive.
- + Multiple fallbacks: localStorage draft → popup re-auth → full-page redirect → error alert. Each layer degrades gracefully when the next is unavailable.
- - **No absolute TTL upper bound.** A stolen cookie used on an active schedule is forever-valid until the user clicks "log out" or the cookie store is destroyed. Mitigated by 24h idle revocation, the secure-cookie attributes (httpOnly, sameSite=lax, secure when behind HTTPS), and the OAuth provider's own session controls. A hard cap is open follow-up.
- - **localStorage draft is per-origin, unencrypted, and not auto-expired.** A user on a shared machine could leave drafts behind. Acceptable because (a) the cockpit is a personal-use tool, not a shared kiosk, and (b) drafts clear on send success, so abandoned drafts only accumulate from genuine abandon.
- - **`window.opener` postMessage** is the popup → parent channel. We pin `targetOrigin` to `window.location.origin` and check `ev.data.type === 'ac-reauth-ok'` in the parent listener, which is the standard mitigation. A site running in the popup's same-origin (i.e. the cockpit itself) is the only thing that can speak this channel — by design.
- - The draft mechanism stores attachment *references* (paths into `data/chat/artifacts/`) but the actual file lifecycle is server-side. If the server purges an artifact between draft and reload, the reload will show a broken reference. We accept this — artifact lifecycle is independent of draft lifecycle.
- ~ Re-auth re-entrancy is guarded by a single `reAuthInFlightRef`. Multiple concurrent 401s on different requests will queue against the same popup, which is the correct behavior — but the guard is a single in-process flag, so a second tab independently hitting 401 will open its own popup. Multi-tab re-auth coordination is open follow-up.
- ~ The TTL value (24h) was inherited, not freshly chosen. PR #187 added `rolling: true` without changing `maxAge`. Other values (12h, 48h, 7d) weren't debated — 24h was the existing baseline and the rolling change made the absolute value much less load-bearing.

## References

- PR #187 — `feat: rolling sessions, draft restore, popup re-auth` (the implementation)
- `docs/spec-server-security.md` §5.2 — rolling sessions and TTL discussion
- `docs/spec-server-security.md` §5.3 — popup re-auth flow
- ADR-0009 — WS reconnect grace period (the *server*-side persistence of in-flight events; this ADR is the *client*-side persistence of in-progress user input)
- ADR-0006 — atomic writes (the persistence pattern used by `FileStore` for the session backend)
