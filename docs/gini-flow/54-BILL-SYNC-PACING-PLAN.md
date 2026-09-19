# 54 — Keep the HealthRay bill sync on without getting blocked, and without losing or changing data

Status: **W1–W6 BUILT on local, 19 Sep 2026; not deployed, not all committed.** W1 bill-read
breaker, W2 shared 15 s slot, W3 tiered queue, W4 audited not-on-bill cancel, W5 paid-order
repricing (default `dry`) plus the "Bill differs" card, W6 badge plus confirmation. W7: `.env` has
`SCRIBE_MACHINE_CASE_LIST=1` again; `SCRIBE_BILL_AUTO_CANCEL` acts (no dry day, by request);
`SCRIBE_BILL_AUTO_REPRICE` stays `dry`. On 19 Sep at 11:48 a bill-read 403 paused bill reads only,
and appointments kept syncing: D1 held on the live floor.

## 1. What was asked

> I want billing syncing working, because the real tests are only mentioned there. The patient's
> journey must have the correct steps, no extra test. No data lost, nothing duplicated, no data
> changed — it's the rules.

## 2. What happened today (19 Sep 2026)

### The outage

| IST          | Event                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18 Sep 17:19 | Last appointment written from HealthRay. Nothing more until the next morning.                                                                                                                 |
| ~10:03       | Block #5 on the shared breaker (`healthray_login_cooldown`), 2 h. **0 of 41** of today's appointments from HealthRay.                                                                         |
| 10:20        | Breaker reset. Worker restarts; its machine sync reads bills; **403 on `get_transactions`** → block again.                                                                                    |
| 10:32        | Walking sync writes 24 HealthRay appointments (P_181814 merges onto GNI-00086). **403 on `get_transactions`** → block.                                                                        |
| 11:04, 11:13 | Two more blocks, both **`get_transactions`**, each within minutes of the pause ending.                                                                                                        |
| ~11:17       | Bill reads switched off (`SCRIBE_MACHINE_CASE_LIST=0`). Login, doctor lists and appointment lists keep working.                                                                               |
| 11:18        | Blocked again on `get_transactions`, **not** by the worker (bill reads off, no `BLOCKED` in its log): another bill reader, the local API or production. 36 HealthRay appointments in by then. |

Every block after the first came from the **bill endpoint**. A one-off login from the same machine
returned 200 each time. Twice the `HEALTHRAY_SYNC` advisory lock was stranded on a pooled backend by
a stopped worker and had to be freed with `pg_terminate_backend` (see §7).

Because the block flag is shared, **one 403 on a bill read stopped the whole HealthRay sync**: no
walk-ins, no new patients. That is why reception could not find P_181814.

### Why the bill reads trip HealthRay

- `runMachineSync` scans **12 visits per run, every 90 s** (`SCRIBE_MACHINE_SCAN_BATCH`,
  `machineSync.js:28`). The only pacing is the global limiter, **2 req/s**, 1 concurrent
  (`healthray/client.js:20`). So HealthRay sees ~12 `get_transactions` calls in ~6 s, every 90 s.
- Every visit on the floor is eligible: re-read every **20 min** until a bill is seen
  (`SCRIBE_MACHINE_RESCAN_MIN`), then every **60 min**, or **15 min** while a refundable test is open
  (53 D9). Patients with no tests are read as often as patients with tests.
- A 403 on any endpoint calls `tripBlock` (`healthray/client.js:113-126`), which writes the one shared
  breaker every HealthRay caller obeys, worker and API alike.

### Other bill readers (each reads one patient, on a person's action or a status change)

| Reader                         | Where                                                                  | Cached?                                            |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Reception check-in bill panel  | `giniflowStations.js:997` → `healthrayBillSteps`                       | yes (`readPatientBill`)                            |
| Bill sync right after check-in | `giniflowStations.js:1264` (gated by `SCRIBE_MACHINE_CASE_LIST`)       | yes                                                |
| Prescription-step recheck      | `appointmentSync.js:562` (API **and** worker, max 2 in flight, hourly) | yes                                                |
| Legacy flow check-in           | `routes/flow.js:3601`                                                  | **no** — calls `fetchPatientTransactions` directly |

### What the data looked like for one patient (Mukesh Bhatra, P_181814)

| Item                         | HealthRay bill OPD/2627-14455 (10:50) | Scribe                                                                                                         |
| ---------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ABI + VPT + Fundus           | one line `ABI,VPT,Fundus` ₹800        | three orders from the check-in template, **₹500 each paid** at 09:31; ABI and VPT reported, Fundus not started |
| Microalbumin/Creatinine      | ₹500                                  | **missing** (bill never read)                                                                                  |
| Blood Sample, Lab Processing | —                                     | template steps pending, no order behind them                                                                   |
| Total                        | ₹1,300 paid, ₹200 refunded            | ₹1,500 cleared                                                                                                 |

