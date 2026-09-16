# Doctor Growth CRM — Phase 1

Physician-relations system for Gini Advanced Care Hospital, built for Head of
Growth Virender Satija and his field team. Brief: `~/docs/gini-doctor-growth-crm-brief.md`.

Phase 1 is **live on production**. This is the handoff: what exists, how to
operate it, and what Phase 2 is.

---

## Where it lives

A dedicated `crm` schema inside the **same Supabase project as Scribe** — not a
separate database. No existing Scribe table was altered; the only coupling is
read-only foreign keys to `public.patients(id)`, plus `COMMENT ON` labels that
distinguish inbound from outbound referrals.

```
27 tables · 52 RLS policies · 40 CHECK constraints · 0 Postgres enums
roles: crm_app, crm_registration
```

Live data today: **47 doctors** (all skeleton records — no phone numbers yet),
9 flagged for transcription verification, 1 CRM user, 0 visits, 0 assignments.

### The one thing to understand before touching this

**Supabase grants `BYPASSRLS` to the `postgres` role**, which is what
`DATABASE_URL` connects as. `FORCE ROW LEVEL SECURITY` therefore does *not*
protect the CRM on its own. Every CRM query must drop to `crm_app` first —
that is the actual access control.

It is enforced in four places, so it cannot quietly stop being true:

| Guard | Fires when |
|---|---|
| `withCrmContext()` in `server/crm/db.js` | the only sanctioned query path |
| `server/crm/checkNoDirectPool.mjs` | any file under `server/crm/` imports the pool — fails the build |
| `server/crm/assertCrmIsolation.js` | RLS off a table, stray GRANT, DELETE granted — refuses to boot |
| `crm.assert_app_role()` | a query arrives in-transaction without the switch |

Clinical isolation is **structural, not filtered**: `crm_app` holds zero grants
on schema `public`. Patient identity reaches the CRM only through
`crm.v_referral_patients` — seven identity columns, no clinical ones.

### NMC compliance

No incentive, commission or payout field may ever exist in `crm`. Enforced by
the event trigger `crm_no_payout_columns` (which *did* install on Supabase,
contrary to expectation) and backed by `ci_compliance_check.sh` in CI for any
environment that refuses event triggers.

---

## Operating it

### Onboard a growth team member

Four things must line up across three places. One command does all four in a
single transaction, **dry by default**:

```sh
railway run -s gini-scribe -e production -- node server/scripts/crm-onboard-user.mjs \
  --name "Rajeev Malhotra" --role growth_executive \
  --manager "Virender Satija" --territory Kharar --pin 4417 --commit
```

Drop `--commit` to see the plan and change nothing. It refuses rather than
guessing when the named manager or territory does not exist, and territory
assignment only claims doctors **nobody owns** — reassignment carries history
and is a deliberate act, not an onboarding side effect.

Roles: `head_of_growth`, `growth_manager`, `growth_executive` get their own
Scribe login; `clinical_team` and `operations` are existing hospital staff, so
link an existing account instead.

### Import a doctor list

The wizard is at **`/crm/import`** — upload, map columns, preview, commit.
Nothing reaches `crm.doctors` until the preview is confirmed. For the first
load, when no CRM user exists yet to sign in:

```sh
railway run -s gini-scribe -e production -- \
  node server/scripts/crm-import-doctors.mjs <file.csv> --commit
```

Dedup is two-tier on purpose. A matching normalised **mobile is the same
doctor** and is skipped. A matching **name in the same territory is only a
suspicion** — "Dr Sharma, Mohali" is not rare — so it is surfaced for a human
and imports unless they say otherwise.

### Apply a migration

```sh
railway run -s gini-scribe -e production -- server/migrations/crm/apply_supabase.sh
railway run -s gini-scribe -e production -- server/migrations/crm/verify_supabase.sh
```

