# Agent Cockpit — Self-Hosting Guide

This guide walks you through setting up Agent Cockpit on your own machine, exposing it through Cloudflare Tunnel, and keeping it running with PM2.

By the end you will have:

- Agent Cockpit running as a persistent background service
- A Cloudflare Tunnel with a stable public URL, for example `chat.yourdomain.com`
- One first-party local owner account for the backend
- Recovery codes and a local reset command for lockout recovery
- Optional passkeys and iOS mobile pairing for the owner account
- Automatic restarts on crash or reboot

---

## Prerequisites

Install the following before you begin:

| Dependency | Install | Verify |
|---|---|---|
| **Node.js 22+** | [nodejs.org](https://nodejs.org/) or `brew install node` | `node -v` |
| **Claude Code CLI** | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| **cloudflared** | `brew install cloudflared` | `cloudflared --version` |
| **PM2** | `npm install -g pm2` | `pm2 --version` |
| **Xcode** | App Store | Required only for installing the iOS app on your own device |

You will also need a Cloudflare account with a domain managed by Cloudflare DNS.

Make sure the CLI backends you plan to use are authenticated on the same machine that runs Agent Cockpit. For Claude Code:

```bash
claude
# Follow the prompts to log in with your Anthropic account
```

---

## 1. Clone and Install

```bash
git clone https://github.com/daronyondem/agent-cockpit.git
cd agent-cockpit
npm install
```

---

## 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3334
SESSION_SECRET=<generate-a-long-random-string>
AUTH_SETUP_TOKEN=<generate-a-long-random-string>
DEFAULT_WORKSPACE=~/projects
BASE_PATH=
```

Notes:

- `SESSION_SECRET` should be a long random string. Generate one with `openssl rand -base64 32`.
- `AUTH_SETUP_TOKEN` is required only for first-run setup from a non-localhost URL, such as your Cloudflare Tunnel domain. It prevents someone else from claiming an exposed empty backend.
- Localhost setup, for example `http://localhost:3334/auth/setup`, does not require `AUTH_SETUP_TOKEN`.
- `DEFAULT_WORKSPACE` is the default directory the CLI backend will operate in.
- `BASE_PATH` can be left empty unless you are running behind a reverse proxy at a subpath.
- Google/GitHub OAuth is not required. It is legacy-only and disabled unless `AUTH_ENABLE_LEGACY_OAUTH=true`.

---

## 3. Create a PM2 App Definition

Create `ecosystem.config.js` in the repo root. This file is gitignored because it can contain local paths and secrets.

```js
module.exports = {
  apps: [{
    name: 'agent-cockpit',
    script: 'server.ts',
    interpreter: './node_modules/.bin/tsx',
    cwd: __dirname,
    env: {
      PORT: 3334,
      SESSION_SECRET: '<same value as .env>',
      AUTH_SETUP_TOKEN: '<same value as .env>',
      DEFAULT_WORKSPACE: '/Users/you/projects',
      BASE_PATH: '',
    },
  }],
};
```

---

## 4. Set Up the Cloudflare Tunnel

### 4.1 Log in to Cloudflare

```bash
cloudflared login
```

This opens a browser window. Select the domain you want to use and authorize `cloudflared`.

### 4.2 Create a tunnel

```bash
cloudflared tunnel create my-tunnel
```

Note the Tunnel ID. It is a UUID like `8307e28b-b493-4646-931e-42e9ba37f2d7`.

### 4.3 Route DNS

```bash
cloudflared tunnel route dns my-tunnel chat.yourdomain.com
```

This creates a CNAME record in Cloudflare DNS.

### 4.4 Configure the tunnel

Create or edit `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: chat.yourdomain.com
    service: http://localhost:3334
  - service: http_status:404
```

Replace `<YOUR_TUNNEL_ID>` and `<you>` with your actual values.

### 4.5 Test the tunnel

```bash
cloudflared tunnel run my-tunnel
```

Open `https://chat.yourdomain.com`. You should see Agent Cockpit. Press `Ctrl+C` to stop the tunnel for now; PM2 will run it later.

---

## 5. Start Everything with PM2

### 5.1 Start Agent Cockpit

```bash
npx pm2 start ecosystem.config.js
```

### 5.2 Start the Cloudflare tunnel

```bash
npx pm2 start "$(command -v cloudflared)" --name cf-tunnel --interpreter none -- tunnel run my-tunnel
```

If `command -v cloudflared` prints nothing, use the absolute path from your install, commonly `/opt/homebrew/bin/cloudflared` on Apple Silicon Macs.

### 5.3 Verify both are running

```bash
npx pm2 list
```

You should see both `agent-cockpit` and `cf-tunnel` with status `online`.

### 5.4 Save the process list

```bash
npx pm2 save
```

### 5.5 Enable startup on boot

```bash
npx pm2 startup
```

PM2 will print a `sudo` command. Copy and run it. This creates a system service that restores your saved PM2 processes when the machine boots.

---

## 6. Create the Owner Account

Open either URL:

- Local setup from the server machine: `http://localhost:3334/auth/setup`
- Remote setup through the tunnel: `https://chat.yourdomain.com/auth/setup`

If you use the tunnel URL, enter the `AUTH_SETUP_TOKEN` from your environment when the setup page asks for it.

Create the owner account with:

- Email
- Display name
- Password with at least 12 characters

After setup, Agent Cockpit signs you in and creates `data/auth/owner.json`. Passwords are stored as scrypt hashes; plaintext passwords are not stored.

---

## 7. Secure the Owner Account

Generate recovery codes immediately after first setup:

```bash
npm run auth:reset -- --regenerate-recovery-codes
```

Store the printed codes somewhere safe. Each code is single-use. They are the recovery path if passkey-required mode is enabled later or if the normal password flow breaks.

You can also manage these from the web UI:

1. Open **Settings > Security**.
2. Register one or more passkeys.
3. Regenerate/store recovery codes if needed.
4. Enable **Require passkey for login** only after at least one passkey and one unused recovery code exist.
5. Create mobile pairing codes and revoke paired devices when needed.

Passkeys are bound to the backend domain. If you use both a dev and prod hostname, register passkeys separately on each hostname you plan to use.

Local lockout recovery command:

```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```

This requires local filesystem/server access. It is intentionally not exposed over HTTP.

---

## 8. Recommended Claude Code CLI Settings

Agent Cockpit spawns Claude Code CLI processes on your behalf. Since there is no interactive terminal to approve actions, add these settings to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Edit(**)"
    ]
  }
}
```

Without this, file edit requests can hang waiting for terminal input.

Optionally, to remove Claude attribution from git commits and pull requests:

```json
{
  "attribution": {
    "gitCommit": "",
    "pullRequest": ""
  }
}
```

---

## 9. Verify Everything

Open `https://chat.yourdomain.com` in your browser and confirm:

