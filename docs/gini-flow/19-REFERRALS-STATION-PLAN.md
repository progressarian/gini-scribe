# Referrals — the letter out, and the specialist who answers it

**Date:** 2 Sep 2026
**Status:** built — `giniflow_referrals` (migration applied), `referralsStation.js`, 9 endpoints,
`ReferralsStationPage` + `ReferralForm`/`ReferralCard`, the consult chips, `useGiniflowReferrals`,
`referralLetterTemplate.js` and `smoke:giniflow-referrals`. Reviewed in
`20-REFERRALS-STATION-REVIEW.md`; RF-02, RF-03 and RF-05 are fixed below and RF-04 recorded. RF-01 is
not a finding — `pharmacyStation.sendCardToPatient` already carries the dev-send guard
**Brief:** `Gini-Flow-Developer-Brief.docx` §1.2, §2.3 (trigger 4), §3 (`referrals`), §4.7, §5 (Phase 4)
**Route:** `/giniflow/station/referrals`
**Receives from:** `13-CONSULTANT-STATION-PLAN.md` / `14-CONSULTANT-PRESCRIPTION-PLAN.md` — the consultant is where a referral is decided

The one place a patient leaves the Gini floor and goes somewhere else. A referral is a letter to
another doctor, a WhatsApp message carrying it, and a question that stays open until the specialist
answers — which is why this screen is a tracker and not a form.

---

## 1. Which prototype files this screen comes from

This is the **first Gini Flow screen whose spec spans two prototypes**. Every station so far was one
file; referrals are created in the consultant's screen and worked in the station's, so both are
build targets. All in `docs/Flow-Manage/`:

| File                                           | Lines   | What it holds                                                                                                                                            | Use                     |
| ---------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **`gini-stations.html`** → `#s-referrals`      | 594–716 | The station: rail, the `.ref-form` create form, "Today's referrals", "Past referrals — last 30 days", `.ref-card` rows with letter / send / book buttons | **Build** — §4          |
| **`gini-stations.html`** → landing role-card   | 237–242 | The launcher tile — "Today's external referrals · generate referral letters · track specialist follow-up"                                                | **Build** — §9          |
| **`gini-doctor-v3.html`** → care-block         | 903–913 | The `↗ Referrals` **specialty chips** inside the consultant's Care plan — where a referral is actually decided                                           | **Build** — §5          |
| **`gini-doctor-v3.html`** → `fin-routes`       | 945     | Finalize naming `👁 Ophthalmology referral` as one of the fan-out routes                                                                                 | **Build** — §6          |
| `gini-flow-manager.html`                       | 289     | A board card reading "eGFR 11 · nephro referral" — context only; referrals are not a board column                                                        | Reference               |
| `gini-triage-v3-final.html`                    | 1134    | "if diagnoses includes 'retinopathy': suggest ophthalmology referral flag" — already built as a triage _suggestion_ (`18` §182), not an assignment       | Built                   |
| `gini-doctor-final.html`                       | —       | **Zero referral markup.** Despite being "THE definitive doctor view", it never drew the chips                                                            | **Not a source**        |
| `gini-doctor-view.html`, `gini-doctor-v2.html` | —       | Earlier doctor iterations                                                                                                                                | **Superseded — ignore** |

**Two files to build from: `gini-stations.html` `#s-referrals` and `gini-doctor-v3.html` lines
903–913 and 945.**

---

## 2. Where this sits

A referral is **a parallel artefact, like a lab order — not a step in the chain.** The patient does
not walk to a "referrals desk"; they walk out of the building with a letter. The visit continues to
pharmacy and exit exactly as it would have.

```
checked_in → vitals_pending → with_vitals → vitals_done → sd_pending → with_sd
                                                        ↓
                                            ready_for_doctor → with_doctor → doctor_done
                                                                    │              ↓
                                                                    │      pharmacy_pending → dispensed → exited
                                                                    │
                                                                    └──▶ giniflow_referrals   (parallel; never moves current_status)
                                                                         created → letter_generated
                                                                                 → appointment_booked
                                                                                 → completed
```

**No status-chain work is needed.** Nothing is added to `CHAIN`, `STATUS_LABEL`,
`STATUS_TO_SLA_KEY`, `BOARD_COLUMNS` or `ACTOR_ROLES` in `shared/giniflowStatus.js`. The referral's
own four statuses live on its own row and are read only by this station — the same shape
`giniflow_lab_orders.sample_status` already has.

