# End-to-end tests

Playwright tests that drive the real API and the real browser pages against a
**local test database**. They never touch production.

## Safety

- `.env` points at production. The tests never use it.
- Every database connection goes through `setup/guard.mjs`, which only allows
  `postgres://…@localhost:5435/gini_scribe_test` (or `127.0.0.1`). Anything
  else stops the run with
  `E2E refused: DATABASE_URL is not the local test database`.
- The test API is started with every key from `.env` blanked and the values
  in `e2e/.env.e2e` applied, so no production credential reaches it.
- `setup/blockNetwork.mjs` is loaded into the test API. Any connection to a
  host other than localhost is refused and written to
  `e2e/.artifacts/outbound-calls.log`; a test fails if that log is not empty.

## One-time setup

1. Docker must be running.
2. `npm install`
3. Playwright uses the installed Google Chrome (`channel: "chrome"`). To use
   another browser, set `E2E_BROWSER_CHANNEL` (e.g. `chromium` after
   `npx playwright install chromium`) or `E2E_CHROME_PATH`.
4. Build the test database:

   ```bash
   npm run test:e2e:setup
   ```

   This starts the `postgres` service from `docker-compose.yml` (Postgres 17,
   port 5435), recreates `gini_scribe_test`, and builds it from:
   - `setup/init.sql` — Supabase roles, `auth` helpers, extensions;
   - `setup/schema-baseline.sql` — production's `public` schema, structure
     only, no rows;
   - every file in `server/migrations/` except those listed in
     `setup/baseline-migrations.txt` (old, already-applied migrations that
     can't be replayed). Migrations already in production are no-ops;
     migrations not yet deployed are applied.

   It then saves the reference rows the migrations insert (flow steps, test
   catalogue…) and loads the fixtures.

Re-run `npm run test:e2e:setup` after adding a migration.

## Running

```bash
npm run test:e2e                                   # everything
npm run test:e2e -- e2e/setup/guard.spec.js        # one file
npm run test:e2e:billing                           # the billing suite
E2E_REBUILD=1 npm run test:e2e                     # rebuild the schema first
```

Playwright starts its own API on port **3101** and Vite on port **3100**, so it
does not clash with `npm run dev` on 3000/3001. Before the tests run, the
database is reset: every table is emptied, the reference rows are restored, and
the fixtures are inserted.

## Fixtures

`fixtures/data.mjs` — test-only data, PIN `4321` for every user:

| Kind        | Rows                                                                |
| ----------- | ------------------------------------------------------------------- |
| Users       | admin, reception_admin, reception, coordinator, lab                 |
| Consultants | Dr E2E Banshali, Dr E2E Rahul, Dr E2E Beant                         |
| Patients    | General adult, Senior 72, CGHS Paid, CGHS Referral, Pensioner       |
| Tests       | HbA1c, Lipid Profile, Fasting Blood Sugar (lab); ABI, VPT (machine) |

## Helpers

| Helper                | Use                                                      |
| --------------------- | -------------------------------------------------------- |
| `apiAs(role)`         | an API client signed in as that fixture user             |
| `anonymousApi()`      | an API client with no login                              |
| `loginAs(page, role)` | opens browser pages already signed in                    |
| `db.query / one`      | guarded queries against the test database                |
| `builders.*`          | create rows in one line (`buildPatient`, `insertRow`, …) |
| `money.expectRupees`  | compare amounts in paise                                 |

## Writing a test for a task

Each billing task names its spec file, e.g.
`e2e/billing/phase1/P1-17-service-items-service.spec.js`. Write the test,
run it, fix until it passes, then run `npm run test:e2e:billing` so nothing
else broke. See `docs/gini-flow/52-BILLING-TASKS.md` → "Definition of done".

## When a test fails

- The list output shows the failing step and values.
- Traces and screenshots are kept in `e2e/.artifacts/results/`. Open a trace
  with `npx playwright show-trace <path>/trace.zip`.
- The HTML report is in `e2e/.artifacts/report/`
  (`npx playwright show-report e2e/.artifacts/report`).

## Refreshing the production baseline

Only when production's schema has changed outside the repo's migrations. Ask
before doing this: it reads production (structure only).

```bash
docker run --rm --network host -e DUMP_URL="<session-pooler URL, port 5432>" postgres:17-alpine \
  sh -c 'pg_dump "$DUMP_URL" --schema-only --schema=public --no-owner --no-privileges' \
  | grep -v '^--' | sed 's/^CREATE SCHEMA public;$/CREATE SCHEMA IF NOT EXISTS public;/' \
  | grep -v '^\\\(un\)\?restrict ' | cat -s > e2e/setup/schema-baseline.sql
```

Then run `npm run test:e2e:setup` and the whole suite.