Same `ABI,VPT,Fundus ₹800` pattern as P_181807 on 18 Sep, fixed by a one-off script
(`fix-p181807-combined-line-price.mjs`). `priceOrdersFromBill` only reprices **unpaid** orders, so
a test reception has already cleared keeps the catalogue price.

## 3. The rules this plan is held to

1. **No loss.** No order, step, payment, report or audit row disappears without a record of what
   it was and why. A started, reported or paid test is never removed by the sync. A test is never
   dropped because its bill was not read.
2. **No duplicates.** No second order for a test the visit already has, whatever its status.
3. **No data changed unless it is proven correct.** The HealthRay bill is the proof: test prices
   and paid amounts follow it (decided 19 Sep, §9), but only from a fresh `billed` read, only for a
   plain full payment, and always with an audit row holding the old value. A blocked or failed read
   is never treated as "the bill is empty", and never changes a price.

§6 checks every design item against these three.

## 4. Design

### D1 — A bill-read block stops bill reads, not the whole sync

- New breaker in `app_kv`, **`healthray_bill_cooldown`**, same shape and escalation as the main one
  (30 min → 1 h → 2 h, reset on the first successful bill read).
- In `gatedFetch`, a WAF page (403 non-JSON or 429) on **`/appointment/get_transactions`** trips
  the bill breaker only. A WAF page on any other endpoint trips the main breaker exactly as today.
- Every bill reader checks both breakers: `readPatientBill`, `canReadBill`, `syncBillingForVisitId`,
  `runMachineSync`, `healthrayBillSteps`. While the bill breaker is open they return the **stored**
  bill, or `unknown` when there is none. That is the current behaviour of `readPatientBill` on a
  fetch error, so nothing downstream changes: every action on a bill already requires
  `status === "billed"`.
- Log line: `⚠ Bill reads paused by HealthRay (http=403) — appointments keep syncing`.

Result: a bad minute on the bill endpoint can no longer hide walk-ins from reception.

### D2 — One bill read at a time, spaced, across both processes

- A shared slot in `app_kv`, **`healthray_bill_last_read_at`**, taken with one atomic statement:
  `UPDATE app_kv SET value = now WHERE key = … AND value < now - gap RETURNING …`. No row back
  means "not yet": the caller doesn't read this time. The worker and the API share the one gap, so
  two processes can't double the rate.
- Gap `HEALTHRAY_BILL_MIN_GAP_MS`, default **15 000** (4 reads/min, 240/h), set in `.env`.
- **Scheduled reads** (the machine sync) take a slot per visit and **end the run** when none is
  free. The next run continues from the same queue (D3). Nothing waits in a loop.
- **Interactive reads** (reception opening the check-in bill panel, the post-check-in read) wait up
  to one gap for a slot. If none comes, they return the stored bill and the panel shows
  "HealthRay bill still loading". These are the reads a person is waiting on, so they go first.
