# ChatApp

A WhatsApp-style real-time web chat that works on phones and desktops, with SSO (OpenID Connect) login.
**Zero dependencies**: just Node.js 18.3+ (no `npm install`).

## Features

- 1:1 chats and group chats, live over WebSocket
- Upload JPEG, PNG, GIF, WebP, or BMP images in chat (10 MB per image), with blurred previews and downloads
- Emoji picker for inserting emojis into messages
- Message options: reply, forward, copy, edit, reactions, and delete for you or (for your own messages) everyone
- Signed-in user profiles are stored in `data/db.json`; online status updates live in chat and user search
- Delivery/read receipts (✓ sent, ✓✓ delivered, animated eye when read), typing indicator, online / last seen, unread badges
- Mobile-first UI: list ↔ conversation slide navigation with the back button, safe-area insets, on-screen-keyboard aware, dark mode
- Installable PWA (Add to Home Screen), offline app shell, browser notifications
- Auto-reconnect with resend of unsent messages (idempotent, no duplicates)
- SSO via any OIDC provider (Google, Microsoft Entra ID, Okta, Auth0, Keycloak, …): authorization-code flow + PKCE, `state`/`nonce`, ID-token signature verification (RS/PS/ES), optional email-domain allow-list

## Run it

```bash
node server.js            # http://localhost:3000
```

With no SSO configured, a **demo login** (name only) appears so you can try the app locally. Demo names identify accounts, so use a distinct name per person. It is disabled automatically as soon as `OIDC_CLIENT_ID` is set.

Try it with two browsers (or one normal + one private window) signed in with different names.

## Configure SSO

1. In your identity provider, create an OIDC **web application** and register this redirect URI:
   `https://YOUR-DOMAIN/auth/callback` (Google also allows `http://localhost:3000/auth/callback`).
2. Set environment variables (see `.env.example`):

| Variable | Example |
|---|---|
| `BASE_URL` | `https://chat.example.com` (exactly what users type; must match the redirect URI) |
| `OIDC_ISSUER` | Google: `https://accounts.google.com` · Entra: `https://login.microsoftonline.com/<tenant-id>/v2.0` · Okta: `https://<org>.okta.com` · Keycloak: `https://host/realms/<realm>` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | from your provider |
| `OIDC_NAME` | label on the login button, e.g. `Google` |
| `ALLOWED_EMAIL_DOMAINS` | optional, e.g. `example.com` |

```bash
BASE_URL=https://chat.example.com OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... node server.js
```

## Using it on your phone

Browsers only allow installing the app, notifications and most SSO providers on **HTTPS** (except `localhost`). Easiest options:

- Put it behind a reverse proxy with TLS (Caddy / nginx / Cloudflare Tunnel / ngrok) and set `BASE_URL` to the public URL.
- The proxy must forward WebSocket upgrades on `/ws` (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host;`).

Then open the URL on the phone and use *Share → Add to Home Screen* (iOS) or *Install app* (Android).

## Layout

```
server.js            HTTP API, OIDC, WebSocket, storage
public/              index.html, app.js, style.css, login.*, sw.js, manifest, icons
data/db.json         users, chats, messages (created on first run)
data/uploads/        uploaded chat attachments (created on startup)
data/secret.key      cookie-signing secret (or set SESSION_SECRET)
```

## Security notes

- Session cookie is signed, `HttpOnly`, `SameSite=Lax` (`Secure` + `__Host-` prefix on HTTPS). WebSocket upgrades and state-changing requests check the `Origin` header. Strict CSP, all user text is rendered with `textContent` (no HTML injection). Message size and per-connection rate are limited.
- Every signed-in user can search the directory of other signed-in users by name to start chats. Restrict who can sign in with `ALLOWED_EMAIL_DOMAINS`.
- Image uploads are limited to 10 MB each, validated by file signature, stored under `data/uploads/`, and available only to members of their chat.
- Messages are stored unencrypted on the server (no end-to-end encryption).
- **Never run with `DEV_LOGIN=1` on a public server.**

## Known limits / next steps

- Storage is a single JSON file in memory: fine for a team or demo, not for many thousands of users or multiple server instances. Swap `db` for SQLite/Postgres and add Redis pub/sub to scale out.
- Not included yet: inline image previews, voice notes, group admin (rename/add/remove members), push notifications while the app is closed (needs Web Push + VAPID keys), session revocation list.