Every migration is idempotent and safe to re-run. `apply_supabase.sh` retargets
the **session pooler on 5432** — `DATABASE_URL` points at the transaction
pooler on 6543, which does not hold the session state `SET LOCAL ROLE` needs.

Migrations follow the house convention (`YYYY-MM-DD_name.sql` in
`server/migrations/`) and are also runnable individually through
`_runOne.mjs`. Applied so far:

```
2026-09-16_crm_phase1                  schema, 26 tables
2026-09-16_crm_phase1_rls              policies, views, compliance guard, seed
2026-09-30_crm_enums_to_text           16 enums -> TEXT + CHECK
2026-10-01_crm_registration            crm_registration role + picker search
2026-10-03_crm_registration_record_fn  write moved behind a definer function
2026-10-02_crm_inbound_attribution_comments
2026-10-04_crm_doctor_skeleton_records doctors without a phone number
```

### Testing

```sh
server/migrations/crm/rehearse_migration.sh        # full chain + 85 assertions
cd server && node scripts/smoke-crm-offline-queue.mjs   # 22, no database needed
DATABASE_URL=<scratch> node scripts/smoke-crm-visits.mjs    # 23
DATABASE_URL=<scratch> node scripts/smoke-crm-import.mjs    # 34
```

The database suites need a **fresh** scratch database — they assert on dedup
and uniqueness outcomes, so rows left by a previous run change the answers.
CI runs everything on PostgreSQL 17 and 15 on every commit.

**Airplane-mode test: `docs/CRM_OFFLINE_TEST.md`.** Ten steps on a real Android
phone. The queue logic is pinned by the mocked-transport suite; what that
cannot prove is that `localStorage` survives the app being killed and that
Chrome fires `online` when signal returns. Run it before the team uses the app.

---

## What's built

**Doctor universe** — `crm.doctors` with mobile as canonical identity *when
present*. Mobile is nullable and the unique index is partial, because the first
real list is transcribed from handwritten notes and has none. `profile_complete`
and `missing_fields` are **generated columns**, so no code path can claim a
doctor is contactable when they are not, and `crm.v_doctors_needing_details` is
the resulting rep work queue.

**Segmentation, territory, ownership** — A/B/C priority, nine relationship
stages with history, effective-dated assignments with a GiST exclusion
constraint that makes two live owners of one doctor impossible.

**Visit logging** (`/crm/visit/:doctorId`) — under-60-second entry: doctor
pre-selected, chips for type/purpose/outcome, notes optional with dictation,
next-visit date pre-filled from the cadence policy. Optional GPS with a
4-second timeout that can never block a save.

**Offline** — the visit id is minted on the **client**, and the insert is
`ON CONFLICT DO NOTHING` on that id. Sending the same visit twice is a no-op,
which is what makes "retry until it sticks" safe rather than a duplicate
generator. Saves write to `localStorage` synchronously, so a visit is on disk
before the handler returns.

**Rep home** (`/crm/home`) — To visit / Today / My doctors / Tasks, one request,
mobile-first. All three growth roles land here.

**Referral attribution** — "who referred you?" is mandatory on all three Scribe
registration surfaces, writing `crm.patient_referral_sources`. Front-desk staff
need no CRM identity: `crm_registration` holds **zero table privileges** and
only the right to ask two questions. Flow check-in is the one sanctioned
exemption (`allow_unattributed`) — those patients surface in
`crm.v_attribution_unknown`.

**Import wizard** (`/crm/import`) — column mapping with header auto-matching,
preview with dedup and flags, row-level errors, provenance back to the batch.

---

## Phase 2 backlog

In the order the brief sets out, with what each actually depends on.

### 1. Scribe / HIS journey automation (brief §14)
Advance `crm.referral_journey_events` automatically as a referred patient moves
through Scribe — registration, OPD, admission, ICU, procedure, discharge,
billing. Match on canonical `patient_id` first, phone second.

