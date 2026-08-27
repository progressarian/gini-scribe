# OBT Role — Implementation Plan

**Date:** 2026-08-18
**Goal:** Create login accounts for the OBT (outbound booking / call) team —
Ritu, Jaspreet, Rajinder — under a **dedicated `obt` role** that is scoped to the
OBT call-list work only, rather than reusing the broad `reception` role.

---

## 1. Background — what exists today

- Accounts live in the **`doctors`** table. Login is PIN-based
  (`server/routes/auth.js` → `POST /auth/login`); PINs are stored **bcrypt-hashed**.
- New accounts are created via the admin-only endpoint
  `POST /api/doctors` (`server/routes/auth.js:136`), which hashes the PIN and
  inserts the row.
- RBAC single source of truth is **`shared/permissions.js`** — imported by both
  the API (`server/middleware/auth.js`) and the client (`src/config/routes.js`).
- The OBT call list is served by `GET /api/obt-status`
  (`server/routes/obt-status.js`), currently gated by `RECEPTION_OPS`
  (`server/middleware/auth.js:147`). **No frontend page consumes it yet** — it is
  a backend endpoint only.

### ⚠️ Master-switch caveat (must be understood before shipping)

`GRANT_ALL_CAPABILITIES` in `shared/permissions.js` is **currently `true`**.
While it is true, `hasCapability()` returns `true` for everyone, so **no role
actually restricts anything at runtime** — role only shapes the frontend nav.

The work below makes `obt` _correctly scoped for when the switch is flipped to
`false`_. It does **not**, on its own, hard-wall the OBT team today. Truly
enforcing the restriction is a separate decision (flip the switch + regression-test
every other role) and is out of scope for this plan unless explicitly requested.

---

## 2. Design decision — dedicated capability, not just a role

The OBT team should reach **only the call list + patient lookup**, not the full
reception surface (`/opd`, `/ghm`, walk-ins, cancellations, reception inbox…).
Because `/api/obt-status` is currently gated by `RECEPTION_OPS`, simply giving the
new role `RECEPTION_OPS` would (once the switch flips) also unlock all of the
above. So we introduce a **dedicated capability `OBT_OPS`** and re-gate the OBT
endpoint to it.

### Who reaches `/api/obt-status` today (before this change)

It is gated by `RECEPTION_OPS`, which is held by **four** roles plus admin:

