# Agent Cockpit iOS App

The native iOS app is a companion client for a self-hosted Agent Cockpit backend. The app does not require GitHub, Google, Apple ID, or Cloudflare Access login. It connects to the backend URL you enter on the connection screen and uses the backend's first-party auth.

## Requirements

- macOS with Xcode installed.
- An iPhone running iOS 18 or newer.
- A reachable Agent Cockpit backend, for example `https://chat.yourdomain.com` or `https://chat-dev.yourdomain.com`.
- The backend must already have its first local owner account created.

The Xcode project is:

```bash
ios/AgentCockpit/AgentCockpit.xcodeproj
```

The default app bundle id is:

```text
com.daronyondem.agentcockpit
```

If that bundle id is already taken for your Apple Developer team, change it in Xcode to a unique value such as `com.yourname.agentcockpit`.

## Install on a Real iPhone

1. Connect the iPhone to the Mac with USB.
2. Unlock the iPhone and tap **Trust This Computer** if prompted.
3. Open the project:

```bash
open ios/AgentCockpit/AgentCockpit.xcodeproj
```

4. In Xcode, select the **AgentCockpit** scheme.
5. Select your physical iPhone in the device picker.
6. Open **AgentCockpit project > AgentCockpit target > Signing & Capabilities**.
7. Enable **Automatically manage signing**.
8. Select your Apple Developer team or Personal Team.
9. Press **Run**.

If iOS asks for Developer Mode, enable it on the phone and restart when prompted. If you do not see Developer Mode, leave the phone connected, open **Xcode > Window > Devices and Simulators**, select the phone, and let Xcode finish preparing the device. Then press **Run** again.

If iOS says the developer is not trusted, open **Settings > General > VPN & Device Management** on the phone and trust your developer profile.

## Connect to a Backend

On the app's connection screen, enter the full backend URL including the scheme:

```text
https://chat.yourdomain.com
```

Use your dev or prod tunnel URL as needed. The app stores the selected backend with its session, so each self-hosted backend remains independent.

## Login Options

### Sign in with Passkey or Password

Tap **Sign in with Passkey or Password**. The app opens the backend-owned login page in the system authentication session. Complete password or passkey login there. The backend redirects back to the app with a one-time code, and the app exchanges that code for the normal backend session cookie and CSRF token.

This flow lets passkeys work for arbitrary self-hosted backend domains because the passkey ceremony happens on the backend's own web origin.

### QR Pairing

1. Sign in to the backend web UI.
2. Open **Settings > Security**.
3. In **Mobile pairing**, click **Create pairing code**.
4. In the iOS app, tap **Scan QR Code**.
5. Scan the QR code shown in the web UI.

The pairing challenge is short-lived and single-use.

### Manual Pairing

If QR scanning is unavailable:

1. Sign in to the backend web UI.
2. Open **Settings > Security**.
3. Click **Create pairing code**.
4. Copy the displayed `challengeId` and pairing code.
5. Enter both values in the iOS app.
6. Tap **Pair Device**.

## Manage Paired Devices

Open **Settings > Security > Paired devices** in the web UI to review paired mobile devices. Each record shows the device name, platform, created time, last seen time, and status.

Click **Revoke** to unpair a device. A revoked iOS session is rejected by the backend and the app must sign in or pair again.

## Troubleshooting

**The app cannot reach the backend**

Verify the backend URL includes `https://` for tunnel/public hosts. From the phone's network, open:

```text
https://chat.yourdomain.com/api/auth/status
```

An unauthenticated backend should still return a JSON auth response or an HTTP auth status, not a browser/network error.

**QR scanning asks for camera access**

Allow camera access. The app only uses the camera to scan mobile pairing QR codes. If camera access is denied, use manual pairing.

**Passkey login fails after changing domains**

Passkeys are tied to the backend domain. Sign in using password or a recovery path on the new domain, then register a new passkey from **Settings > Security**.

**The app installed but will not open because the developer is untrusted**

Open **Settings > General > VPN & Device Management** on the iPhone and trust the developer profile used by Xcode.

**Xcode cannot sign the app**

Select a signing team under **Signing & Capabilities** and make the bundle id unique for that team.