One consequence worth stating: **a referral has no SLA.** The floor's time budgets measure how long
a patient waits inside the building, and a specialist appointment three weeks out is not a
bottleneck the coordinator can clear. The station's list is ordered by urgency and age, not by a
budget colour.

---

## 3. What already exists — and what that means

| Need                           | Already in the repo                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render a PDF                   | `generatePrescriptionPdf(data)` and its cached `getBrowser()` — `server/services/prescriptionHtmlPdf.js`. Puppeteer, A4, 12 mm margins, one warm browser |
| Hospital letterhead            | The `.rx-header` block in `server/templates/prescriptionTemplate.js:1100` — name, NABH line, address, phone, all plain HTML, no logo asset               |
| Rendering referrals on paper   | That template **already splits them out**: `splitTests()` at `:200` filters `referred_to` / `specialty` / `type === "referral"`, rendered at `:1021`     |
| Store a generated file         | `uploadReport()` — `server/services/giniflow/labStation.js:239`. base64 in, 10 MB cap, Supabase `fetch` PUT, public object URL out                       |
| Send WhatsApp                  | `server/services/msg91.js` — three template senders, a uniform dev fallback, `AbortSignal.timeout(10_000)` on the newest one                             |
| An idempotent "send once"      | `sendCardToPatient()` — `server/services/giniflow/pharmacyStation.js:525`. Guard on the stamp, refuse without a phone, never stamp on a dev-mode send    |
| The fan-out to hang off        | `finalizeConsult()` and its after-the-commit block — `server/services/giniflow/finalize.js:249`                                                          |
| A medicine from another doctor | `addExternal()` — `server/services/giniflow/prescription.js:451`. Writes `medications` with `external_doctor`; used by the deferred return leg (§12.3)   |
| Station chrome                 | `.rail`, `.rbtn`, `.badge`, `.btn`, `.grp-lbl`, `.scroll > .inner`, `.toast` — all already in `src/styles/giniflow-station.css`                          |

**Do not duplicate any of these.** In particular: **no second PDF renderer** (the pdfkit path in
`prescriptionPdf.js` is the older "paste clinical notes" flow — the Puppeteer/HTML path is the one
the prescription now uses and the one with real typography); **no second WhatsApp vendor** (§3.1);
**no `external_medicines` table** (`2026-09-02_consultant_prescription.sql:6-12` explains why the
repo has one medicine history and will keep having one).

### 3.1 WATI is not this repo's messenger

The brief says WhatsApp via **WATI**. This repo sends through **MSG91**
(`control.msg91.com/api/v5/whatsapp/…`), template-based, with a dev fallback that logs instead of
sending. **Use MSG91**, for the reason `16` §3.1 already gave: two vendors means two WABA numbers,
two template approval queues and two sets of credentials for one hospital.

A finding that goes beyond `16`, and that shapes this design: **MSG91 has no document or media path
in this repo.** All three senders — `sendOtpSms`, `sendFlowCheckin`, `sendMedicineCard` — are
`content_type: "template"` with positional text body variables. There is no `type: "document"`
component anywhere. So **the letter travels as a link, not as an attachment**, following
`sendFlowCheckin`'s own `visit_link` precedent. That link is a public Supabase object URL — see
§7.3, which states what that costs.

What survives from the brief is the warning: `MSG91_WA_REFERRAL_TEMPLATE_NAME` needs Meta approval
and that takes days. `14` §426 already flagged it — **file the template the week this plan is picked
up**, and build the send behind the existing dev fallback so the screen ships either way.

### 3.2 There is already a `referrals` table, and this plan does not use it

`server/routes/visit.js:119` creates a `referrals` table **at boot, in route code rather than a
migration** — `patient_id, doctor_name, speciality, reason, appointment_id, status` — written by
`POST /visit/:patientId/referral` and surfaced by a working Scribe UI
(`src/components/visit/modals/AddReferralModal.jsx`, the Referrals list in
`src/components/visit/VisitPlan.jsx`). It has no hospital, urgency, key investigations, letter URL
or sent-at column.

