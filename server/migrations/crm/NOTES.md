# Gini Doctor Growth CRM — Phase 1 schema proposal

Status: **proposal, validated locally, awaiting approval.** Nothing has been
applied to the live Supabase project (`vuukipgdegewpwucdgxa`) and nothing has
been committed to the `gini-scribe` repo.

## Files

| File | What it is |
|---|---|
| `001_crm_phase1.sql` | Schema: 26 tables, 16 enums, constraints, data-level functions |
| `002_crm_phase1_rls.sql` | Authorisation helpers, triggers, grants, 52 RLS policies, 6 views, compliance guard, seed |
| `000_scribe_stub.sql` | **Local test only.** Minimal `public.patients` / `public.doctors` / `public.diagnoses` so the FKs resolve in a scratch DB |
| `003_test_seed.sql` | **Local test only.** Fixture data for the verification suite |
| `verify_rls.sh` | 50-assertion RLS + constraint verification suite |
| `ci_compliance_check.sh` | NMC fee-splitting gate, runnable against any database |
| `apply.sh` / `rebuild.sh` | Rebuild scratch DB, apply, seed, verify |

## Status: APPLIED TO PRODUCTION

Applied to the Supabase project (`postgres` @ `aws-1-ap-south-1.pooler...`,
**PostgreSQL 17.6**) via `railway run -s gini-scribe -e production --
./apply_supabase.sh`. The credential is injected by Railway into the process
and never written to a file or printed.

- 26 tables, 52 policies, RLS on all 26, reference seed in place.
- `verify_supabase.sh` (read-only): **24 of 24 pass on production**.
- The NMC event trigger **did install on Supabase** — the degradation path
  turned out not to be needed, though it remains in place and is tested.
- `public.patients` denial verified against the real 18,562-row table.

## Verification performed

Full behavioural suite on scratch containers, rebuilt from empty each run:
**57 of 57 assertions pass on both PostgreSQL 15.19 and 17.11.** The suite proves, as `crm_app`:

- A Growth Executive sees 1 of 3 doctors, 1 of 2 referrals, and practice
  intelligence only for the doctor they own. A Manager sees both reports'
  doctors; Head of Growth and CEO see all three.
- `public.patients` and `public.diagnoses` return **permission denied** — not
  an empty result. Patient identity arrives only via `crm.v_referral_patients`,
  which has no clinical column.
- `crm.referral_clinical_notes` returns zero rows to the executive and one to
  the Clinical Team. Consent records and another rep's revenue are invisible.
- `DELETE` fails for every role via missing privilege, and for the owner via
  the `block_hard_delete` trigger.
- `referral_fee`, `commission_amount`, `incentive_rate` and a `payout_ledger`
  table are all rejected at DDL time; an innocuous column still succeeds.
- An executive cannot resolve an attribution conflict, enter revenue, log a
  visit against another rep's doctor, or assign a doctor to themselves.
- `status='lost'` without a reason, a duplicate normalised mobile, and
  overlapping ownership of one doctor are all rejected by constraints.

Run it with `./rebuild.sh`.

## Bugs found and fixed during verification

1. **SQL-language function bodies are validated at `CREATE` time**, so the
   authorisation helpers could not precede the tables they read. They moved
   from `001` to the top of `002`.
2. **`crm.audit_row()` assumed every table has an `id` column.**
   `crm.user_hospitals` is keyed on a composite PK, so every insert into it
   failed on a NOT NULL violation. The function now resolves whatever the
   primary key actually is, from `pg_index`.
3. **`crm.v_doctor_kpis` fanned out into a cartesian product.** Joining both
   referrals and revenue to `crm.doctors` in one pass meant a doctor with 4
   referrals and 3 revenue rows reported 12 referrals and triple the revenue.
   Rewritten with separate aggregate CTEs; there is now a regression test with
   3 referrals and 2 revenue rows asserting 3 and ₹90,000.
4. **Conversion rate returned NULL instead of 0.0** for a doctor with
   referrals but no conversions, because of a `nullif` on the numerator.
