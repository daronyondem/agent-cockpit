# Remote Access

Agent Cockpit is local-first, but you can access it from other devices through a
private network, tunnel, or reverse proxy you control.

## Recommended Pattern

1. Install and start Agent Cockpit locally.
2. Create the first owner account from localhost when possible.
3. Configure passkeys and recovery codes.
4. Expose the server through a private access path.
5. Open the desktop UI or mobile PWA from the remote device.

## Cloudflare Tunnel

For a simple tunnel during setup:

```bash
cloudflared tunnel --url http://localhost:3334
```

Use the tunnel-provided URL to reach your local Agent Cockpit from another
browser. For persistent Cloudflare Tunnel setup with PM2, see
[ONBOARDING.md](../../ONBOARDING.md).

## Tailscale Or LAN

Agent Cockpit can also be reached over a private network when the host and
client device can route to the server. Use your own firewall, DNS, and TLS
configuration appropriate to that network.

## First-Run Exposure Warning

If the backend is reachable from a non-localhost address before the owner
account exists, set `AUTH_SETUP_TOKEN`. The setup page requires that token for
remote first-owner creation.

## Mobile

After remote access works, open:

```text
https://<your-host>/mobile/
```

Then use the browser's Add to Home Screen flow. See [Mobile PWA](../user/mobile-pwa.md).
