# Security And Owner Auth

Agent Cockpit uses first-party local owner authentication by default. The normal
self-hosted flow does not require GitHub, Google, Apple ID, or Cloudflare Access.

## First Owner Setup

On first run, open `/auth/setup` and create the owner account with an email,
display name, and password.

Localhost setup does not require `AUTH_SETUP_TOKEN`. Remote setup does. If the
server is exposed before the owner account exists, set `AUTH_SETUP_TOKEN` and
enter it on the setup page.

## Passkeys And Recovery Codes

After setup, open **Settings > Security** to:

- register one or more passkeys;
- generate recovery codes;
- enable passkey-required login after at least one passkey and one unused
  recovery code exist.

Passkeys are tied to the backend domain. If you move from one host to another,
register a passkey while signed in on the new domain.

## Local Lockout Recovery

Run this on the backend machine:

```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```

The reset command requires local filesystem access. It can reset the owner
password, disable passkey-required mode, revoke sessions, and print replacement
recovery codes.

## Legacy OAuth

Google/GitHub OAuth is legacy-only and disabled by default. Set
`AUTH_ENABLE_LEGACY_OAUTH=true` only if you need the old provider routes
temporarily, then configure the provider client id, client secret, callback URL,
and allowed-email settings.
