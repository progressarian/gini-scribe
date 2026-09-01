# Lab Station — full plan

**Sources, read in full:**

- `docs/Flow-Manage/gini-stations.html` → `s-lab` (queue) and `#labPane` (detail pane)
- `docs/gini-flow/Gini-Flow-Developer-Brief.docx` → §2.2 status chain and payment track,
  §2.3 cross-station triggers, §3 `lab_orders` / `lab_order_tests`, §4.5 lab screen
- Phase 2 context: `06-PHASE-2-PLAN.md` §0.4 (results already sync from HealthRay), task 2.5

**Status:** built and running at `/giniflow/station/lab`. This document is the specification it
was built against, what matches, and what is still open — written after the build, because the
first pass shipped without the report upload the whole screen exists for.

---

## 1. What this station is for

The lab is the only **parallel track** in the system. Every other station moves a patient along
one chain; the lab runs beside it and does not block it — except at one point, which is the point
of the screen:

> **Uploading a report flips `visit.results_status` to `'ready'`, which is what turns the patient
> green on the MO and doctor queues.** (Brief §2.3, trigger 1.)

Everything else the station does is bookkeeping so that moment is accurate and timed.

The screen's own banner states the contract to the technician:

> ⚡ **Workflow:** When you upload a report → the patient's status on the MO and SD dashboard
> changes to **"Results ready"** automatically. MO sees it in real time.

## 2. The track

Brief §2.2, lab track:

```
ordered → payment_pending → paid → sample_collected → processing → results_ready → uploaded
```

Alongside it, the payment track: `pending | paid | insurance_claim`.

**The gate, stated in the brief and enforced in the service:**

> Lab cannot collect a sample until paid (or claim approved).

The five buckets the screen groups by:

| Bucket          | Sample statuses                      | Heading                                                    | Timer counts     |
| --------------- | ------------------------------------ | ---------------------------------------------------------- | ---------------- |
| Sample pending  | `ordered`, `payment_pending`, `paid` | ⏳ Sample pending — reception cleared payment, collect now | since order      |
| Collecting      | `sample_collected`                   | 🧪 Collected — sample taken                                | since collection |
| Processing      | `processing`                         | ⚙️ Processing — samples in analyzer                        | in analyzer      |
| Ready to upload | `results_ready`                      | ✅ Results ready — upload now to notify MO                 | results waiting  |
| Uploaded        | `uploaded`                           | 📤 Uploaded today — MO notified                            | uploaded         |

## 3. Screen design

### 3.1 Rail

`.rail` navy bar: `.rl` **"Lab Station"** · `.rsep` · _"Gini Lab · Thu 27 Aug 2026"_ · right
`.rbtn` **← Stations**.

### 3.2 Counter strip

Five `.stat` tiles, each a count and a sub-label, coloured per bucket:
teal `Sample pending / not yet collected` · blue `Collecting / sample taken` ·
purple `Processing / in analyzer` · amber `Ready to upload / results done` ·
green `Uploaded / MO notified`.

### 3.3 Workflow banner

Teal `--tl-l` / `--tl-b`, ⚡ icon, the sentence in §1.

### 3.4 Patient row (`.pt-card`)

| Element     | Content                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `.pc-av`    | 34px rounded avatar, initials, per-patient colour                                                            |
| `.pc-name`  | name + `.badge.b-ink` file number — **or**, when uploaded, a green `Uploaded 08:34` badge                    |
| `.pc-meta`  | `50M · Ordered by Dr. Beant Sidhu · MO · 08:47`                                                              |
| `.pc-tests` | 🔬 test list · **N tests**                                                                                   |
| `.steps`    | four-step rail: `Payment ✓ › Collect sample › Process › Upload`, each `step-done` / `step-now` / `step-next` |
| `.pc-r`     | action button or status pill, then `.pc-time` and `.pc-tlbl`                                                 |

Status pills: `sp-sample` (blue) · `sp-process` (purple) · `sp-ready` (teal) · `sp-done` (green).

Uploaded rows are dimmed to `opacity: .6`; the bucket shows three and then
**"+ N more uploaded today"** — it is a record, not a worklist.

### 3.5 Detail pane (`#labPane`) — **not yet built**

The prototype's card opens a right-hand slide-over, `.detail-overlay` + `.detail-pane` (560px,
full height, navy `.dp-head`):