**Decision (taken): Gini Flow builds `giniflow_referrals` separately**, per the `giniflow_*`
separation of `00-OVERVIEW.md §2.3`.

This is deliberately _not_ the call `14` made for prescriptions, where the brief's second medicine
history was rejected. State the debt plainly rather than discover it later:

- A referral created in Scribe's visit page **will not appear** on the Flow station, and vice versa.
- Two tables answer "who was this patient referred to", and nothing reconciles them.
- The old `referrals` table is not a `flow_*` table, so it does **not** disappear when the retired
  module is dropped. Retiring or merging it is its own piece of work, and it should be listed
  alongside the `flow_*` retirement rather than left implicit.

---

## 4. Screen 1 — the station (`#s-referrals`)

`.scr#s-referrals` → `.rail` + `.scroll > .inner`. No `.stats` strip and no `.sec` card chrome —
unlike Lab, Pharmacy and Reception, this screen is a bare list.

**Rail:** `.rl` "Referrals", `.rsep`, the subtitle "Today's external referrals", then `.rr` with a
green `.rbtn.grn` **"+ New referral"** (toggles the form) and **"← Stations"**. Add `LiveBadge` as
every other station has.

**Two groups**, both `.grp-lbl` headings over bare `<div>`s:

| Group                           | Contents                                    | Prototype |
| ------------------------------- | ------------------------------------------- | --------- |
| `Today's referrals — N`         | Everything created today, any status        | 636       |
| `Past referrals — last 30 days` | Older rows, rendered at inline `opacity:.6` | 700       |

**What the prototype lacks and the build must add.** The counts are hard-coded strings, there is no
empty state for either group, and there is no search — every other Gini Flow station has one, and a
referral list is looked at to answer "what happened to Mr Sandhu", which is a search. Add: a real
count, an empty note in each group (`.empty-note` already exists), and a `.rail-search` filtering
name and file no. Collapsible groups are **not** needed here — two short lists, unlike the vitals
queue's five.

### 4.1 The `.ref-card`

| Part        | Class        | Contents                                                                                                                     |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Head glyph  | inline 22px  | A specialty emoji — 🫘 nephrology, 👁 ophthalmology, ❤️ cardiology. Comes from `SPECIALTIES` (§5), never hard-coded per card |
| Title       | `.rcn`       | `Dr. Suresh Gupta — Nephrology`, or `Ophthalmology — Fundus / Retinopathy` when no doctor is named                           |
| Meta        | `.rcs`       | `Max Hospital, Mohali · Referred by Dr. Bhansali · Thu 27 Aug 2026`                                                          |
| Urgency     | `.badge`     | Right of the head — see §4.3                                                                                                 |
| Stats strip | inline flex  | Two columns: **Patient** (name, then `71M · P_14207 · UACR 4643 · eGFR 11`) and **Key investigations**                       |
| Reason      | `.rc-reason` | `<strong>Reason:</strong>` then the narrative. Grey fill, 3px teal left border                                               |
| Footer      | `.rc-foot`   | The buttons, then the workflow badge pushed right with `margin-left:auto`                                                    |

The card is **not** clickable — unlike `.pt-card` in Lab it has no `onclick` and no
`cursor:pointer`. Every action is an explicit button. Keep that: a referral has three different
next steps and none of them is "open".

**Footer buttons**, and what each really does:

| Prototype button      | Real behaviour                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `📄 Referral letter`  | Opens the PDF inline (§7). Regenerates if the row has no `letter_file_url`, otherwise serves the stored one     |
| `📱 Send to doctor`   | WhatsApp to `to_doctor_phone`. Hidden when that column is null                                                  |
| `📱 Send to patient`  | WhatsApp to the patient's own number from `patients`                                                            |
| `📅 Book appointment` | Opens a small inline form for the **external** appointment date + note, flipping status to `appointment_booked` |

The prototype shows "Send to doctor" on one card and "Send to patient" on the other. Both exist;
which are shown depends only on whether a specialist phone is on file.

Past cards carry `View specialist report` and `Add to medicines` — **deferred, §12.3.** Do not build
buttons that toast and do nothing.

### 4.2 The create form (`.ref-form`, `#refForm`)

Hidden by default, `.open` reveals it. Two `.rf-grid` rows of three, then two full-width fields,
then Create / Cancel. Verbatim from the prototype:

