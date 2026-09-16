# CRM Phase 1 — applied to production

> Operating guide and Phase 2 backlog: **`docs/CRM_PHASE1.md`**.
> Airplane-mode device test: **`docs/CRM_OFFLINE_TEST.md`**.

**Applied 2026-09-16** to the Supabase project shared with Gini Scribe
(`aws-1-ap-south-1.pooler.supabase.com`, PostgreSQL 17.6).

## What went in

A dedicated `crm` schema — 26 tables, 16 enums, 52 RLS policies, 6 views, 73
indexes. No existing Scribe table was altered. The only coupling is read-only
foreign keys to `public.patients(id)`, plus a `COMMENT ON` label added to
`public.referrals` to distinguish its direction.

Reference data seeded: 1 hospital (GACH Mohali), 8 territories, 16 service
lines, 4 visit-cadence policies.

## Follow-ups applied the same day

| Migration | What it did |
|---|---|
| `2026-09-30_crm_enums_to_text.sql` | Converted 16 Postgres enums to TEXT + CHECK, matching the house rule. Labels moved to `shared/crmVocab.js`. |
| `2026-10-01_crm_registration.sql` | `crm_registration` role and the doctor-picker search function. |
| `2026-10-03_crm_registration_record_fn.sql` | Moved the write behind a definer function; the role now holds **zero** table privileges. |
| `2026-10-02_crm_inbound_attribution_comments.sql` | Labelled the two dormant `appointments` columns. |

The enum conversion is a guarded rebuild rather than 16 `ALTER TYPE`s, because
`crm.current_user_role()` returns one of them and all 52 policies call it — an
in-place conversion means dropping and recreating every policy anyway. It
refuses outright if the CRM has picked up operational data.

## Verification

| Suite | Where | Result |
|---|---|---|
| `verify_supabase.sh` (read-only) | production | **33 / 33 pass** |
| `verify_rls.sh` (behavioural) | scratch, PostgreSQL 17.11 | **75 / 75 pass** |
| `verify_rls.sh` (behavioural) | scratch, PostgreSQL 15.19 | **75 / 75 pass** |
| `rehearse_migration.sh` | scratch | full production path, 75 / 75 |
| `ci_compliance_check.sh` | both | pass |

`rehearse_migration.sh` rebuilds the schema exactly as production had it, runs
the migration chain over it, then verifies. It is what caught `DROP ROLE`
failing on a role holding grants in another database — which would have left
production half-migrated, with the tables standing and their RLS gone.

`crm_app` was confirmed refused on the live `public.patients` table
(18,562 rows) — permission denied, not an empty result.

The NMC event trigger `crm_no_payout_columns` **did install on Supabase**,
contrary to expectation, and rejects a `referral_fee` column there. Its
creation is nonetheless wrapped to degrade to a warning, because both
migration files run in a transaction: letting it raise would roll back all of
`002` and leave `001`'s tables with no row-level security at all.

## The thing to remember

Supabase grants `BYPASSRLS` to `postgres`, which is what `DATABASE_URL`
connects as. `FORCE ROW LEVEL SECURITY` therefore does **not** protect the CRM
on its own. Every CRM query must run `SET LOCAL ROLE crm_app` first — that is
the actual access control, and it is enforced by:

- `withCrmContext()` in `server/crm/db.js` — the only sanctioned query path
- `server/crm/checkNoDirectPool.mjs` — build-time scan, fails on direct pool use
- `server/crm/assertCrmIsolation.js` — boot assertion, exits on a broken invariant
- `crm.assert_app_role()` — raises inside any transaction missing the switch

## Running it

```sh
cd server/migrations/crm

./rebuild.sh                            # scratch cycle, PostgreSQL 15
CRM_CONTAINER=gini-crm-17 ./rebuild.sh  # scratch cycle, PostgreSQL 17

railway run -s gini-scribe -e production -- ./apply_supabase.sh
railway run -s gini-scribe -e production -- ./verify_supabase.sh
```

Railway injects `DATABASE_URL` into the process; it is never written to a file
or printed. Note that `DATABASE_URL` points at the transaction pooler (6543),
which does not hold session state — both production scripts retarget the
session pooler on 5432.

`apply_supabase.sh` refuses to run if the `crm` schema already exists, and
applies only `001` and `002`. It never runs the Scribe stub or the test
fixtures, which would insert fake patients into the live clinical database.

## Not done

The behavioural suite does not run against production, because it needs
fixture rows including `public.patients`. When Phase 2 integration starts,
a Supabase branch is the place to prove behaviour on Supabase infrastructure.

See `server/migrations/crm/NOTES.md` for the full design record.
