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
| Refresh token TTL — doctor | 7 days, **same for every role** (admin, consultant, mo, nurse, reception, coordinator, lab, tech, pharmacy, obt, guest) — no per-role TTL split. See §2a for why the access-token check, not the refresh TTL, is what protects shared terminals. |
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
   reconnect (which these hooks already do periodically) picks it up.

   **Verified, no longer an open question:** the SSE route is `GET /api/giniflow/events`
   (`server/routes/giniflow.js:71-93`, backed by `server/services/giniflow/eventHub.js`), gated by
   `requireCapability(CAP.GINIFLOW_VIEW)` — an Express middleware that runs once, when the request
   first comes in. The handler then `res.writeHead`s an `event-stream` and hands `res` to
   `addClient()`; nothing in `eventHub.js` re-checks the token again for the life of that
   connection. So an already-open `EventSource` is completely unaffected by its access token
   expiring — the 15-minute TTL only matters at the *next* connect (initial open, or a reconnect
   after a network drop), which is exactly when it reads a fresh token out of `localStorage`
   anyway. No reconnect-on-refresh callback is needed; §8 open question #2 below is resolved.

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

1. ~~7-day doctor refresh TTL, per-role split?~~ — resolved: **same 7-day refresh TTL for every
   role**, no split. A shorter TTL for shared-terminal roles wouldn't actually buy the safety it
   sounds like it would — §2a already makes the access-token `auth_sessions` check (revoked
   instantly on logout) the thing that protects a shared desk, not the refresh token's lifetime, so
   splitting refresh TTLs by role would only add a config dimension with no security benefit and a
   real cost (a nurse on a personal device at home now gets logged out weekly instead of like
   everyone else).
2. ~~SSE mid-stream re-validation~~ — resolved, see §5b: `/api/giniflow/events` only checks auth at
   connect time, so it needs no changes.
3. ~~15-minute access TTL~~ — confirmed. Implementation started 2026-09-16.

---

## 9. Verification log (2026-09-16 re-check)

Re-checked against the live codebase before implementation start; everything above already
reflects the fixes. Summary of what was confirmed vs. corrected:

- **Confirmed:** `refresh_tokens` design is additive and doesn't collide with anything; `auth_sessions`
  shape, doctor/patient login response shapes (`{token, doctor}` and `{token, db, patient,
  linkedPatients, force_password_reset}`), and `authStore.js`'s `data.token`/`data.doctor`
  destructuring all match what §4/§6 assume.
- **Confirmed:** `crypto.randomUUID()` needs no new dependency — already used in
  `server/services/giniflow/eventHub.js:1,14` via `import { randomUUID } from "node:crypto"`.
- **Confirmed:** `patientAuth.js` already reuses the same `loginLimiter` for
  `send-otp`/`verify-otp`/`login` (`patientAuth.js:292,367,475`), so a `/patient/auth/refresh`
  sibling route follows the exact same pattern already in place.
- **Corrected:** the rate-limiter shape in §4b — `loginLimiter` is 50 req/15min per IP, not
  "5 per 15 min" as first drafted.
- **Corrected/resolved:** §5b's SSE caveat and §8 question #2 — verified directly against
  `server/routes/giniflow.js` and `eventHub.js` that `/api/giniflow/events` authenticates once at
  connect, never mid-stream, so no reconnect-on-refresh code is needed.
- **Enriched:** the `audit_log` insert in §4b now names the real column set
  (`entity_type`/`entity_id` exist alongside `doctor_id`/`action`/`details`) and a concrete value
  for them, instead of the plan's original guess at a 3-column insert.
- **Genuine remaining unknowns** (not resolvable by reading code, need your input): §8 questions
  #1 (per-role refresh TTL) and #3 (15-minute access TTL) are product/security-posture calls, not
  facts to verify.

## 10. Implementation + post-implementation review (2026-09-16)

Built per §§3–7, migration applied to production, `smoke:auth-refresh` passing. A second review
pass on the finished code (not just the plan) found and fixed three real gaps before calling it
done:

