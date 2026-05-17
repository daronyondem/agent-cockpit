# Mobile PWA

Agent Cockpit's supported mobile client is a Progressive Web App served by the
same backend as the desktop UI.

## Install

1. Open `https://<your-host>/mobile/` on your phone.
2. Sign in with the same owner account.
3. Use the browser's Add to Home Screen flow.

The PWA uses the same authenticated web session as the desktop UI.

## What It Is For

Use the mobile PWA to:

- monitor active conversations;
- answer interactive questions;
- review running-state badges;
- steer work while away from the desktop browser.

## What It Is Not

There is no native iOS, Android, Expo, TestFlight, or App Store distribution
path. The supported mobile path is `/mobile/` plus Add to Home Screen.

For implementation details, see [spec-mobile-pwa.md](../spec-mobile-pwa.md).