| #   | Label                       | Control    | Placeholder                                                            |
| --- | --------------------------- | ---------- | ---------------------------------------------------------------------- |
| 1   | Patient                     | input      | `Search patient name or ID`                                            |
| 2   | Referred to (doctor name)   | input      | `e.g. Dr. Suresh Gupta`                                                |
| 3   | Specialty                   | select     | —                                                                      |
| 4   | Hospital / clinic           | input      | `e.g. Max Hospital, Mohali`                                            |
| 5   | Urgency                     | select     | —                                                                      |
| 6   | Date                        | date       | defaults to today                                                      |
| 7   | Reason for referral         | textarea×3 | `Clinical reason, relevant history, specific question for specialist…` |
| 8   | Key investigations to share | input      | `e.g. HbA1c, UACR, eGFR, Retinopathy report from Oct 2025`             |

Submit reads **"Create referral + generate letter"** and toasts
`✓ Referral created · letter generated · patient notified`.

Three gaps to close in the build. **The prototype has no `<form>`, no `name`/`id` attributes, no
`required`, and no validation** — add a Zod `giniflowReferralSchema` requiring patient, specialty
and reason, exactly as every other station body is validated. **The Patient field is a placeholder,
not a picker** — wire it to the existing patient search rather than free text, or a referral lands
with no `patient_id`. And add **`to_doctor_phone`**, which the prototype omits but §4.1's "Send to
doctor" requires.

Cancel must clear the fields; the prototype's `toggleRefForm()` only hides them, so reopening shows
a half-typed referral for whoever comes next.

**The form and the chip share `createReferral`, and must not share its upsert (RF-02).** The
`ON CONFLICT (visit_id, specialty) DO UPDATE` that makes the chip idempotent would, unguarded, let a
coordinator creating "Cardiology → Dr. B" silently rewrite a "Cardiology → Dr. A" whose letter has
already been generated and sent: the addressee flips while `letter_file_url`, `letter_sent_at` and
`status` keep describing the letter that actually went out. The `DO UPDATE` is therefore guarded on
`status = 'created' AND letter_file_url IS NULL`, and the two callers diverge when it bites —
`source: "chip"` returns the existing row unchanged (a toggle must not throw), `source: "desk"`
refuses with the specialty named.

### 4.3 Statuses and badges

| Status               | Meaning                         | Badge                         |
| -------------------- | ------------------------------- | ----------------------------- |
| `created`            | Written down, no letter yet     | `b-ink` "Created"             |
| `letter_generated`   | PDF exists at `letter_file_url` | `b-grn` "Letter generated"    |
| `appointment_booked` | The specialist has given a slot | `b-amb` "Appointment pending" |
| `completed`          | Seen, and the loop is closed    | `b-grn` "Completed"           |

Urgency, on the head: `routine` → `b-ink`, `soon` → `b-amb`, `urgent` and `emergency` → `b-red`.
The prototype only ever draws Urgent and Routine; the other two follow the same scale.

Note the status names describe **the letter's journey, not the patient's**. `appointment_booked`
means someone else's clinic gave a slot — Gini books nothing (§4.1).

---

## 5. Screen 2 — the consultant's referral chips

`gini-doctor-v3.html:903-913`, a `care-block` titled `↗ Referrals` holding toggle chips:

```html
<div class="cb-title">↗ Referrals</div>
<div class="ref-chips">
  <div class="rc" onclick="this.classList.toggle('sel')">Cardiology</div>
  <div class="rc sel" onclick="this.classList.toggle('sel')">Ophthalmology</div>
  …
</div>
```

This is where a referral is actually decided, and it is the missing quarter of the Care plan —
`src/pages/giniflow/consult/CarePlanSection.jsx:69` still reads
`treatment · diet · lifestyle · next visit` where the prototype says
`treatment · diet · tests · referrals · next visit`.

Selecting a chip creates a `giniflow_referrals` row in `created` status with the specialty and
nothing else — the consultant names the department, the station fills in the doctor, hospital and
phone later. Deselecting removes a row that is still `created`; a row past that has a letter behind
it and is refused with a 409 the consultant can act on.

**The two prototypes disagree on the specialty list**, so neither can be hard-coded:

