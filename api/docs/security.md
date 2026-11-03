# Security: accounts, 2FA and step-up

This page covers the **dashboard account** (what a human logs into). Integrations use API
keys ([authentication.md](authentication.md)) and are unaffected by 2FA, except that
*managing* keys requires it.

## Account model

* Sign-up is email + password. No identity or business verification.
* Passwords: minimum 12 characters, checked against known-breached lists, stored with
  Argon2id.
* Sessions: `cv_session` cookie (HttpOnly, Secure, SameSite=Lax), 12 hours idle / 7 days
  absolute for merchants, 12 hours absolute for staff. `GET /auth/sessions` lists them,
  `DELETE /auth/sessions` revokes all others. `GET /account` returns the account behind the
  session (email, business name, status; no identity data) and `PATCH /account` updates the
  business name shown on hosted checkout pages.
* Lockout: 5 failed password attempts or 5 failed 2FA codes lock the account for 15 minutes
  (`423 account_locked`); the owner is emailed.

## Password reset

A forgotten password is replaced through an emailed, single-use link. It never weakens 2FA.

```
POST /auth/password/forgot {email}            (operators: POST /admin/auth/password/forgot)
  -> 200 { object: "password_reset_request", expires_in: 1800 }   same answer for unknown emails
     email: https://coinvello.com/app/reset-password.php?token=pwr_...
POST /auth/password/reset {token, new_password}
  -> 200 { object: "password_reset", account_type: "merchant", sessions_revoked: 2, mfa_enabled: true }
```

* **No account enumeration.** The forgot endpoint answers identically whether or not the email
  has an account, and sends mail only when it does. Its rate limits are counted before the
  lookup, so a `429` reveals nothing either.
* **Token.** `pwr_` + 32 random bytes, valid **30 minutes**, single-use. Only its SHA-256 is
  stored; it is never logged (with `MAIL_DRIVER=log` in development it appears only inside the
  logged mail). Requesting a new link invalidates older unused ones. Unknown, used and expired
  tokens all fail with `400 reset_token_invalid`. A too-short password is refused *before* the
  token is burned, so a typo does not cost the link.
* **What a reset does.** Replaces the password, clears any lockout, revokes **every** session and
  trusted device, cancels pending sign-in challenges and other reset links, and emails the
  owner. No session is created: the user signs in again.
* **2FA stays on.** A reset does not touch TOTP, email codes or recovery codes. If 2FA
  is enabled the next sign-in still asks for the second factor (trusted devices were revoked, so
  none can skip it). Losing both the password and every second factor is a support case.
* **Rate limits.** Forgot: 20 per IP and 3 per email address per hour. Reset: 30 attempts per IP
  per hour. The dashboard calls the API from its own server, so it adds a per-visitor limit
  (5 forgot / 10 reset attempts per 15 minutes per IP) in front.
* **Dashboard pages.** `/app/forgot-password.php` and `/app/reset-password.php` (operators:
  `/admin/...`). The reset page moves the token into the server-side session and redirects to a
  URL without it, and is served with `Referrer-Policy: no-referrer`, so the token does not linger in
  history or leak to other sites. The link base is the backend's `SITE_URL`.

## Two-factor authentication

| Method | Standard | Assurance | Notes |
|--------|----------|-----------|-------|
| `totp` | RFC 6238, SHA-1, 6 digits, 30-second step, +/-1 step tolerance | Strong | Works with Google Authenticator, Authy, 1Password, etc. Enrol via `POST /auth/mfa/totp/enroll` (secret, `otpauth://` URI, SVG QR) and confirm with a code. Each code is accepted once (replay-protected). |
| `webauthn` | WebAuthn Level 2 / passkeys | Strongest, phishing-resistant | **Planned, not available yet.** The `/auth/mfa/webauthn/*` routes are reserved and currently answer `501`. Use TOTP. |
| `email` | 6-digit code, 10-minute expiry, single-use | **Weaker** | Fallback for accounts without an authenticator. An attacker who controls the mailbox controls both password reset and this factor, so email OTP is really "1.5-factor". Rate limited: 1 send / 60 s, 5 / hour. We recommend it only as a backup to TOTP. |
| `recovery_code` | 10 single-use codes, format `xxxx-xxxx-xxxx` | Backup | Shown once at first enrolment or on regeneration. Stored **hashed** (Argon2id); the API only reports how many remain. Using one emails the owner. |

### Enabling

```
POST /auth/mfa/totp/enroll      -> { secret, otpauth_uri, qr_svg }
POST /auth/mfa/totp/confirm {code}  -> { status, recovery_codes: [10 codes] }   # first time only
```

### Logging in with 2FA