5. The attribution-conflict constraint as first drafted was a tautology and
   enforced nothing. It now requires a resolver and a reason whenever a claim
   is rejected.

## Two things you should know before this goes to Supabase

### 1. FORCE ROW LEVEL SECURITY does not stop a BYPASSRLS role

`FORCE` subjects the table *owner* to policies, but a superuser — or any role
with `rolbypassrls`, **which Supabase grants to `postgres`** — ignores RLS
entirely. Scribe's pool (`server/config/db.js:15`) connects on `DATABASE_URL`,
almost certainly as that role.

So `FORCE` is not the control. **The control is that every CRM request runs
`SET LOCAL ROLE crm_app` first.** That has to be a single mandatory middleware,
not a per-route convention. `crm.assert_app_role()` throws if a query arrives
without it, and should be called at the top of the CRM request path.

This is the one place where the brief's "enforced via RLS, not frontend logic"
depends on a line of application code being correct. I'd rather say that
plainly than let it read as stronger than it is.

### 2. The event trigger may not be creatable on Supabase

`CREATE EVENT TRIGGER` requires superuser in stock PostgreSQL. It worked
locally because the container's `postgres` is a superuser; Supabase's is not,
and whether they permit it is untested. If `002` fails at that statement:
drop the event trigger from the migration and wire `ci_compliance_check.sh`
into CI instead. I verified the fallback catches both a `referral_fee` column
and a `doctor_payout_ledger` table with the trigger disabled, exiting 1.

### 3. Bootstrap ordering

`crm.users` and `crm.user_hospitals` are intentionally **not** `FORCE`d, which
is what lets the first admin be inserted before any user exists to satisfy a
policy. Seeding runs as the migration role. Worth knowing if you ever tighten
those two tables.

## Decisions confirmed

1. Keep the FK `crm.users.scribe_doctor_id → public.doctors(id)`. Adding an FK
   does not alter the Scribe table.
2. Doctor mobile unique per `(hospital_id, mobile_e164)`.
3. `revenue_records` ops-entered in Phase 1 with `is_manual`; the
   `scribe_billing` path is modelled and unused until Phase 2.
4. `Admission` / `Procedure` tables deferred — journey statuses cover Phase 1.
5. `crm.patient_referral_sources` side-table; no Scribe table altered.
6. Cadence: A/B 15 days, C 45, unclassified 60.

## Added to Phase 1 scope

**Scribe registration must ask "who referred you?" as a mandatory field**
(doctor picker + free text + none/self), writing one
`crm.patient_referral_sources` row per patient. Per brief §6 rule 1 this is the
primary attribution source, and verified attribution is the number the
dashboards count — without it every referral stays "claimed" and the revenue
figures are unusable. Implementation lands after this migration is approved.

## What is NOT verified on production, and why

`verify_rls.sh` proves *behaviour* — a Growth Executive sees 1 of 3 doctors —
which requires fixture rows, including rows in `public.patients`. Running it
against production would insert fake patients into the live clinical database,
so it does not run there. It runs on scratch (both PG versions) and in CI.

`verify_supabase.sh` is the production counterpart: read-only, no fixtures, and
it proves the structural and negative guarantees that hold with no data —
including that `crm_app` is refused on the real patients table.

To prove behaviour on Supabase infrastructure specifically, the clean route is
a Supabase branch (a throwaway copy), where the full suite can seed freely.

## Guards added alongside the schema

| Guard | Where | Fails when |
|---|---|---|
| Role switch | `server/crm/checkNoDirectPool.mjs` | any file under `server/crm/` reaches the DB outside `withCrmContext` |
| Boot assertion | `server/crm/assertCrmIsolation.js` | crm_app missing, RLS off a table, a stray GRANT on `public`, DELETE granted |
| In-transaction | `crm.assert_app_role()` | a CRM query arrives without the role switch |
| Compliance | `ci_compliance_check.sh` | a payment-shaped column or table exists in `crm` |
| CI | `.github/workflows/crm-guards.yml` | any of the above, on every commit, against PG 17 and 15 |