| Source                 | List                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `gini-doctor-v3` chips | Cardiology, Ophthalmology, Nephrology, **Dietitian**, **Bariatric consult**, **Podiatry**                                              |
| `gini-stations` select | Nephrology, Cardiology, Ophthalmology, Gastroenterology, Neurology, Orthopaedics, Dermatology, Bariatric Surgery, Endocrinology, Other |

Take the **union** into a new `shared/giniflowReferrals.js`, following the shape of
`shared/patientCategories.js` — `SPECIALTIES` as `{ value, label, icon }` plus a `specialtyMeta()`
lookup, and `URGENCIES` as `{ value, label }` carrying the prototype's own wording
(`Routine (within 2 weeks)`, `Soon (within 1 week)`, `Urgent (within 48 hrs)`, `Emergency`). The
icon lives here so the card's emoji, the chip and the letter all agree; `CATEGORY_META` in
`shared/giniflowStatus.js` is the precedent for pairing an icon with a value.

The card in `gini-doctor-v3` shows the chips are **per visit, not per patient** — they are this
consultation's decisions, which is why the row carries `visit_id`.

**One referral per specialty per visit is a schema rule (RF-04).** The unique index on
`(visit_id, specialty)` is what makes the chip a toggle: a double tap on a tablet must not produce a
second letter. The consequence is a decision, not an oversight — a visit **cannot** carry two
referrals to the same specialty, so a second opinion from a different cardiologist has nowhere to go
on the same visit. If that day comes, the index is the thing to widen (`(visit_id, specialty,
to_doctor)`, or a nullable `sequence`), and `createReferral`'s upsert is the thing to re-read.

---

## 6. Finalize

`gini-doctor-v3.html:945` puts `👁 Ophthalmology referral` in the Finalize confirmation panel
alongside pharmacy, MHG and lab. Two changes to `server/services/giniflow/finalize.js`:

**`finalizePreview()` (`:297`) gains a referral count**, so the consultant sees the fan-out named
before they trigger it — the same read-only shape as `tests`, `medicines` and `outOfStock`. The
panel should name the specialties, not just count them: "Ophthalmology referral" is actionable,
"1 referral" is not.

**`finalizeConsult()` generates the letters in the after-the-commit block** (`:249`), beside
`savePrescriptionForVisit`, and **never inside the transaction**. That file already states the rule
and the reason: "Everything that can fail slowly — the PDF, the Genie push — happens AFTER the
commit, never inside it." A Puppeteer render is exactly that. Each generation must be idempotent —
skip when `letter_file_url` is already set — because the same `.catch(() => {})` shape means a retry
is always possible.

A referral is **not** a reason to block Finalize. A letter that failed to render can be regenerated
from the station with one button; a consultation that refused to finalize because a PDF timed out
would strand the patient before pharmacy.

---

## 7. The letter

**The prototype has no letter at all** — no template, no preview, no `window.print()`, no `@media
print`. "Referral letter" exists only as a button that toasts. So the letter is designed here.

### 7.1 The template

`buildReferralLetterHtml(data)` in `server/templates/referralLetterTemplate.js`, rendered by
`generateReferralLetterPdf(data)` added to `server/services/prescriptionHtmlPdf.js` so it **shares
the warm `getBrowser()`** rather than launching a second Chromium.

Reuse the prescription's `.rx-header` block verbatim (`prescriptionTemplate.js:1100`) — same
hospital name, NABH line, address and phone, same Instrument Serif / Outfit / DM Mono stack. A
referral letter that does not look like the prescription in the same envelope reads as coming from
somewhere else.

Body, in order: date · addressee (`Dr. Name`, specialty, hospital) · `Re:` patient line (name, age,
sex, file no) · the reason narrative · key investigations · **current medicines** (from
`medicineCard.js` — the specialist needs to know what the patient is already on before they
prescribe) · the referring consultant's name and credentials · a "please reply to" line carrying the
hospital's number.

### 7.2 Serving it

`GET /api/giniflow/referrals/:id/letter.pdf` — `Content-Type: application/pdf`,
`Content-Disposition: inline`, mirroring `server/routes/visit.js:3661`. Renders on demand if the row
has no stored file, otherwise redirects to the stored URL.