- The legacy `routes/flow.js:3601` read stays a direct `fetchPatientTransactions` call (it needs the
  raw per-appointment rows, not the day's stored bill). The slot and the breaker live in
  `gatedFetch`, so it is spaced and breaker-checked like the rest; it is just not cached.
- `SCRIBE_MACHINE_SCAN_BATCH` stays as an upper bound. The gap is what actually limits the rate.

### D3 — Read the bills that matter first; never skip a patient on the floor

The eligible set stays as it is today: every visit on the floor, until exit (51 D5,
`SCRIBE_MACHINE_EXIT_GRACE_MIN` = 0). Only the **order** and the **interval** change:

| Tier | Visit                                                                                             | Re-read every                                   |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A    | Has pending test steps from the check-in template or added by reception, and no `billed` bill yet | 5 min (`SCRIBE_BILL_TESTS_RESCAN_MIN`)          |
| B    | Checked in, no `billed` bill yet, no test steps                                                   | 20 min (unchanged, `SCRIBE_MACHINE_RESCAN_MIN`) |
| C    | `billed`, with a refundable test still open (53 D9)                                               | 15 min (unchanged)                              |
| D    | Everyone else still on the floor, `billed` or not                                                 | 60 min (unchanged)                              |

Within a run: tier, then oldest `machine_scan_at` first. Tier D is **never dropped**. When the floor
is busy it is read later, not skipped. That matters because the Chief can bill an ABI or a lab
panel at 2 pm for a patient who arrived with no tests, and D is how that test reaches the floor.

The sync log gains one line per run: `bill reads: N done, tier A x · B y · C z · D w waiting`. If D
keeps waiting past 90 min at peak, the gap (D2) is too wide or the batch too small. That is a
tuning signal, not a silent loss.

Capacity at a normal peak (~90 visits, ~20 in A/B at once): A ≈ 12 × 12/h, B ≈ 8 × 3/h, C+D ≈
90/h. That's close to the 240/h a 15 s gap allows, so the tier order is what keeps A and B on time.

### D4 — An extra test is cancelled with a record, never deleted

Today `reconcileTestSteps` (`patientBill.js:309`) **`DELETE`s** a check-in test order, and its
journey step, when the bill is `billed` and the test is absent from it, provided it is unpaid, not
started and from check-in. The row is gone; nothing says why.

Change: the same selection, but each order goes through **`cancelTestIn`** (53 D1/D2) with:

- reason **`not_on_bill`** (new, in `shared/testCancelReasons.js`), source `healthray`, actor `system`;
- refund amount 0, since nothing was paid (the selection already requires it).

`cancelTestIn` writes the full snapshot to **`giniflow_test_cancellations`** (tests, prices,
payment trail, reason) and a `giniflow_visit_events` row, then removes the live order and its
pending step (`tidyMachineStep` / `tidyLabSteps`, `testCancel.js:172-210`). That is the 53 D1
contract: off the live journey and the station, kept in the record, undoable from it. So "why did
ABI disappear" always has an answer, which today's `DELETE` does not give.

Steps with **no order behind them** (Blood Sample, Lab Processing on a journey with no lab order
and no lab line) have nothing to snapshot. They are set to **`skipped`** (an allowed status,
`2026-09-08_giniflow_journey.sql:41`), with a visit event carrying the reason, not deleted. To
check while building: `journeyProgress` and the reception journey panel must count `skipped` as
not remaining and render it as "skipped — not on HealthRay bill".

Removal only ever runs on a bill read that returned `billed` in this call, or within the freshness
window. Never on `unknown` or on a stored copy kept because a read failed (D1).

**Found while building (19 Sep):** `billSuppressor` treats any cancellation with no bill line as
"never raise this test again on this visit" (`testCancel.js:75`). A `not_on_bill` cancel has no
line by definition, so a test billed later in the day (the Chief adds ABI at 2 pm) would never
reach the floor: a loss. The suppressor now ignores `not_on_bill` rows. Staff cancellations
(`billed_by_mistake` and the rest) still suppress as 53 designed.

Behind the existing switch **`SCRIBE_BILL_AUTO_CANCEL`**: `dry` logs `would cancel …` and changes
nothing; `1` acts. Go-live runs in `dry` first (§8).

### D5 — Paid amounts follow the HealthRay bill automatically

Decided 19 Sep (§9 Q2): the bill is the money record, so the sync corrects paid orders to it, the
way `fix-p181807-combined-line-price.mjs` did by hand. Today `priceOrdersFromBill`
(`patientBill.js:268`) reprices **unpaid** orders only. It gains a second pass for **paid** orders.

**When it acts.** All of these must hold, per order, or the order is left alone:

- the bill came from a read in this call or within the freshness window, with status `billed`
  (never `unknown`, never a stored copy kept because a read failed, D1);
- the order is a **plain full payment**: `payment_status = 'paid'`, `amount_paid = amount_total`,
  every test's `price` sums to `amount_total`, `claim_state = 'none'`, `amount_claimed = 0`;
- every test on the order maps to **one live** bill line (`billLineFor`, `patientBill.js:238`),
  with no refund on it: a line with `refunded > 0` belongs to 53 D7b, never to this pass;
- the HealthRay invoice holding that line is **fully paid**. To confirm while building: which field
  of the `get_transactions` payload says so (the printed bill shows it as "NET PAYABLE 0"). Until
  that field is confirmed, the pass stays in `dry` (below). **Found 19 Sep:** it is the
  transaction's `due_amount` (already read by `transactionsToBilling` for the bill's Paid/Due). It's
  now carried onto every line as `invoiceDue`, with the transaction's `refunded_amount` as
  `invoiceRefunded`. An invoice with **any** refund is refused: a part refund on the invoice cannot
  say which line it belongs to (Mukesh's bill has ₹200 refunded on OPD/2627-14455, so his goes to
  "Bill differs").

**What it writes**, in the sync's transaction, under the visit's `FOR UPDATE` lock:

- each test's `price` → its share of the line (`amountOf`, the split `billedMachineLines` already
  computes for a combined line; the line amount for a single-test line);