*Depends on:* nothing new in the CRM; the journey table and statuses are built
and currently updated by hand. This is a Scribe-side listener.

*Watch out for:* the five patient-creation paths. Only registration asks "who
referred you?", so a patient created through check-in or a sync job has no
attribution row and cannot be journey-matched to a referral until someone
resolves them from `crm.v_attribution_unknown`.

### 2. Revenue capture (brief §15)
Revenue = **amount collected**, net of discounts and refunds, pulled from Scribe
billing at encounter level and attributed to the verified referral. Gross billed
shows as a secondary figure.

*Depends on:* `crm.revenue_records` exists with the `scribe_billing` source
already modelled — Phase 2 adds the writer. Ops-entered rows stay flagged
`is_manual` and must remain visually distinct wherever they appear.

### 3. Referring-doctor communication loop (brief §16)
Track acknowledgement, consultation update, admission notice, discharge
summary, investigation report — what was sent, when, by whom, channel, delivery
status.

*Depends on:* **`crm.patient_consents` and `crm.has_consent()`, which are built
and must gate every clinical send.** Sending a discharge summary to a referring
doctor is sharing health data with a third party under the DPDP Act 2023. Do
not build this loop without the consent check wired in from the first commit.

### 4. Referral leakage dashboard (brief §17)
Operational alerts for every break in the funnel: referral received but patient
never contacted, contacted but never arrived, admission advised but not
admitted, discharged but the referring doctor never told.

*Depends on:* journey automation (1) being real, otherwise it measures data
entry rather than reality.

### 5. Potential vs actual, activation and churn (brief §18, §19)
High potential + low actual = opportunity. High actual + declining = risk.
Auto-classify New Active / Growing / Dormant / At-Risk / Reactivated into a
reactivation queue.

*Depends on:* revenue (2). `crm.doctor_service_opportunities` already holds
potential/current/target/actual per service line.

### 6. Growth team and management dashboards (brief §20, §21)
Per-rep and hospital-wide. Track **both** total visits and unique doctors
visited, so repeated low-value visits cannot inflate activity. Every revenue
view distinguishes verified from claimed attribution.

*Depends on:* visit data accumulating, which starts the day the team goes live.

### Carried-over items

- **Territory assignment.** All 47 doctors are currently **unassigned** —
  leadership sees them, no executive owns any. Decide the split and run the
  onboarding command per person.
- **Virender's login is inactive.** Activate with the onboarding command when
  ready.
- **`verify-rbac.mjs` has 2 pre-existing failures** on `nurse` and two
  `/api/flow` routes. Unrelated to the CRM, present before this work, not fixed.
- **Potential score** is manual (A/B/C plus an estimated monthly figure). The
  schema has `potential_score_computed` reserved; the brief defers the
  algorithm to Phase 3.
- **Supabase branch for behavioural testing.** The full suite needs fixture
  rows including patients, so it runs on scratch rather than production. A
  branch would let it run on Supabase infrastructure — worth doing when Phase 2
  integration starts.

### Three referral tables, two directions

A recurring source of confusion, so it is worth stating plainly:

| Table | Direction |
|---|---|
| `crm.doctor_referrals` | **inbound** — an external doctor sends a patient TO Gini |
| `giniflow_referrals` | **outbound** — a Gini doctor refers a patient OUT |
| `public.referrals` (legacy, created at runtime by `visit.js`) | **outbound** |

Both outbound tables and the inbound one carry `COMMENT ON` labels naming their
direction. `appointments.how_did_you_know` and
`appointments.referred_by_doctor_name` are **dormant** — free text, never
populated in 45,940 appointments, labelled as superseded by
`crm.patient_referral_sources`. Do not build on them.

---

## Design record

`server/migrations/crm/NOTES.md` — the full reasoning, including bugs found
during verification and the two things that would have gone wrong silently.
`docs/crm-phase1-applied.md` — what was applied when, and the evidence.