**The stored file is authoritative (RF-05).** It is the letter the specialist was actually sent, and
it is worth saying why the live render is not: the letter reads `medicines` live, so a referral
viewed a week later would render a different medicine list from the one the specialist holds, and a
coordinator clicking the button four times would cost four Puppeteer runs. A row with no stored file
still renders on demand — which is what makes the button work before Finalize has run.

### 7.3 Storing it, and what that costs

Uploaded to Supabase at `giniflow/referrals/{patient_id}/{ts}_{name}.pdf` following
`labStation.js:239`, and the **public object URL** is written to `letter_file_url` — the same
treatment `giniflow_lab_orders.report_file_url` already gets.

**Decision (taken), stated once so it is on the record:** a public object URL means the letter is
readable by anyone who has the link, permanently, with no login. A referral letter carries a
diagnosis, lab values and a patient's name. This is the same exposure the lab report already has, so
it is consistent rather than new — but it is a DPDP/GDPR consideration, and if either is revisited
both should be, together. `documents` + `GET /documents/:id/stream` (short-lived signed URLs, which
the prescription uses) is the migration path if that day comes.

---

## 8. Server side

**Migration** `server/migrations/2026-09-02_giniflow_referrals.sql`, with the house banner comment
naming this doc and the reasoning:

```sql
CREATE TABLE IF NOT EXISTS giniflow_referrals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id          INT  NOT NULL REFERENCES patients(id),
  to_doctor           TEXT,
  to_doctor_phone     TEXT,
  specialty           TEXT NOT NULL,
  hospital            TEXT,
  urgency             TEXT NOT NULL DEFAULT 'routine',  -- routine | soon | urgent | emergency
  reason              TEXT,
  investigations      TEXT,
  letter_file_url     TEXT,
  letter_generated_at TIMESTAMPTZ,
  letter_sent_at      TIMESTAMPTZ,
  sent_to             TEXT,                              -- patient | doctor | both
  appointment_date    DATE,
  appointment_note    TEXT,
  status              TEXT NOT NULL DEFAULT 'created',   -- created | letter_generated | appointment_booked | completed
  created_by          INT REFERENCES doctors(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_giniflow_referrals_visit   ON giniflow_referrals (visit_id);
CREATE INDEX IF NOT EXISTS idx_giniflow_referrals_created ON giniflow_referrals (created_at DESC);
```

Applied the normal way, from `server/`:
`node migrations/_runOne.mjs migrations/2026-09-02_giniflow_referrals.sql`.

`urgency` and `status` are TEXT with a trailing comment, not PG enums — the house rule, so the
vocabulary can grow without a migration.

**Service** `server/services/giniflow/referralsStation.js`, house signatures (ids positional, an
options object, `db = pool` last so any caller can pass a transaction client):

```js
export async function getReferrals(visitDate, { q = null } = {}, db = pool)
export async function createReferral(visitId, fields, db = pool)
export async function generateLetter(referralId, { force = false } = {}, db = pool)
export async function sendLetter(referralId, { to = "patient", force = false } = {}, db = pool)
export async function bookAppointment(referralId, { date, note = null, actorId = null }, db = pool)
export async function completeReferral(referralId, { actorId = null } = {}, db = pool)
export async function referralsForVisit(visitId, db = pool)   // the consultant's chips + finalizePreview
```

Writes use the `BEGIN` / `SELECT … FOR UPDATE` / invariants / write / `COMMIT` / `ROLLBACK` /
`client.release()` template. Refusals throw
`Object.assign(new Error("…"), { status: 409 })` with a sentence the desk can act on — "This
referral has already been sent", "No phone number for Dr. Gupta", "A letter has been generated for
this referral — it cannot be removed".

`sendLetter` is modelled directly on `sendCardToPatient` (`pharmacyStation.js:525`): guard on
`letter_sent_at && !force` → `{ sent: false, alreadySent: true }`; missing phone → 409; and when
MSG91 returns `{ dev: true }`, return `{ sent: false, dev: true, reason: "The WhatsApp referral
template is not live yet — the letter was logged, not sent" }` **without stamping**. Only a real
send writes `letter_sent_at`.

**MSG91** gains `sendReferralLetter(phone, vars)` reading `MSG91_WA_REFERRAL_TEMPLATE_NAME`, with
body vars `patient_name, specialty, doctor_name, hospital, letter_link` and the same dev fallback as
its three siblings.

---

## 9. API