- [ ] First-run setup creates the owner account
- [ ] Login works with the owner email/password
- [ ] A passkey can be registered from **Settings > Security**
- [ ] Recovery codes have been generated and stored
- [ ] **Require passkey for login** can be enabled only after passkey and recovery-code setup
- [ ] You can create a new conversation and send a message
- [ ] Claude Code responds with streamed output
- [ ] `npx pm2 list` shows both `agent-cockpit` and `cf-tunnel` as `online`
- [ ] Reboot your machine and verify both services come back up automatically

---

## 10. iOS App Login

The iOS app is a native companion client for a backend URL that you enter on the connection screen. To install it on your own iPhone from Xcode, follow [docs/ios-app.md](docs/ios-app.md).

In the iOS app connection screen:

1. Enter your backend URL, for example `https://chat.yourdomain.com`.
2. Tap **Sign in with Passkey or Password**.
3. Complete the backend-owned login page.
4. The app receives a one-time callback code and exchanges it for the normal backend session cookie and CSRF token.

Mobile pairing is also supported:

1. Open **Settings > Security** in the web UI.
2. Click **Create pairing code**.
3. In the iOS connection screen, tap **Scan QR Code** and scan the displayed QR code.

Manual fallback: enter the displayed `challengeId` and `pairingCode` in the iOS connection screen.

After pairing, **Settings > Security > Paired devices** shows the iPhone's device record. Revoking that device invalidates the mobile session.

---

## Legacy OAuth

Google/GitHub OAuth is optional legacy compatibility. New self-hosted installs should use first-party owner auth.

If you need legacy OAuth temporarily:

1. Set `AUTH_ENABLE_LEGACY_OAUTH=true`.
2. Configure provider credentials and callback URLs.
3. Set `ALLOWED_EMAIL` to the allowed email list.

Legacy callback examples:

```env
GOOGLE_CALLBACK_URL=https://chat.yourdomain.com/auth/google/callback
GITHUB_CALLBACK_URL=https://chat.yourdomain.com/auth/github/callback
```

---

## Troubleshooting

**Setup asks for a token**

You are accessing setup through a non-localhost URL. Enter `AUTH_SETUP_TOKEN`, or open `http://localhost:3334/auth/setup` directly on the server machine.

**Server starts on the wrong port**

Check `PORT` in `.env`, `ecosystem.config.js`, and your shell profile. Restart PM2 with:

```bash
npx pm2 restart agent-cockpit --update-env
```

**PM2 process keeps erroring**

Check logs:

```bash
npx pm2 logs agent-cockpit --lines 50
```

Common causes are missing environment variables, port conflicts, missing `node_modules`, or an invalid `DEFAULT_WORKSPACE`.

**PM2 warns that the daemon is out of date**

`pm2 update` restarts the PM2 daemon and briefly interrupts all PM2-managed apps, including Agent Cockpit and the tunnel. Run it only from a normal terminal or SSH session when brief downtime is acceptable, then verify with `npx pm2 list`.

**Tunnel is not reachable**

Run `cloudflared tunnel info my-tunnel` and verify `~/.cloudflared/config.yml` has the correct tunnel ID, credentials file path, hostname, and local service port.

**CLI backend does not respond**

Make sure the CLI is authenticated on the server machine. For Claude Code, run `claude` in a terminal and confirm it works. Also check that `DEFAULT_WORKSPACE` points to a valid directory.

**iOS app cannot connect**

Confirm the backend URL includes the scheme, for example `https://chat.yourdomain.com`, and check that `https://chat.yourdomain.com/api/auth/status` is reachable from the phone's network. If QR scan fails, use the manual `challengeId` and pairing code from **Settings > Security**.
