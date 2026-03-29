# Agent Cockpit

A web-based chat interface for interacting with Claude Code CLI sessions. Provides Google OAuth authentication, conversation management, file uploads, and real-time streaming responses.

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Google Cloud project with OAuth 2.0 credentials

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