- **Head** — patient name in Instrument Serif italic, meta line, `← Back`, status badge.
- **Tests ordered** — one `.test-row` per test: name left, per-test status badge right. The
  prototype shows every test as "Ordered"; per-test results are the obvious extension.
- **Update status** — the action for the current state, with a sentence explaining it
  ("Mark that you have collected the sample from this patient").
- **Upload report — triggers MO notification** — a dashed `.upload-area` drop zone:
  📄 _"Tap to upload lab report PDF"_ · _"PDF · JPG · PNG accepted · Max 10MB"_, plus the teal
  reminder that uploading changes the patient's status on the MO and SD dashboards.
  Shown only for `processing` and `results_ready`.

## 4. Data

Tables (Phase 1 and Phase 2 migrations, all `giniflow_*`):

- `giniflow_lab_orders` — `visit_id`, `ordered_by`, `urgency`, `payment_status`, `amount_total`,
  `sample_status`, `report_file_url`, `uploaded_at`
- `giniflow_lab_order_tests` — `test_name`, `price` (frozen at order time)
- `giniflow_lab_order_events` — append-only: `track` (`sample` | `payment`), `status`,
  `actor_role`, `actor_id`, `occurred_at`

Every timer on the screen is a difference between event rows, never a stored duration.

## 5. Flow, end to end

```
MO orders tests
      │  giniflow_lab_orders (payment_status = pending)
      ▼
RECEPTION  ✓ Payment received ──────────────► payment event + sample event 'paid'
      │                                        (trigger 3 — the lab sees "Collect now")
      ▼
LAB  ✓ Mark sample collected ──► sample_collected
     ⚙️ Start processing ───────► processing
     ✓ Results done ───────────► results_ready
     📤 Upload report ─────────► file to storage, report_file_url set,
                                 sample_status = uploaded,
                                 visit.results_status = 'ready'   ← trigger 1
      ▼
MO / DOCTOR queues show "Results ready"; the board card turns green
```

## 5b. Gaps found on review — implementation, not just documentation

Three things the brief specifies that the build does not do. None is cosmetic.

### 5b.1 Urgency is carried but never acted on — **the queues are wrong**

Brief §2.3, trigger 2:

> Doctor/MO orders tests **with urgency = today** → `lab_order` created with
> `payment_status = pending` → **Reception gets a payment task card**

and trigger 4: _"tests → lab_orders (**by urgency**)"_.

`urgency` is `today | tomorrow | next_visit`. A test ordered today _for next visit_ is still a row
on today's visit, so both `getPaymentQueue` and `getLabQueue` currently show it — reception would
try to collect payment for a test nobody is doing today, and the lab would sit waiting for a
sample that is not coming.

**Fix:** filter both queues to `urgency = 'today'`, and give the other two a home — a "later"
section, or exclusion until the day they are due. Until then the counters overstate the day's work.
This costs nothing today because only the seeder creates orders; it becomes wrong the moment the
MO/SD station ships.

### 5b.2 `amount_total` is never written

The column exists on `giniflow_lab_orders` and the seeder fills it, but reception computes the
total by summing the order's lines and never persists it. An order created by a real MO will carry
`amount_total = 0` while the screen shows ₹3,700.

Two defensible answers, and the plan should pick one:

- **Write it at order time** and treat it as the amount quoted — then reception displays the
  stored figure, not a recomputed one, and a catalogue change can never alter a quoted total.
- **Drop the column** and always sum the lines.

The current state — a column that exists, is displayed by nothing, and disagrees with the screen —
is the one option that is definitely wrong.

### 5b.3 "or claim approved" is not modelled

Brief §2.2: _"Lab cannot collect a sample until paid **(or claim approved)**."_

The build treats `insurance_claim` as cleared the instant reception taps it. But "claim approved"
implies a claim can be _submitted and not yet approved_ — which is the normal case for cashless,
and during that window the lab must not collect.

**Decide:** is `insurance_claim` "approved", or does the payment track need a
`claim_submitted` → `claim_approved` pair? If the former, say so explicitly in the reception
screen's wording, because a receptionist tapping "Insurance claim" is currently opening the lab
gate on a claim nobody has approved.

### 5b.4 Smaller

- **Brief §4.5 lists three steps** — "Sample collected → Results done → upload PDF" — while the
  prototype's rail has four, adding **Process**. The build follows the prototype. Recorded so the
  difference is a decision rather than a discrepancy.