| Role          | Has RECEPTION_OPS today | Keep OBT list after re-gate?                                |
| ------------- | ----------------------- | ----------------------------------------------------------- |
| `admin`       | ALL                     | yes (ALL)                                                   |
| `reception`   | yes                     | **yes** → grant `OBT_OPS`                                   |
| `coordinator` | yes                     | **yes** → grant `OBT_OPS`                                   |
| `consultant`  | yes                     | **NO — deliberate drop** (doctors don't work the call list) |
| `mo`          | yes                     | **NO — deliberate drop** (doctors don't work the call list) |

- `OBT_OPS` is granted to: `obt`, `reception`, `coordinator`, `admin`(=ALL).
- **`consultant` and `mo` intentionally lose access** to the OBT list under the
  switch-off model. This is a real behavior change (not "no regression"): today,
  with the master switch on, all roles reach everything; once the switch flips,
  these two doctor roles would previously have kept the OBT list via
  `RECEPTION_OPS` and now will not. If either doctor role should keep it, add
  `C.OBT_OPS` to it in §3.1 — call it out before implementing.
- The new `obt` role holds: `PATIENT_READ` (look up the patient being called) +
  `OBT_OPS`. Nothing else.

---

## 3. Changes — file by file

### 3.1 `shared/permissions.js`

1. **Add the role** to `ROLES`:
   ```js
   OBT: "obt",
   ```
2. **Add the capability** to `CAPABILITIES`:
   ```js
   OBT_OPS: "OBT_OPS", // OBT outbound call team: tomorrow's appointment call list
   ```
3. **Grant `OBT_OPS`** to the existing roles that should keep the call list,
   inside `ROLE_CAPABILITIES`:
   - `reception` → add `C.OBT_OPS`
   - `coordinator` → add `C.OBT_OPS`
   - (`admin` already holds `ALL`, no change)
   - `consultant` / `mo` → **NOT added** (deliberate drop — see §2 table). Add
     `C.OBT_OPS` here only if the user says doctors should keep the list.
4. **Add the `obt` role matrix entry**:
   ```js
   [ROLES.OBT]: [C.PATIENT_READ, C.OBT_OPS],
   ```

### 3.2 `server/middleware/auth.js`

- Re-gate the OBT endpoint from `RECEPTION_OPS` to the new capability:
  ```js
  ["/api/obt-status", CAP.OBT_OPS],   // was CAP.RECEPTION_OPS
  ```
  (Longest-prefix matcher is unchanged; only the capability value changes.)

### 3.3 `src/config/routes.js` (only if/when an OBT page is built)

- No frontend route consumes `/api/obt-status` today, so **no change is required
  now**. When an OBT call-list page is added, map its path to `CAP.OBT_OPS` in
  `PAGE_CAPABILITIES` and add it to the router + nav.
- **Note this to the reader:** if the OBT list ever gets surfaced inside the
  existing `/opd` or `/ghm` page (both `RECEPTION_OPS`), the `obt` role would not
  see it — it would need its own page/section gated by `OBT_OPS`.

### 3.4 Account creation — `server/scripts/seed-obt-team.mjs`

- Update the existing draft script to insert with `role: "obt"` (was `reception`).
- Idempotent: skips a name that already exists.
- PINs: **to be set by the user** before running (currently placeholders). Stored
  bcrypt-hashed → not recoverable later, must be distributed to each person.
- ⚠️ `.env` DATABASE_URL is **production** — this inserts live rows. The user runs
  it; Claude does not run it against prod without explicit go-ahead.

---

## 4. Capability → access summary for the `obt` role

| Capability     | Grants access to                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBT_OPS`      | `GET /api/obt-status` (tomorrow's call list)                                                                                                             |
| `PATIENT_READ` | `/api/patients`, `/api/documents`, `/api/outcomes`, `/api/conversations`, `/api/messages`; client `/patient`, `/visit`, `/history`, `/outcomes`, `/docs` |

**Explicitly NOT granted:** clinical write, vitals, AI tools, lab portal,
reception ops (`/opd`, `/ghm`, walk-ins, cancellations, reception inbox),
med collection, all flow stations, analytics, admin.

---

## 5. Rollout steps

1. Edit `shared/permissions.js` (role + capability + matrix) — §3.1.
2. Edit `server/middleware/auth.js` — re-gate `/api/obt-status` — §3.2.
3. Update `server/scripts/seed-obt-team.mjs` to `role: "obt"` — §3.4.
4. User sets the three PINs in the script.
5. Run `npm run format` (prettier is the only formatter).
6. User runs `cd server && node scripts/seed-obt-team.mjs` against prod.
7. Verify: the three accounts appear in the login dropdown (`GET /api/auth/doctors`)
   and can authenticate.

## 6. Verification / smoke

- `normalizeRole("obt")` returns `"obt"` (not `guest`) — confirms the role is
  registered.
- With the master switch still `true`, all access is allowed regardless — so a
  true access test requires temporarily flipping `GRANT_ALL_CAPABILITIES` to
  `false` in a local/dev run and confirming `hasCapability("obt", "OBT_OPS")` is
  true and `hasCapability("obt", "RECEPTION_OPS")` is false. Do NOT flip it in
  production as part of this change.

## 7. Open questions for the user

1. **Scope confirmed?** OBT = call list + patient lookup only. If they also need
   to _update_ call status (mark called/booked), that's a write endpoint that
   must also be gated by `OBT_OPS` — name it if so.
2. **PINs** — user-supplied or Claude-generated random 4-digit?
3. **Enforce now or later?** This plan makes `obt` correct for the switch-off
   model but does not flip the master switch. Confirm that's acceptable.
4. **Doctors + the OBT list?** Re-gating `/api/obt-status` to `OBT_OPS` drops
   `consultant` and `mo` from it (see §2). Confirm doctors don't need the call
   list, or say to keep them.
