# Access token + refresh token auth — silent renewal instead of forced re-login

**Status:** proposed — not yet built
**Date:** 2026-09-16
**Applies to:** `server/routes/auth.js` (doctor login) · `server/routes/patientAuth.js` (patient login) ·
`server/middleware/auth.js` · `auth_sessions` table · `src/stores/authStore.js` · `src/services/api.js`
**Related:** `docs/PATIENT_BLOCKLIST_PLAN.md` (patient session revocation on block), `shared/permissions.js`

---

## 1. What we have today, and why it isn't enough

Today there is exactly **one token** per session, and it does double duty as both the thing you
send on every request and the thing that decides how long you stay logged in:

- Doctor: `POST /api/auth/login` (`server/routes/auth.js:65-113`) mints one JWT, `JWT_EXPIRES_IN`
  (default `24h`), containing `{doctor_id, doctor_name, short_name, specialty, role, jti}`. The
  `jti` is inserted into `auth_sessions` so logout can revoke it.
- Patient: `issueSession()` (`server/routes/patientAuth.js:222-253`) mints one JWT, `JWT_PATIENT_EXPIRES_IN`
  (default `30d`), containing `{kind:"patient", db, patient_id, phone, name, jti}`, same
  `auth_sessions` revocation pattern.
- The client stores that single token in `localStorage["gini_auth_token"]`
  (`src/stores/authStore.js:108`) and an axios request interceptor attaches it as `x-auth-token`
  on every call (`src/services/api.js:14-18`).
- When the token expires, `authMiddleware` (`server/middleware/auth.js:17-49`) just leaves
  `req.doctor`/`req.patient` unset — no distinct "expired" signal — so the next call that requires
  auth comes back `401`, the axios response interceptor wipes `localStorage` and hard-redirects to
  `/login` (`src/services/api.js:48-68`).

The problem: **there is no renewal path.** A doctor mid-consultation at hour 24 (or a patient at
day 30) gets bounced to `/login` with no warning, losing whatever they were doing —
`active_visits` autosave protects the clinical data itself, but the interruption is real, and on a
shared OPD terminal it means re-selecting the doctor and re-entering a PIN in front of a patient.
Shortening `JWT_EXPIRES_IN` to reduce the blast radius of a leaked token (XSS, a shared machine,
a stolen laptop) makes this worse, not better — every hour makes the forced-logout problem more
frequent. The two goals (short-lived credentials in the browser, and not interrupting a doctor
mid-shift) are in tension with a single token. Access + refresh resolves that tension: a short-lived
**access token** does the per-request auth (small blast radius if it leaks), and a longer-lived
**refresh token** — used only against one endpoint, never sent with ordinary API calls — silently
mints a new access token before or right after the old one expires.

---

## 2. The decisions

| Question | Decision |
| --- | --- |
| Access token TTL | 15 minutes, both roles. |
| Refresh token TTL — doctor | 7 days. Shared clinic terminals across shifts; see §2a. |
| Refresh token TTL — patient | 30 days, unchanged from today's single-token life — no UX regression for the patient app. |
| What *is* the refresh token? | A random 48-byte opaque string, **not** a JWT. Verified by DB lookup only, never `jwt.verify`d. |
| Where is it stored server-side? | New `refresh_tokens` table, hashed (`sha256`), never stored raw — mirrors "never log the PIN" hygiene already in this codebase. |
| Where is it stored client-side? | `localStorage`, same trust model as the access token today. See §2b for why this isn't a cookie. |
| Rotation | Every refresh call issues a **new** refresh token and revokes the old one (rotate-on-use). Reusing an already-rotated token revokes the whole family and forces re-login — reuse of a dead token is the signature of a stolen token in play. |
| Does `authMiddleware` still hit `auth_sessions` on every request? | Yes, unchanged. See §2a — this is what makes logout on a shared terminal instant. |
| Who can call `/api/auth/refresh`? | Public path, rate-limited like login. The refresh token itself is the credential. |

### 2a. Why keep the per-request `auth_sessions` DB check, when access tokens are already short-lived