Behind a new **`GINIFLOW_REFERRALS`** capability, granted to `coordinator` and `admin` per
`06-PHASE-2-PLAN.md:192`. Added to the `CAPABILITIES` block in `shared/permissions.js` and to those
role arrays; re-run `node server/scripts/verify-rbac.mjs` afterwards.

**The consultant does not get it (RF-03).** They must be able to _write_ a referral — that is what
§5's chips are — but granting the capability outright would hand them the coordinator's desk as
well: every patient's referrals for the day, booking specialist appointments and closing loops, plus
the page itself, because `src/config/routes.js` gates `/giniflow/station/referrals` on the same key.
So the three **visit-scoped** endpoints the chips use (`GET`/`POST /referrals/visit/:visitId` and
`DELETE /referrals/:id`) take an any-of gate of `[GINIFLOW_REFERRALS, GINIFLOW_STATION_DOCTOR]`, and
everything else stays on `GINIFLOW_REFERRALS` alone. This is question 4 (§12) answered: the
coordinator owns the tracking, the consultant only creates.

| Method | Path                                      | Body                                    |
| ------ | ----------------------------------------- | --------------------------------------- |
| GET    | `/api/giniflow/referrals`                 | `?date&q`                               |
| GET    | `/api/giniflow/referrals/patients`        | `?q&date` — the form's picker           |
| POST   | `/api/giniflow/referrals`                 | the 8 form fields + `visitId`           |
| GET    | `/api/giniflow/referrals/visit/:visitId`  | — the chips read back                   |
| POST   | `/api/giniflow/referrals/visit/:visitId`  | `{ specialty, urgency? }` — one chip    |
| DELETE | `/api/giniflow/referrals/:id`             | — (only while `created`)                |
| GET    | `/api/giniflow/referrals/:id/letter.pdf`  | —                                       |
| POST   | `/api/giniflow/referrals/:id/letter`      | `{ force? }` — regenerate               |
| POST   | `/api/giniflow/referrals/:id/send`        | `{ to: "patient" \| "doctor", force? }` |
| POST   | `/api/giniflow/referrals/:id/appointment` | `{ date, note? }`                       |
| POST   | `/api/giniflow/referrals/:id/complete`    | `{ confirm: true }`                     |

Routes go in `server/routes/giniflowStations.js` as their own `// ── Referrals ──` section with a
`referralsGate` and a `referralsError` helper, matching the pharmacy block at `:844`. Schemas go in
the Gini Flow section of `server/schemas/index.js`; the `complete` body uses the
`{ confirm: true }` `.refine()` convention every irreversible action here uses.

Plus the `STATION_CAPS` entry (`giniflowStations.js:478`), a `referrals` key in
`getStationSummary()` (`server/services/giniflow/stationSummary.js`) counting today's open
referrals, and the launcher tile.

---

## 10. Client

| File                                            | Holds                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `src/pages/giniflow/ReferralsStationPage.jsx`   | Rail, search, the two groups, the toast                            |
| `src/pages/giniflow/referrals/ReferralForm.jsx` | The `.ref-form` create panel                                       |
| `src/pages/giniflow/referrals/ReferralCard.jsx` | One `.ref-card` with its footer actions and inline appointment box |
| `src/pages/giniflow/consult/ReferralChips.jsx`  | The `↗ Referrals` care-block, rendered by `CarePlanSection`        |
| `src/queries/hooks/useGiniflowReferrals.js`     | Queue, create, letter, send, appointment, complete                 |
| `shared/giniflowReferrals.js`                   | `SPECIALTIES`, `URGENCIES` and their lookups (§5)                  |

The hook carries a `useReferralAction` wrapper copying `useGiniflowMo.js:41-51`, invalidating
`["giniflow","referrals"]`, `["giniflow","board"]` and `["giniflow","stations","summary"]`.
Registration: `lazyWithRetry` + a route in `src/router.jsx`, `PAGE_CAPABILITIES` in
`src/config/routes.js`, and a `STATIONS` tile in `StationsLauncherPage.jsx` whose key matches both
`STATION_CAPS` and the summary key.