- **`results_received`** — uploading also advances the visit's chain status to `results_received`
  (best-effort; the visit may already be past it). Not in the brief's chain; it comes from the
  triage dev-notes chain (`06-PHASE-2-PLAN.md` §0.2) and should be settled with that.
- **Cancelled and no-show visits** — nothing says what happens to an outstanding lab order when a
  patient never arrives or leaves early. Today the order simply stays in the queue.
- **The 10 MB vs 20 MB limit** — the prototype tells the user 10; the service allows 20.

## 6. Rules the service enforces, not the screen

1. **No sample before payment.** The button is hidden _and_ the service returns 409. A hidden
   button is not a rule, and this one decides whether a patient is charged.
2. **Upload is atomic with notification.** The file, `report_file_url`, `sample_status` and
   `results_status` move in one transaction. A file in storage with the MO still waiting is the
   failure this prevents.
3. **Backwards is a no-op, not an error.** Two technicians tapping one card at a bench is normal;
   it must not write a second event.
4. **Blocked patients never appear.** As everywhere else in this repo.

## 7. Built vs. outstanding

|                                                                 | Status                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Rail, five counters, workflow banner                            | ✅                                                                                         |
| Five buckets, grouping, headings                                | ✅                                                                                         |
| Patient row: avatar, badge, meta, tests, four-step rail, timer  | ✅                                                                                         |
| Inline action per bucket                                        | ✅                                                                                         |
| Payment gate, UI **and** service                                | ✅                                                                                         |
| **PDF/JPG/PNG report upload**                                   | ✅ — added after review; the first pass marked orders uploaded with no file                |
| Trigger 1 in the same transaction                               | ✅                                                                                         |
| Dimmed uploaded rows, "+ N more", green badge, view-report link | ✅                                                                                         |
| Amber timer past 15m in "results waiting"                       | ✅ (an addition — the prototype colours it, and that delay is the lab's own)               |
| **Detail pane `#labPane`**                                      | ❌ — the whole slide-over: per-test rows, explanatory action text, drag-and-drop zone      |
| **Per-test status**                                             | ❌ — the pane shows a status per test; we store only an order-level status                 |
| **Drag and drop**                                               | ❌ — upload is a file picker; the prototype's zone accepts a drop                          |
| **10 MB limit shown to the user**                               | ⚠️ — the service caps at 20 MB; the prototype says 10. Pick one and state it on the screen |
| **`labSync` reconciliation**                                    | ❌ — see §8                                                                                |

## 8. The open question that matters most

**`labSync` already pulls results from HealthRay** (`labapi.healthray.com`, separate credentials,
running every 2–3 minutes). So a result can arrive two ways: a technician uploading here, or the
sync delivering it on its own.

Today those paths do not know about each other. Before this station runs on real orders, decide:

- Does an automatic arrival advance `sample_status` to `uploaded` and fire trigger 1, leaving the
  technician nothing to do?
- Or does the technician still confirm, with the sync merely attaching the file?
- What happens when both fire — is the manual upload a second report, or an overwrite?

This is question 8 in `06-PHASE-2-PLAN.md`. It is not a UI question: whichever way it goes changes
what "uploaded" means, and the MO's queue depends on that word.

## 9. Also open

- **Urgency, `amount_total` and claim approval** — §5b. The first is a correctness bug waiting for
  the MO/SD station; the other two are decisions.

- **Report storage location.** The file is stored on the order (`report_file_url`), not written
  into the shared `documents` table, because a second writer there would duplicate reports in the
  doctor's Labs tab during the parallel run. Promotion into the patient's record belongs with the
  same decision as vitals — question 12.
- **Per-test results.** The pane implies a status per test; the schema has one per order.
  Cheap to add now (`giniflow_lab_order_tests.status`), expensive once the doctor screen reads it.
- **Who works this station.** `GINIFLOW_STATION_LAB`, granted to `lab`, `tech` and `coordinator`.
  Whether a coordinator may act at the lab desk or only watch is question 7.

## 10. Testing

`npm run smoke:giniflow-lab` — 30 checks: queue and bucketing, the payment gate refusing a
service-level call, each hop through the track, backwards as a no-op, upload setting
`results_status`, every step logged and attributed to `lab`, empty/unknown uploads rejected, a next-visit test staying off today's queue, a submitted claim
refusing collection until approved, and each test carrying its own status.

Not covered, and needing a person: an actual PDF through a browser to Supabase storage, and the
side-by-side against `gini-stations.html` at the lab's screen size.