The standard access/refresh pattern usually drops server-side tracking of the access token — 15
minutes of unrevocable-but-short-lived exposure is an accepted trade in most apps. **Not here.**
This hospital's doctor/MO/nurse accounts are used on shared OPD terminals across shifts
(`GRANT_ALL_CAPABILITIES` history, the whole `shared/permissions.js` role matrix exists because
one machine serves many roles across a day). If a doctor logs out at a shared desk, the next
person sitting down must not be able to keep acting as them for up to 15 more minutes because the
old access token is still cryptographically valid. So: **access tokens stay checked against
`auth_sessions` on every request**, exactly as today (`server/middleware/auth.js:28-32`) — logout
stays instant. The 15-minute TTL only bounds how long a token is *useful if the check is somehow
bypassed or the DB is unreachable*, and it bounds how long a stolen-and-replayed token works
without also stealing the refresh token. This is a smaller change than it looks: today's
15-minute-vs-24-hour difference is not a new DB query, it's the same query running the same
number of times (once per request, as now) — just against tokens that expire faster so a
compromised one is worth less.

### 2b. Why `localStorage`, not an httpOnly cookie, for the refresh token

The textbook answer is an httpOnly cookie so client-side JS (and an XSS payload) can never read
the refresh token at all. Rejected for v1, for reasons specific to this codebase, not because it's
wrong in general:

- The whole app is header-based (`x-auth-token`), same-origin in prod but the API also serves a
  separate `Companion` capture UI (`src/companion/`) and is called with the token pulled from
  `localStorage` directly by several non-axios consumers — `PatientRecordModal.jsx`, `OPD.jsx`,
  `RoleInboxPage.jsx`, and the `EventSource`-based live hooks (`useGiniflowLive.js:90,129-133` and
  siblings) that open SSE connections with `?token=` in the URL. A cookie-based refresh flow would
  need CSRF protection added everywhere and wouldn't change how those SSE connections authenticate
  anyway (`EventSource` can't send custom headers or read cookies cross-context the same way).
  Converting only the *refresh* token to a cookie while the access token stays header-based splits
  the auth model in two for a partial benefit.
- Rotation + reuse detection (§2, "Rotation") is the mitigation this plan relies on instead: a
  refresh token stolen via XSS is only usable once before rotation invalidates it and — if the
  real client tries to use its now-dead token next — the theft is detected and the whole session
  family is revoked.

**Follow-up, not v1:** if XSS exposure becomes a live concern, moving the refresh token to an
httpOnly cookie is the natural next step and doesn't require changing the access-token side of
this design.

---

## 3. Schema

New table, additive migration, doesn't touch `auth_sessions`:

```sql
-- server/migrations/2026-09-xx_refresh_tokens.sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'doctor',      -- 'doctor' | 'patient'
  doctor_id    INTEGER REFERENCES doctors(id),
  patient_db   TEXT,                                -- 'hospital' | 'app', patient sessions only
  patient_ref  TEXT,                                -- patients.id or app-db uuid, as text
  token_hash   TEXT UNIQUE NOT NULL,                 -- sha256(raw refresh token), hex
  family_id    TEXT NOT NULL,                        -- constant across one login's rotation chain
  revoked_at   TIMESTAMPTZ,                          -- set on rotation, logout, or reuse-detection
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  user_agent   TEXT,
  ip           TEXT,
  CHECK ((kind = 'doctor'  AND doctor_id   IS NOT NULL)
      OR (kind = 'patient' AND patient_ref IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash    ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family  ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
```

`family_id` (a UUID) is what makes reuse detection possible: every rotation of the same login
session carries the same `family_id` forward. On refresh, if the presented token's row has
`revoked_at IS NOT NULL`, every row sharing that `family_id` gets revoked and the caller is forced
to `/login` — the token being reused is proof someone else already redeemed it once.

`patients.id`/`app`-db uuid is stored as `patient_ref TEXT` rather than an FK, mirroring
`auth_sessions.patient_ref` (`server/migrations/2026-05-19_auth_sessions_app_patients.sql`) exactly
— patient identity already spans two databases and this table needs the same shape.

---

## 4. Backend changes

### 4a. Env vars (replace/extend, `server/loadEnv.js` picks these up the same way as today)

```
JWT_ACCESS_EXPIRES_IN=15m          # was JWT_EXPIRES_IN — rename, both roles
JWT_REFRESH_EXPIRES_IN_DOCTOR=7d
JWT_REFRESH_EXPIRES_IN_PATIENT=30d
```

### 4b. `server/routes/auth.js`

- `POST /api/auth/login` — unchanged credential check (doctor_id + PIN). On success:
  1. Sign the access JWT exactly as today, `expiresIn: JWT_ACCESS_EXPIRES_IN`.
  2. Generate a raw refresh token (`crypto.randomBytes(48).toString("hex")`), `family_id =
     crypto.randomUUID()`.
  3. Insert into both `auth_sessions` (access jti, as today) and `refresh_tokens` (hashed refresh
     token, new family).
  4. Response becomes `{ access_token, refresh_token, expires_in, doctor }`. (`token` stays as an
     alias for `access_token` for one deploy cycle — see §6, rollout.)
- **New** `POST /api/auth/refresh` — public path, rate-limited (reuse `loginLimiter` as-is, or a
  sibling `refreshLimiter` built the same way — verified in `server/middleware/rateLimit.js`:
  `loginLimiter` is 50 requests/15min **keyed by IP** via `express-rate-limit`'s default
  `keyGenerator`, `skipSuccessfulRequests: true`, not the "5 per 15 min" this plan first assumed).
  Body: `{ refresh_token }`.
  1. Hash the presented token, look up by `token_hash`.
  2. Not found → `401`.
  3. Found but `revoked_at` set → **reuse detected**: revoke every row with that `family_id`,
     write an `audit_log` entry (verified columns: `doctor_id, action, entity_type, entity_id,
     details` — used identically in `consultations.js:195`, `ghm-patient-record.js:60`,
     `patientBlocks.js:20`; this table has no migration file in this repo, same "created by hand on
     prod" situation as `auth_sessions` originally — set `action: 'refresh_reuse_detected'`,
     `entity_type: 'refresh_token'`, `entity_id: family_id`), respond `401` with a code the
     client treats as "force full logout," not "retry."
  4. Found, not revoked, `expires_at` in the past → `401`, force full logout.
  5. Valid → mint a new access token + new refresh token (same `family_id`), revoke the presented
     row (`revoked_at = NOW()`), insert the new row, insert the new access jti into `auth_sessions`
     (and let the old access jti expire naturally out of `auth_sessions` — no need to revoke it
     early, its own TTL is already short).
  6. Response: `{ access_token, refresh_token, expires_in }`.
- `POST /api/auth/logout` — in addition to today's `auth_sessions` delete by access jti, also
  revoke the refresh token: accept `{ refresh_token }` in the body (client sends it alongside the
  access-token header it already sends), hash it, set `revoked_at = NOW()` on that row **and**
  every other non-revoked row sharing its `family_id` — "logout" should kill the whole chain, not
  just the current link.

### 4c. `server/routes/patientAuth.js`

Same shape, scoped to `issueSession()` (`patientAuth.js:222-253`) and a new `POST
/patient/auth/refresh` sibling to `/patient/auth/login`. `issueSession()` becomes the one place
that mints *both* tokens (it's already the single chokepoint for login, set-password, verify-otp
completion, and the app→hospital DB upgrade — see the comment at `patientAuth.js:225-227` — so the
blocked-patient check in step 1 automatically covers refresh too, as long as `/patient/auth/refresh`
re-checks `isPatientBlocked()` before issuing, not just at original login). `POST
/patient/auth/logout` gets the same family-revoke treatment as §4b.

**Out of scope for this repo:** the patient-facing login/OTP UI isn't in this codebase (confirmed
absent from `src/pages` and `src/components` — see the earlier login-flow audit). Whatever mobile
client consumes `patientAuth.js` needs its own refresh-retry logic added; this plan only covers
the API contract it will call against.