- the order's `amount_total` and `amount_paid` → the new sum, `version + 1`, with the same
  `WHERE version = …` check the P_181807 script used;
- one **`writeAudit`** row per order (`services/billing/audit.js`): before and after for each test
  and both amounts, and the reason `Repriced to HealthRay bill <invoice>: "<line>" ₹<amount>`;
- one `giniflow_lab_order_events` row, `track = 'payment'`, `status = 'repriced'`, so the order's
  own history shows it next to the original payment.

Idempotent: once the amounts match the bill, the next read finds nothing to change.

**What it never does:** create or remove an order, touch a started or reported test's clinical
status, or act on insurance or part-paid orders.

**Switch:** `SCRIBE_BILL_AUTO_REPRICE` = `dry` (logs `would reprice ABI ₹500 → ₹266.67 …`, writes
nothing) | `1` (acts) | `0` (off). Go-live runs `dry` first (§8).

**Anything it refuses** (claim, part-paid, part-refunded line, invoice not fully paid) shows up on
the Payments tab's "Refunds to check" (53 D8) as a **Bill differs** card for reception:

> **Bill differs** — HealthRay `ABI,VPT,Fundus` ₹800 · Scribe cleared ₹1,500 (ABI ₹500, VPT ₹500,
> Fundus ₹500) · not corrected: insurance claim open

Computed when the queue is read (no table, like 53 D8). It goes when the amounts agree or the visit
exits.

Mukesh Bhatra (P_181814) is exactly this case. Once D5 is live and his bill is read, ABI, VPT and
Fundus go from ₹1,500 to the ₹800 line split across the three, with an audit row each. The
Microalbumin line raises its lab order through the existing bill sync.

### D6 — Ask before clearing payment for a test that is not on the bill

Decided 19 Sep (§9 Q3). On the Payments tab, a test order whose test is not on the stored `billed`
bill carries the badge **"Not on HealthRay bill yet"**. Pressing **Clear payment** on it opens an
in-app confirmation (never a browser `confirm()`):

> **ABI is not on the HealthRay bill yet.** Clear ₹500 anyway? [Go back] [Clear anyway]

If the bill hasn't been read at all (`unknown`, or D1 has paused bill reads), the wording is
"HealthRay bill not read yet" instead.

The service enforces it too, so a stale tab can't skip the question: `clearPayment`
(`receptionStation.js:419`) refuses with **409** `not_on_bill` unless the request carries
`confirmNotOnBill: true`. The Zod schema gains that optional flag. A confirmed clearance writes the
flag into the payment event's `meta`, so "cleared although not on the bill" can be found later.

Tests on the bill clear exactly as today, with one tap. The settled rule (payment before tests) is
unchanged. This is the question that would have stopped Mukesh's 09:31 clearance of three template
tests before HealthRay had billed them.

## 5. Work items

| #   | Item                                                                                                                                              | Touches data?                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| W1  | `healthray_bill_cooldown` breaker; `gatedFetch` routes `get_transactions` WAF pages to it; bill readers check both breakers (D1)                  | no                                                     |
| W2  | Shared bill-read slot + `HEALTHRAY_BILL_MIN_GAP_MS`; scheduled vs interactive behaviour; `flow.js:3601` via `readPatientBill` (D2)                | no                                                     |
| W3  | Tiered `scanTargets` + the per-run log line (D3)                                                                                                  | no                                                     |
| W4  | `reconcileTestSteps` → `cancelTestIn` with `not_on_bill`; order-less steps → `skipped`; honours `SCRIBE_BILL_AUTO_CANCEL=dry` (D4)                | yes — replaces a `DELETE` with an audited cancel       |
| W5  | Paid-order repricing pass in `priceOrdersFromBill`, audit + payment event, `SCRIBE_BILL_AUTO_REPRICE`; "Bill differs" card for refused cases (D5) | yes — prices and paid amounts follow the bill, audited |
| W6  | "Not on HealthRay bill yet" badge, in-app confirmation, `clearPayment` 409 without `confirmNotOnBill` (D6)                                        | no — adds a flag to the payment event's `meta`         |
| W7  | `.env` line 73 back to `SCRIBE_MACHINE_CASE_LIST=1`, with `SCRIBE_BILL_AUTO_CANCEL=dry` and `SCRIBE_BILL_AUTO_REPRICE=dry`                        | config                                                 |

Built and checked one at a time, in this order. W1–W3 alone make it safe to turn bill reads back on.

## 6. Rules check

