# Development

Use this path when working on Agent Cockpit itself rather than installing a
production release.

## Setup

```bash
git clone https://github.com/daronyondem/agent-cockpit.git
cd agent-cockpit
npm install
cp .env.example .env
```

Edit `.env` for your local machine. At minimum, set `SESSION_SECRET` or use an
installer-generated environment when testing an installed copy.

## Run

For a foreground development process:

```bash
npm start
```

For persistent local server management, use PM2:

```bash
npx pm2 start ecosystem.config.js
npx pm2 logs agent-cockpit
npx pm2 restart agent-cockpit
npx pm2 stop agent-cockpit
```

Do not use `node server.js` directly.

## Frontend Builds

```bash
npm run web:typecheck
npm run web:build
npm run mobile:typecheck
npm run mobile:build
```

## More Detail

- [AGENTS.md](../../AGENTS.md)
- [Specification](../SPEC.md)
- [Testing](testing.md)
