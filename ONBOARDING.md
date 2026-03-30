# Agent Cockpit — Self-Hosting Guide

This guide walks you through setting up Agent Cockpit on your own machine, exposed to the internet via a Cloudflare Tunnel, and kept running with PM2.

By the end you will have:

- Agent Cockpit running as a persistent background service
- A Cloudflare Tunnel giving it a stable public URL (e.g. `chat.yourdomain.com`)
- OAuth protecting access so only you can log in
- Automatic restarts on crash or reboot

---

## Prerequisites

Install the following before you begin:

| Dependency | Install | Verify |
|---|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org/) or `brew install node` | `node -v` |
| **Claude Code CLI** | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| **cloudflared** | `brew install cloudflared` | `cloudflared --version` |
| **PM2** | `npm install -g pm2` | `pm2 --version` |

You will also need:

- A **Cloudflare account** with a domain managed by Cloudflare DNS
- A **Google Cloud project** for OAuth credentials (required)
- A **GitHub OAuth App** (optional — enables GitHub login)

Make sure the Claude Code CLI is authenticated before proceeding:

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

## 2. Set Up the Cloudflare Tunnel

### 2.1 Log in to Cloudflare

```bash
cloudflared login
```

This opens a browser window. Select the domain you want to use and authorize `cloudflared`.

### 2.2 Create a tunnel

```bash
cloudflared tunnel create my-tunnel
```

Note the **Tunnel ID** (a UUID like `8307e28b-b493-4646-931e-42e9ba37f2d7`) — you will need it next.

### 2.3 Route DNS

Create a DNS record pointing your chosen subdomain to the tunnel:

```bash
cloudflared tunnel route dns my-tunnel chat.yourdomain.com
```

This creates a CNAME record in Cloudflare DNS automatically.

### 2.4 Configure the tunnel

Create (or edit) `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: chat.yourdomain.com
    service: http://localhost:3334
  - service: http_status:404
```

Replace `<YOUR_TUNNEL_ID>` and `<you>` with your actual values.

### 2.5 Test the tunnel

```bash
cloudflared tunnel run my-tunnel
```

You should see connection logs showing it connected to Cloudflare edge servers. Press `Ctrl+C` to stop for now — we will run it under PM2 later.

---

## 3. Set Up OAuth

You need at least Google OAuth. GitHub OAuth is optional but recommended.

### 3.1 Google OAuth

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Navigate to **APIs & Services > Credentials**.
4. Click **Create Credentials > OAuth client ID**.
5. Select **Web application** as the application type.
6. Add your tunnel URL to **Authorized JavaScript origins**:
   - `https://chat.yourdomain.com`
7. Add the callback URL to **Authorized redirect URIs**:
   - `https://chat.yourdomain.com/auth/google/callback`
8. Copy the **Client ID** and **Client Secret** — you will need them in the next step.

### 3.2 GitHub OAuth (optional)

1. Go to **GitHub > Settings > Developer settings > OAuth Apps > New OAuth App**.
2. Set the fields:
   - **Homepage URL**: `https://chat.yourdomain.com`
   - **Authorization callback URL**: `https://chat.yourdomain.com/auth/github/callback`
3. After creating the app, copy the **Client ID** and generate a **Client Secret**.

---

## 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
PORT=3334
SESSION_SECRET=<generate-a-long-random-string>
GOOGLE_CLIENT_ID=<from-step-3.1>
GOOGLE_CLIENT_SECRET=<from-step-3.1>
GOOGLE_CALLBACK_URL=https://chat.yourdomain.com/auth/google/callback
ALLOWED_EMAIL=you@example.com
DEFAULT_WORKSPACE=~/projects
BASE_PATH=
```

If you set up GitHub OAuth, also add:

```env
GITHUB_CLIENT_ID=<from-step-3.2>
GITHUB_CLIENT_SECRET=<from-step-3.2>
GITHUB_CALLBACK_URL=https://chat.yourdomain.com/auth/github/callback
```

**Notes:**
- `SESSION_SECRET` should be a long random string. Generate one with: `openssl rand -base64 32`
- `ALLOWED_EMAIL` is a comma-separated list of email addresses allowed to log in.
- `DEFAULT_WORKSPACE` is the default working directory Claude Code will operate in.
- `BASE_PATH` can be left empty unless you are running behind a reverse proxy at a subpath.

---

## 5. Start Everything with PM2

### 5.1 Start the Cloudflare tunnel

```bash
pm2 start cloudflared --name cf-tunnel -- tunnel run my-tunnel
```

### 5.2 Start Agent Cockpit

```bash
cd /path/to/agent-cockpit
pm2 start server.js --name agent-cockpit
```

Since the `.env` file is in the project directory and the app uses `dotenv`, it will pick up the environment variables automatically.

### 5.3 Verify both are running

```bash
pm2 list
```

You should see both `cf-tunnel` and `agent-cockpit` with status `online`.

### 5.4 Save the process list

```bash
pm2 save
```

This saves the current process list so PM2 can restore it after a restart.

### 5.5 Enable startup on boot

```bash
pm2 startup
```

PM2 will print a `sudo` command. Copy and run it. This creates a system service that starts PM2 (and your saved processes) automatically when your machine boots.

---

## 6. Recommended Claude Code CLI Settings

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

This gives Claude Code permission to edit files without prompting for confirmation. Without this, file edit requests will hang waiting for terminal input that never comes.

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

## 7. Verify Everything

Open `https://chat.yourdomain.com` in your browser and confirm:

- [ ] The login page loads with Google (and GitHub, if configured) sign-in buttons
- [ ] OAuth login succeeds and redirects back to `chat.yourdomain.com` (not somewhere else)
- [ ] You can create a new conversation and send a message
- [ ] Claude Code responds with streamed output
- [ ] Run `pm2 list` and confirm both `agent-cockpit` and `cf-tunnel` show `online`
- [ ] Reboot your machine and verify both services come back up automatically

---

## Troubleshooting

**Server starts on the wrong port**
If `PORT` is set in your shell profile (e.g. `.zshrc`), it will override the `.env` file. Either unset it (`unset PORT`) or pass it explicitly when starting: `PORT=3334 pm2 start server.js --name agent-cockpit`.

**OAuth redirects to the wrong domain**
Double-check that `GOOGLE_CALLBACK_URL` and `GITHUB_CALLBACK_URL` in your `.env` match the URLs registered in the Google Cloud Console and GitHub OAuth App settings. All three must agree: the `.env` value, the OAuth provider's registered redirect URI, and the actual domain your tunnel is serving.

**PM2 process keeps erroring**
Check the logs: `pm2 logs agent-cockpit --lines 50`. Common causes are missing environment variables, port conflicts (`EADDRINUSE`), or missing `node_modules` (run `npm install`).

**Tunnel not connecting**
Run `cloudflared tunnel info my-tunnel` to check the tunnel status. Verify that `~/.cloudflared/config.yml` has the correct tunnel ID and credentials file path.

**Claude Code CLI not responding**
Make sure the CLI is authenticated: run `claude` in a terminal and confirm it works. Also check that `DEFAULT_WORKSPACE` points to a valid directory.