- **Bug — false-positive theft detection on ordinary multi-tab use.** Rotate-on-use with no
  tolerance at all means two legitimate concurrent refresh attempts for the *same* token (two
  browser tabs, or the proactive timer racing the reactive 401 handler) look identical to a stolen
  token being replayed — both are "an already-rotated token presented again." Unmitigated, that
  revokes the entire family and force-logs-out every tab, every time, on completely legitimate use.
  Fixed with a 30-second reuse grace window (`REUSE_GRACE_MS` in `refreshTokens.js`) — but gated on
  a live rotated **sibling** existing in the family, not just recency. That distinction mattered:
  the first version of the fix also gave a deliberate revocation (logout, a real family-kill) the
  same 30-second free pass, which would have undone the "logout is instant" guarantee §2a is built
  around. `lookupRefreshToken()` now only tolerates a revoked token when a live sibling was minted
  at rotation time — a bare revoke-with-no-successor stays a hard, immediate "reused."
- **Gap — proactive refresh timer bypassed the single-flight guard.** The 401 interceptor in
  `api.js` had its own single-flight promise cache, but the proactive pre-expiry timer in
  `authStore.js` called `refreshAccessToken()` directly, so a timer firing at the same moment as a
  reactive 401 could still fire two concurrent `/api/auth/refresh` calls. Not dangerous after the
  grace-window fix (tolerated, not fatal), but wasteful. Moved the single-flight guard into
  `authStore.refreshAccessToken()` itself so every caller — timer or interceptor — shares one
  in-flight request; `api.js`'s wrapper now just delegates to it.
- **Gap — no cleanup for either token table.** Access/refresh rotation writes an `auth_sessions` +
  `refresh_tokens` row on every ~15-minute renewal — a full shift now writes dozens of rows where
  a 24h login used to write one, and neither table had a cleanup job (`auth_sessions` never did,
  even before this feature). Added `server/services/cron/authTokenCleanup.js`, wired into
  `server/services/cron/index.js`, deleting rows expired/revoked more than 7 days ago — runs once
  daily.

Also fixed in the same pass, smaller: `expires_in` in the login/refresh responses was the raw TTL
string (`"15m"`) instead of numeric seconds (unused by the client today, but wrong shape for
anything that reads it later); `ttlToMs()`'s TTL parser only matched bare integers with no space
(`"15m"`) and silently fell back to a 7-day default for anything else, widened to accept decimals
and the `ms` unit; and on genuine (beyond-grace) reuse detection, the fix now also deletes the
affected doctor's/patient's live `auth_sessions` rows, not just the refresh family — a real stolen
refresh token no longer leaves up to 15 minutes of already-issued access token usable after
detection.

`smoke:auth-refresh` was extended to cover the grace-window distinction directly (immediate
re-presentation tolerated with `graceReuse:true`; re-presentation after backdating past the grace
window treated as hard reuse) and re-run clean after each fix, on the real database, self-cleaning
as before.

## 11. Final line-by-line pass (2026-09-16, same day, on explicit request for zero known bugs)

Read every diff hunk fresh against the finished code (not memory of writing it) looking
specifically for bugs, not gaps. Found and fixed one real state-consistency bug:

- **Bug — `forceLogout()` in `api.js` didn't clear the store's in-memory `refreshToken`.** It
  cleared `localStorage`'s copy and the store's `authToken`/`currentDoctor`, but left
  `refreshToken` in the Zustand store stale. In the common case this self-heals — `forceLogout`
  calls `window.location.replace("/login")`, a full navigation that re-hydrates the store from
  (now-cleared) `localStorage` — but if the 401 fires while already sitting on `/login` (no
  navigation happens), the stale in-memory token could linger and get sent on a future
  `refreshAccessToken()` call. Never a security hole (the server always re-validates and the
  localStorage copy was already gone), just wasted round-trips. Fixed: `forceLogout()` now also
  calls the store's `setRefreshToken("")` and a new `clearProactiveRefresh()` action (stops the
  pending proactive-renewal timer too, for the same reason); `initAuth()`'s two invalid-token
  branches call the same timer-clear for consistency.

Everything else in the diff re-read clean on this pass: rate limiting, request ordering (mint
access token only after the refresh-token check passes; rotate only after the account's still
active/not-blocked), the `PUBLIC_PATHS`/`requireAuth` gating for both new refresh routes (verified
directly against a running server — 401 from the route's own token check, not 403 from the auth
gate, confirming they're genuinely public), body-parsing/middleware ordering in `server/index.js`
(`express.json()` and `authMiddleware` both run before the route mount), and the `auth_sessions`
row shape/expiry math. `smoke:auth-refresh` re-run clean (8/8) after this fix; server restarted
fresh and re-checked over HTTP one more time.