Styles append a `/* ══ REFERRALS STATION ══ */` section to `src/styles/giniflow-station.css`,
porting the prototype's `.ref-form`, `.rf-grid`, `.rff`, `.ref-card`, `.rc-head`, `.rc-body`,
`.rcn`, `.rcs`, `.rc-reason`, `.rc-foot` rules. **Watch the `.rc-` prefix collision** — the launcher
already owns `.rc-ico`, `.rc-name`, `.rc-desc`, `.rc-count`, and the doctor queue owns `.rc` chips;
scope the new ones under `.ref-card` rather than adding bare `.gf .rc-*` rules.

`.gf` is `height:100vh / overflow:hidden`, so the page must declare its own scroll container — the
trap that caught both consultant screens and the pharmacy pane.

Realtime: add `["giniflow","referrals"]` to the `visit` kind in `INVALIDATES`
(`src/queries/hooks/useGiniflowLive.js`). No new `eventTailer` stream is needed — referrals write no
event table of their own, and a visit moving is the only thing that changes this list from outside.

---

## 11. Smoke coverage

`smoke:giniflow-referrals`, added to `server/package.json` beside its twelve siblings. Assertions:

- selecting two chips creates exactly two rows, one per specialty, both `created`, both carrying
  `visit_id`;
- deselecting a `created` chip removes its row; deselecting one whose letter exists is refused 409;
- Finalize generates a letter for each referral **once** — a second finalize attempt adds no second
  file;
- the rendered PDF is non-empty, is `%PDF`-prefixed, and contains the patient's name and the
  addressee's specialty;
- `send` with no phone on file is refused 409, and refuses for `to: "doctor"` when
  `to_doctor_phone` is null;
- in dev mode `send` returns `{ dev: true }` and **leaves `letter_sent_at` null**;
- `appointment` stores the date and flips status to `appointment_booked`;
- `complete` requires `{ confirm: true }`;
- the WhatsApp send and the PDF render both run **outside** any transaction.

---

## 12. Open questions

1. **Is the public letter URL acceptable?** §7.3. It matches the lab report's treatment, so the
   answer should be the same for both — but a referral letter carries a diagnosis and a name, and
   the link never expires. If this is revisited, revisit `giniflow_lab_orders.report_file_url` at
   the same time.

2. **Who reconciles the two referral tables?** §3.2. Scribe's visit page keeps writing the old
   `referrals` table, which is not a `flow_*` table and so survives the retirement of the old flow
   module. Somebody has to decide whether it is migrated, dual-written, or left as history.

3. **Are Dietitian, Podiatry and Bariatric consult external at all?** The doctor-v3 chip list mixes
   them in with Cardiology and Nephrology, but a dietitian referral may well be a booking into
   Gini's own GHM sheet rather than a letter to another hospital. If so they need a different
   action — and possibly a `is_internal` flag on the specialty rather than a second feature.

4. **Who owns this station day to day?** `06-PHASE-2-PLAN.md:192` says coordinator, but §5 puts
   creation in the consultant's hands and §4 puts the follow-up chase in someone else's. The likely
   answer is coordinator owns the tracking and the consultant only creates — which is what the
   capability grant in §9 assumes, and which should be confirmed before the grant ships.

5. **Does the specialist's reply need to reach the patient's app?** The medicine card and the
   prescription both land in `documents` and reach MyHealth Genie that way. A referral letter stored
   only at a Supabase URL reaches nobody's app. If patients should see their own referral letters,
   the letter wants a `documents` row too — which is also the answer to question 1.

### 12.3 The return leg — deferred

The prototype's past-referral card carries `View specialist report` and `Add to medicines`, and the
brief says "specialist report return can add an external_medicine". **Not in this plan.** It needs
its own: uploading the specialist's report against the referral (the `uploadReport` pattern,
`labStation.js:239`), reading it, and creating the medicine.

The medicine half is already solved and should be reused rather than rebuilt: `addExternal()`
(`server/services/giniflow/prescription.js:451`) writes a row to `medications` with
`external_doctor` set and `med_group = 'external'`. Its `prescriberName` and `prescriberHospital`
inputs map exactly onto this table's `to_doctor` and `hospital`. There is no `external_medicines`
table and there will not be one — `2026-09-02_consultant_prescription.sql:6-12` explains that a
second medicine history is the failure this module is structured to avoid.

Until that plan lands, **do not render the two past-card buttons.** A button that toasts and does
nothing is worse than an absent one on a screen a coordinator is trusting.