### 4d. `server/middleware/auth.js`

No structural change — `authMiddleware` keeps validating the access JWT and checking
`auth_sessions` exactly as today (§2a). Add `/api/auth/refresh` and `/patient/auth/refresh` to
`PUBLIC_PATHS` (`server/middleware/auth.js:51-64`).

---

## 5. Client changes

### 5a. `src/stores/authStore.js`

- State: `authToken` (access) stays, add `refreshToken`, both hydrated from
  `localStorage` at two keys: `gini_auth_token` (unchanged key, still the access token) and
  `gini_refresh_token` (new).
- `handleLogin()` stores both from the login response.
- `handleLogout()` sends `{ refresh_token }` in the `POST /api/auth/logout` body before clearing
  local state, so the server-side family revoke in §4b actually fires.
- New `refreshAccessToken()` — calls `POST /api/auth/refresh`, updates both tokens in state +
  `localStorage` on success, throws on failure (caller decides whether that means full logout).

### 5b. `src/services/api.js` — the actual renewal mechanics

Two complementary triggers, because this app has both axios calls *and* the `EventSource`/SSE
connections in §2b that axios interceptors never see:

1. **Reactive (axios response interceptor):** on `401`, instead of immediately clearing
   `localStorage` and redirecting (today's `src/services/api.js:52-65`), first try one
   `refreshAccessToken()`. Standard single-flight guard — a page can fire a dozen concurrent
   requests right as the token expires, and they must not each trigger their own refresh call:

   ```js
   let refreshPromise = null;
   function refreshOnce() {
     if (!refreshPromise) {
       refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
     }
     return refreshPromise;
   }
   ```

   On refresh success: retry the original failed request with the new access token. On refresh
   failure (expired/revoked/reuse-detected): fall through to today's full-logout-and-redirect path
   unchanged.

2. **Proactive (timer, decoded from the access JWT's `exp`):** on login and on every successful
   refresh, schedule a refresh ~60 seconds before the access token's actual expiry. This is what
   keeps the SSE connections alive without a gap — `useGiniflowLive.js` and its siblings already
   re-read `localStorage["gini_auth_token"]` fresh on every reconnect (`useGiniflowLive.js:133`),
   so as long as a fresh token lands in `localStorage` before the *current* one expires, a
   reconnect (which these hooks already do periodically) picks it up. An open `EventSource`
   doesn't get a new header mid-stream, but it doesn't need to — the server only checks the token
   at connect time for these long-lived streams (confirm this against the current SSE auth check
   in `server/services/flow` before implementing; if it re-validates mid-stream, the stream needs
   an explicit reconnect-on-refresh callback instead of relying on its own periodic reconnect
   timing).

### 5c. Non-axios direct `localStorage` readers

`PatientRecordModal.jsx`, `OPD.jsx`, `RoleInboxPage.jsx`, and the `useGiniflow*` hooks all read
`gini_auth_token` straight from `localStorage` rather than through `api.js`. None of these need
code changes — they keep working exactly as today, because the refresh mechanism's job is to keep
`localStorage["gini_auth_token"]` fresh, not to change how it's read.

---

## 6. Rollout

Additive on both ends — no destructive migration, no forced mass-logout:

1. Ship the `refresh_tokens` migration.
2. Ship the backend changes. Keep `POST /api/auth/login` and `/patient/auth/login` responses
   backward-compatible for one deploy: include both `token` (legacy key, = `access_token`) and the
   new `access_token`/`refresh_token` fields, so an unrefreshed client tab mid-session doesn't
   break against the new API shape.
3. Ship the frontend changes.
4. A session that was already logged in before this deploy has an access token but no refresh
   token in `localStorage`. It keeps working until that token's *original* TTL (24h/30d) expires
   naturally, at which point — with no refresh token available — it falls through to the existing
   401 → full logout path, same as it does today. One more login after this deploy, same as any
   other day the token would have expired; no special migration handling needed.
5. Drop the legacy `token` alias in the response body once the old TTL window has fully elapsed
   (30 days after deploy, to cover the longest-lived pre-existing patient session).

---

## 7. Testing

Follow the existing `server/scripts/smoke-*.mjs` convention (`npm run smoke:<name>` from
`server/`) — add `smoke-auth-refresh.mjs`:

- Login → get access + refresh token pair.
- Call an authenticated endpoint with the access token → succeeds.
- Call `/api/auth/refresh` with the refresh token → new pair returned, both different from the
  originals.
- Call an authenticated endpoint with the **old** access token → still works until its own TTL
  lapses (it wasn't revoked early, per §4b step 5) — assert this is *not* immediately rejected.
- Call `/api/auth/refresh` again with the **already-rotated** refresh token → `401`, and assert
  the *new* (second) refresh token is now also rejected (family-wide revoke worked).
- Logout → assert the refresh token is rejected afterward.
- Expire a refresh token manually (`UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1
  minute'`) → assert refresh fails cleanly with a "force full logout" response, not a 500.

Manual/browser check per the run/UI-testing convention: log in, use dev tools to confirm a
background refresh call fires silently before the 15-minute mark with no visible interruption, and
that a live Gini Flow board (SSE) stays connected across a refresh cycle.

---

## 8. Open questions for you to confirm before implementation starts

1. **7-day doctor refresh TTL** — reasonable, or should shared-terminal accounts (nurse, reception,
   coordinator, pharmacy) get a shorter refresh window than a consultant's personal login?
2. **SSE mid-stream re-validation** — needs a direct check against `server/services/flow`'s SSE
   auth code before finalizing §5b's "reconnect handles it" assumption; if it re-validates on an
   interval, we need to add that.
3. Confirm 15 minutes is the right access-token TTL for this environment — shorter tightens the
   leak window but means more frequent refresh traffic; longer is the opposite trade.
