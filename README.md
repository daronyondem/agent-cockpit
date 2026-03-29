# Agent Cockpit

A web-based chat interface for interacting with Claude Code CLI sessions. Agent Cockpit runs on the same machine as your CLI tools, giving you remote browser-based access to them. Install it on your own machine, expose it through a tunnel like [ngrok](https://ngrok.com/), and you can interact with your local Claude Code CLI from anywhere — your phone, a tablet, or another computer.

## How It Works

Agent Cockpit is a thin web layer that sits in front of the Claude Code CLI installed on your machine. When you send a message through the browser, the server spawns a `claude` CLI process locally, streams the response back over Server-Sent Events, and stores the conversation as a JSON file on disk. The CLI runs with full access to your local filesystem and tools, just as it would in your terminal.

This means:
- **The CLI and the web interface must run on the same machine.** Agent Cockpit does not connect to a remote API — it spawns local processes.
- **Exposing the server (e.g., via ngrok) gives you remote access to your local CLIs.** You can chat with Claude Code from any browser, anywhere, while it operates on your local files and environment.
- **Google OAuth protects access.** Only the email address you configure in `ALLOWED_EMAIL` can log in, so your CLI sessions stay private even when exposed over the internet.

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated on the same machine
- A Google Cloud project with OAuth 2.0 credentials
- (Optional) [ngrok](https://ngrok.com/) or a similar tunnel for remote access

## Quick Start

1. Clone the repository and install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

3. Start the server:

```bash
npm start
```

4. Open `http://localhost:3334` in your browser.

### Remote Access with ngrok

To access Agent Cockpit from outside your local network:

```bash
ngrok http 3334
```

Use the ngrok-provided URL to reach your local Agent Cockpit from any device. Make sure to update your Google OAuth **Authorized JavaScript origins** and **Authorized redirect URIs** to include the ngrok URL.

## Google OAuth Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Navigate to **APIs & Services > Credentials**.
4. Click **Create Credentials > OAuth client ID**.
5. Select **Web application** as the application type.
6. Add `http://localhost:3334` to **Authorized JavaScript origins**.
7. Add `http://localhost:3334/auth/google/callback` to **Authorized redirect URIs**.
8. Copy the Client ID and Client Secret into your `.env` file.
9. Set `ALLOWED_EMAIL` to the Google account email you want to grant access.

## Recommended Claude Code CLI Settings

Agent Cockpit spawns Claude Code CLI processes on your behalf. To get the best experience, consider adding these settings to your `~/.claude/settings.json`:

```json
{
  "attribution": {
    "gitCommit": "",
    "pullRequest": ""
  },
  "permissions": {
    "allow": [
      "Edit(**)"
    ]
  }
}
```

**What these do:**

- **`attribution.gitCommit: ""`** removes the `Co-Authored-By: Claude` trailer from git commits, so commits show only your name as author.
- **`attribution.pullRequest: ""`** removes the Claude attribution from pull request descriptions.
- **`permissions.allow: ["Edit(**)"]`** gives Claude Code permission to edit any file without prompting for confirmation. This is useful when running through Agent Cockpit since there is no interactive terminal to approve file edits. Without this, Claude Code may silently skip edits it considers outside its default allowed paths.

These settings are optional but recommended for a smoother experience when using Agent Cockpit as your primary interface to Claude Code.