```
POST /auth/login {email, password}
  -> { mfa_required: true, mfa_token, methods: ["totp","email"], preferred_method: "totp" }
POST /auth/mfa/verify {mfa_token, method: "totp", code: "123456", remember_device: true}
  -> { object: "session", ... }   + Set-Cookie: cv_session, cv_trusted_device
```

`mfa_token` is single-use and expires in 5 minutes.

### Trusted devices

With `remember_device: true` the browser receives a `cv_trusted_device` cookie: a signed
(HMAC-SHA256, server key) token bound to the account and a device id, valid **30 days**.
Logins from a trusted device skip the 2FA prompt. Trusted devices never skip **step-up**.
They are listed in `GET /auth/sessions` (`trusted_device: true`) and cleared by
`DELETE /auth/sessions`, by disabling 2FA, or by a password reset.

### Disabling

`DELETE /auth/mfa/{method}` requires a **fresh code** in the request body - a valid step-up
window is not enough. This stops a hijacked session from quietly removing the second factor.
Removing the last method disables 2FA, wipes recovery codes and trusted devices, and emails
the owner. Staff accounts cannot remove their last method.

## Policy: optional for account owners, required for team members and sensitive actions

2FA is **optional** for the account owner, and **required** for team members (`admin`, `developer`,
`viewer`; see `GET /team`): an invited member enrols 2FA on first sign-in. Either way, the
following actions always require a recent second-factor verification ("step-up"), regardless
of whether 2FA is enabled for login:

| Action | Why |
|--------|-----|
| Adding, changing or archiving **payout wallets / xpubs** (and the optional signed-message verification) | Controls where customer money goes; with signatures optional, this step-up plus strict address validation is the control |
| Creating, editing or deleting **webhook endpoints**; rotating secrets | Controls who learns about payments and could spoof fulfilment |
| Creating, revoking or viewing **API keys** | Full account control |
| Disabling or changing **2FA** itself, regenerating recovery codes | Self-evident |
| Connecting or disconnecting **off-ramp partner accounts** | Moves value to fiat |

A merchant with no second factor enrolled is prompted to enrol TOTP (or, at minimum,
confirm an email code) the first time they attempt one of these in the dashboard.

Staff accounts (admin panel) must **always** have 2FA (TOTP; email alone is not accepted for
staff) and every admin session starts with a 2FA challenge. Staff manage their own
second factor, recovery codes and sessions through the same `/auth/mfa/*` and `/auth/sessions`
routes as merchants, using their `cv_admin_session` cookie; `DELETE /auth/mfa/{method}` on a
staff account's last method returns `409` so a staff user can never end up without 2FA.

### Step-up flow

1. Dashboard calls a protected action -> `403 authentication_error / step_up_required`
   with `details.methods`.
2. `POST /auth/mfa/verify { method, code }` (no `mfa_token`, existing session).
3. The session gains `step_up_valid_until = now + 5 minutes`; retry the action.
4. The window is per-session, not extended by use, and never satisfied by a trusted-device
   cookie.

### API keys and step-up

API-key requests (`cv_live_`/`cv_test_`) are never asked for 2FA - a server cannot type a
code. Instead, the dangerous operations are simply **not available** to ordinary API keys from
untrusted contexts:

* `POST /wallets`, `PATCH /wallets/{id}`, `DELETE /wallets/{id}`, `/verification`, `/verify`
  and all `/webhooks` writes **are** available to API keys, because plugins need them during
  setup. They are gated by scope (`wallets:write`, `webhooks:write`). Full-access live keys
  leave out `wallets:write`: wallet changes with a live key need a restricted key that lists it.
  Every live wallet or webhook change not made by the owner's own dashboard session (an API
  key, a team member) emails the owner at once: what changed, the key prefix or member, the IP
  and client. If it was not you, delete the key (Settings > API keys) or remove the member, then
  check Wallets, Webhooks and Activity. Keep `wallets:write` off keys that live on shared hosting.
* API key management itself is dashboard-only: `GET|POST /api-keys` and `DELETE /api-keys/{id}` accept
  the session cookie only (never an API key) and require a step-up.

## Transport and storage

* TLS 1.2+ only; HSTS preloaded; API keys are looked up by hash and also stored encrypted, so the dashboard
  can show them again only after a second-factor check; webhook secrets are shown once and stored encrypted
  (as are partner credentials - per-merchant KMS key).
* xpubs are stored encrypted and returned redacted; CoinVello never possesses private keys,
  so there is nothing to steal that can move funds.
* Webhook payload authenticity: HMAC-SHA256 `CoinVello-Signature` with timestamp and
  5-minute replay window ([webhooks.md](webhooks.md)).
* Signed transactions you submit for conversions/refunds/off-ramp are decoded and compared
  byte-for-byte with what CoinVello prepared before broadcast (`transaction_mismatch`).

## Reporting

support@coinvello.com (subject: "Security"). Please include steps to reproduce; do not test against other merchants' accounts.