| Item | No loss                                                                                                                                                                            | No duplicates          | No data changed unless proven                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1   | A blocked read returns the stored bill or `unknown`; nothing acts on either                                                                                                        | Unchanged guards       | Nothing written except the breaker row                                                                                     |
| D2   | A run that finds no slot resumes next run from the same queue                                                                                                                      | Unchanged guards       | Nothing written except the slot row                                                                                        |
| D3   | Tier D is read later under load, never dropped; exit rule unchanged                                                                                                                | Unchanged guards       | Same writes as today, just scheduled differently                                                                           |
| D4   | Replaces a hard `DELETE`: a cancel snapshots order, tests and payment trail in `giniflow_test_cancellations` with a reason (53 D1); order-less steps become `skipped`, not deleted | —                      | Acts only on a fresh `billed` read; `dry` first                                                                            |
| D5   | Old prices and amounts kept in the audit row and a `repriced` payment event                                                                                                        | Never creates an order | Only a fresh `billed` read, plain full payment, one live unrefunded line, invoice fully paid; `version` check; `dry` first |
| D6   | —                                                                                                                                                                                  | —                      | Nothing changes without the confirmation; the confirmation is kept in the event's `meta`                                   |

Duplicates, in the existing code, which this plan does not change:

- Each bill sync takes `SELECT … FOR UPDATE` on the visit row (`machineSync.js:189`), so the worker
  and the API can't sync the same visit at once.
- A machine order is raised only if the visit has **no** machine order for that test in any status
  (`alreadyRaised`, `machineSync.js:44`). A lab test likewise (`notYetOrdered`, `:157`), and a
  cancelled test is not re-raised from the same line (53 D7a, `billSuppressor`).
- `mergeBillItems` marks a line removed only when its **invoice was re-read**, so a partial response
  can't make a line look deleted.

## 7. Limits

- **HealthRay's thresholds are unknown.** Evenly spaced reads at 4/min are far gentler than the
  12-in-6-seconds bursts that tripped it today, but that is inference, not a documented limit.
  Start at 15 s, and widen it if the bill breaker trips.
- **The permanent fix is still `HEALTHRAY_PROXY_URL`**: a fixed egress IP HealthRay allowlists.
  The code supports it (`cron/lowPriority.js`); it needs a proxy provisioned and HealthRay's approval.
- **Stranded `HEALTHRAY_SYNC` lock.** Stopping or restarting a worker left the session advisory lock
  on a pooled backend four times on 19 Sep. `withCronXactLock`, which older notes describe, is not in
  the code. **Built 19 Sep, off by default:** `tryAcquireCronLease` (`cron/lowPriority.js`), an
  `app_kv` lease `cron_lease:918273645` with owner and expiry, renewed every 30 s, TTL 2 min, which
  refuses to start while any session holds the old advisory lock. It's wired for the HealthRay
  sync behind `SCRIBE_CRON_LEASE=1`. It stays off until local and production switch **together**:
  appointments are inserted check-then-insert with no unique index on `healthray_id`, so an
  old-code process and a new-code process running at once could insert an appointment twice.
- **Paid-invoice field unconfirmed** (D5). The repricing pass needs the `get_transactions` field that
  says an invoice is fully paid. Until it is found in a real payload, D5 stays `dry`.
- **Every bill reader must honour the switches.** The 11:18 block came from a bill reader outside the
  worker. W1/W2 cover every reader in §2's table, including the prescription recheck in the API.

## 8. Go-live

1. Ship W1–W3. Leave `.env` line 73 at `0` and watch one day's worker log: appointments syncing, no
   main-breaker trips.
2. Set line 73 to `1` with `SCRIBE_BILL_AUTO_CANCEL=dry`. Watch for a day. Check every
   `would cancel … not_on_bill` line against the patient's real HealthRay bill. Any wrong one stops
   the rollout.
3. Ship W4, then set `SCRIBE_BILL_AUTO_CANCEL=1`.
4. Ship W5 with `SCRIBE_BILL_AUTO_REPRICE=dry`. Check every `would reprice` line against the
   printed bill for a day, then set it to `1`.
5. Ship W6.
6. Production (Railway worker **and** API) takes the same env and code. Both run the bill readers.

## 9. Decisions (19 Sep 2026)

- **Q1** Bill-read gap: **15 s** (240/h), `HEALTHRAY_BILL_MIN_GAP_MS=15000`. Widen it if the bill
  breaker trips.
- **Q2** Paid amounts: **automatic, as on the HealthRay bill** (D5), audited, behind
  `SCRIBE_BILL_AUTO_REPRICE` with a `dry` day first. Cases the pass refuses go to reception as "Bill
  differs".
- **Q3** Clearing payment for a test not on the bill: **ask for confirmation** (D6), enforced by the
  service too.
