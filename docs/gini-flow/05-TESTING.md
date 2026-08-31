# Testing the Flow Manager

How to open the board, what to check on it, and what "real data" can and cannot mean today.

---

## The short answer on real data

**The board cannot show real patients yet, and that is by design.**

Gini Flow has no check-in screen, and per `00-OVERVIEW.md` §2.3 it deliberately does not read the
old `flow_*` module. So nothing writes `giniflow_visits` except the demo seeder. A patient who walks
into the hospital today appears on `/flow/coordinator` (the old board) and **not** on
`/giniflow/manager`.

Three ways to test, in increasing order of realism:

| #   | Approach                                                                     | Real patients?                          | Real timings?              | Effort                        |
| --- | ---------------------------------------------------------------------------- | --------------------------------------- | -------------------------- | ----------------------------- |
| 1   | Demo seeder                                                                  | No — creates its own `ZZDEMO_` patients | Yes, backdated but genuine | 2 minutes                     |
| 2   | Backfill today's appointments into `giniflow_visits`, drive statuses by hand | Yes                                     | Yes                        | ~1 hour, one-off script       |
| 3   | Build the check-in station                                                   | Yes                                     | Yes                        | The next phase of the project |

Option 1 is what to use for UI work. Option 2 is what to use before showing it to the coordinator.

---

## 1. Open the board

```bash
npm install && (cd server && npm install)   # first time only
npm run dev                                 # Vite :3000 + API :3001
```

Log in as **admin** or **coordinator**, then click **🕐 Gini Flow** in the left nav, or go straight
to <http://localhost:3000/giniflow/manager>.

Roles that can see the board: `admin`, `coordinator`, `consultant`, `mo`, `nurse`, `lab`,
`reception`, `pharmacy`. Only `admin` and `coordinator` can save time budgets — other roles get the
drawer read-only.

If the page is blank or you get a 403, check the role on your `doctors` row:

```bash
cd server && node scripts/audit-doctor-roles.mjs
```

---

## 2. Seed the demo day (option 1)

The seeder makes its own patients (`Demo Nishant Puri`, file numbers `ZZDEMO_001`…) so no real
patient ever gets a fabricated category or blood pressure. It is off by default.

**Step 1 — enable it.** Add to the repo-root `.env`:

```
GINIFLOW_ALLOW_DEMO=1
```

Restart the API. Without this both endpoints return
`403 Demo endpoints are disabled. Set GINIFLOW_ALLOW_DEMO=1.`

**Step 2 — seed.** There is no button in the UI; call the endpoint. Copy your token from the
browser (DevTools → Application → Local Storage → the auth token) and:

```bash
curl -X POST http://localhost:3001/api/giniflow/demo/seed \
  -H "x-auth-token: <your admin token>"
# -> {"visits":22,"events":178,"labOrders":3}
```

**Step 3 — refresh the board.** You should see ~22 patients across the eight columns, a red
bottleneck banner on "Waiting — doctor", two blocked cards and three on the Lab track.

**Step 4 — clean up when done:**

```bash
curl -X POST http://localhost:3001/api/giniflow/demo/clean \
  -H "x-auth-token: <your admin token>"
```

Clean deletes only rows with `is_demo = TRUE` and the `ZZDEMO_` patients. It cannot touch a real
visit.

> **Turn `GINIFLOW_ALLOW_DEMO` back off before deploying.** `DATABASE_URL` is production — the
> seeder writes there like everything else.

---

## 3. What to check on the screen

Work down this list with the prototype (`docs/gini-flow-manager.html`) open in another tab at the
same window size. Known-failing items are marked with their audit ID from `03-AUDIT.md`.

### Rail

- [ ] "Gini Flow" renders in Instrument Serif italic, not a fallback serif
- [ ] The clock and all timers render in JetBrains Mono, not the system monospace
- [ ] The green live dot pulses; the date reads today
- [ ] **Day report** shows a one-line toast with an average and a bottleneck
- [ ] **Time budgets** opens the drawer

### Stats strip

- [ ] "In building now" matches the number of cards outside the Done column
- [ ] "of N booked" is a plausible number for this clinic, not the whole hospital's list _(GF-10)_
- [ ] "Completed" matches the Done column count
- [ ] "Avg journey today" (dark tile) shows minutes against the 90m target
- [ ] "Over time budget" matches the count of red timer chips on screen

### Columns and cards

- [ ] Eight columns in order: Checked in · At vitals · With SD/MO · Waiting — doctor · With doctor ·
      At pharmacy · Lab track · Done today
- [ ] Column counts add up to what is on screen (lab-track patients appear twice, once in their
      chain column — this is intentional, see _GF-20_)
- [ ] The "Waiting — doctor" column is pink/hot with "avg now Nm ⚠" in its sub-line
- [ ] Each card shows: initials avatar, name, category dot, `48M · P_67120 · Visit 8`, a subtitle,
      a timer chip, and total minutes
- [ ] Timer chips are green under 80% of budget, amber 80–100%, red over
- [ ] Blocked cards show the red 🚫 strip
- [ ] Empty columns show a muted "—"

### Live behaviour — the point of the whole screen

- [ ] Timers advance every second without the board flickering
- [ ] Leave the tab in the background for 10 minutes, come back: times are **correct immediately**,
      not 10 minutes behind
- [ ] Change your laptop's clock forward an hour: timers stay correct (they use server time)
- [ ] Stop the API (`Ctrl-C` on `npm run dev:server`): the board keeps the last data and the rail
      says "Reconnecting…" rather than going blank _(it is very subtle — GF-23)_
- [ ] Restart the API: the board recovers within 10 seconds with no reload

### Time-budgets drawer

- [ ] All 10 rows, "Total journey target" emphasised in teal
- [ ] Change "Wait for doctor" from 15 to 45 → Save → that column stops being hot and every card in
      it recolours, with **no page reload**
- [ ] Set it back to 15
- [ ] Log in as a `nurse`: the drawer opens read-only with no Save button

### Timeline modal

- [ ] Click any card → modal opens with the patient's name and `41F · P_42220 · Visit 5`
- [ ] Every status the patient passed through appears once, in order
- [ ] Durations read "8m wait + 12m station" and are coloured against budget
- [ ] Over-budget steps spell out the overage
- [ ] Closes on ✕ and on clicking the backdrop _(Escape does not work — GF-16)_
- [ ] Future steps are **not** shown yet _(GF-14)_

### Station performance footer

- [ ] One tile per budget with actual vs. budget and a coloured bar
- [ ] The last three tiles — Lab, Reception payment, Total journey — currently show "—" _(GF-07)_

---

## 4. Testing with real patients (option 2)

This is the honest way to see the board with real names and real waits, without building the
check-in station. It is a one-off script you write once and keep in `server/scripts/`.

**What it does:** creates one `giniflow_visits` row per real appointment today, then lets you
advance a patient's status from the command line as they physically move through the floor.

**Step 1 — create today's visits from today's appointments.** The appointments table is already
synced from HealthRay, so this is real booking data:

```sql
INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, appointment_time, current_status)
SELECT a.patient_id,
       (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
       a.id,
       a.time_slot::time,
       'booked'
  FROM appointments a
 WHERE a.appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
   AND a.status NOT IN ('cancelled', 'no_show')
   AND NOT EXISTS (SELECT 1 FROM patients bp WHERE bp.id = a.patient_id AND bp.is_blocked)
ON CONFLICT (patient_id, visit_date) DO NOTHING;
```

Leave `is_demo` at its default `FALSE` — these are real visits, and you do **not** want
`demo/clean` deleting them.

**Step 2 — advance a patient as they move.** Use the engine, never a raw `UPDATE` — it writes the
event log every timer depends on:

```js
// server/scripts/giniflow-advance.mjs  <visitId> <status>
import "../loadEnv.js";
import pool from "../config/db.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";

const [visitId, toStatus] = process.argv.slice(2);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  console.log(await advanceStatus(client, { visitId, toStatus, actorRole: "reception" }));
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
```

The chain, in order:
`booked → confirmed → checked_in → vitals_pending → with_vitals → vitals_done → sd_pending →
with_sd → ready_for_doctor → with_doctor → doctor_done → pharmacy_pending → dispensed → exited`

**Step 3 — watch the board.** Advance a real patient to `checked_in` and they appear in the first
column within 10 seconds, with a timer that is genuinely counting from the moment you ran the
command.

**Cleaning up real test visits** — `demo/clean` will not touch them, so delete them explicitly:

```sql
DELETE FROM giniflow_visits
 WHERE visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND NOT is_demo;
```

⚠️ Run that only while you are certain nothing real depends on those rows. Events cascade with them
and there is no staging copy of this database.

---

## 5. Comparing against the old board

During the parallel run both boards are live and **they will disagree**, because they read different
tables. That is expected — tell the coordinator before the first demo.

|        | Old                 | New                            |
| ------ | ------------------- | ------------------------------ |
| URL    | `/flow/coordinator` | `/giniflow/manager`            |
| Tables | `flow_*`            | `giniflow_*`                   |
| Fed by | Real check-in       | Demo seeder, or option 2 above |

Nothing Gini Flow does may change a `flow_*` row. `npm run smoke:giniflow` asserts this — it fails
if `flow_visits` or `flow_events` counts move during a run.

---

## 6. Automated checks

Run from `server/`:

```bash
npm run smoke:giniflow        # 46 checks: seeds, verifies the board, cleans up
npm run smoke:giniflow-http   # 9 checks: the capability gate and request validation (API must be up)
node scripts/verify-giniflow-schema.mjs   # tables, budgets, constraint, IST vs UTC date
node scripts/verify-rbac.mjs              # the whole permission matrix
npm run format:check          # from the repo root
```

`smoke:giniflow` needs `GINIFLOW_ALLOW_DEMO=1` because it seeds. It restores the SLA budgets it
touches and deletes only its own rows.

---

## 7. Known issues you will hit

Not bugs to report — already logged in `03-AUDIT.md`, fixes tracked in `04-ACTION-ITEMS.md`.

| What you will see                                                    | ID    |
| -------------------------------------------------------------------- | ----- |
| The last three footer tiles show "—" and an empty bar                | GF-07 |
| A card can read "95m total" without turning red for up to 10 seconds | GF-09 |
| The timeline has no future/projected steps                           | GF-14 |
| Escape does not close the modal or drawer                            | GF-16 |
| The stale/reconnecting state is easy to miss                         | GF-23 |
| The timeline modal does not refresh while open                       | GF-24 |
| A lab-track card can show a hint from the patient's main journey     | GF-19 |
| The board has no responsive rules — expect overflow below ~1400px    | GF-17 |
