# Hand the prescription to the patient — `GINIFLOW_PRINT_RX`

- Decided: 5 Sep 2026
- Answers open question 3 of `16-PHARMACY-STATION-PLAN.md` §11 — _"Does the pharmacy hand out a
  printed card too? The prototype only sends."_
- Depends on: `14-CONSULTANT-PRESCRIPTION-PLAN.md` §6 (Finalize), `16-PHARMACY-STATION-PLAN.md` §5–7
- Paired with: `26-RX-EXPLAIN-STATION-PLAN.md` — the nurse desk that has the strongest claim to the printout

## 1. The problem

A finalized prescription reaches three places today (`14` §295):

```
Finalize (one transaction)
  ├─ medicine card          → recomputed view, nothing stored
  ├─ prescriptionAutoSave   → Rx PDF → documents + storage   (AFTER commit)
  └─ Genie / MHG sync       → fire-and-forget                (AFTER commit)
```

None of them is paper. A patient without a smartphone, or without MyHealth Genie installed, leaves
with medicines and nothing to read. The renderer already exists — `prescriptionHtmlPdf.js`
`generatePrescriptionPdf(data)` — it is simply not reachable from any station screen.

## 2. Why not "just give it to the pharmacy"

The pharmacy station is designed as the last human touchpoint. It is not one. Five days of events
(1–5 Sep 2026):

| step               | visits | actor roles that wrote it  |
| ------------------ | -----: | -------------------------- |
| `checked_in`       |    352 | reception, system          |
| `vitals_done`      |    133 | vitals, system             |
| `with_sd`          |     21 | mo_sd                      |
| `with_doctor`      |     27 | doctor, system             |
| `pharmacy_pending` |     24 | **doctor, system**         |
| `dispensed`        |  **1** | pharmacy                   |
| `exited`           |    323 | **system 322**, pharmacy 1 |

221 patients were prescribed medicines in that window and **one** passed through the pharmacy
station. Gating the button on `GINIFLOW_STATION_PHARMACY` alone would be correct by design and
useless in practice — 220 of 221 patients would still walk out with no paper. See
[[giniflow-floor-still-on-healthray]]: the floor works HealthRay, not these screens.

## 3. The capability

`GINIFLOW_PRINT_RX` — a new key, not a widening of an existing station capability. Printing is one
narrow action several desks need; granting it by widening `GINIFLOW_STATION_PHARMACY` would hand
reception the whole dispense flow with it. This mirrors the reasoning already in
`shared/permissions.js` — "Deliberately its own keys rather than reusing the `FLOW_` ones."

| role        | grant | why                                                                                                                                   |
| ----------- | :---: | ------------------------------------------------------------------------------------------------------------------------------------- |
| nurse       |  ✅   | the Rx Explain desk (`26-RX-EXPLAIN-STATION-PLAN.md`) — the one step whose whole purpose is the patient understanding their medicines |
| reception   |  ✅   | the only desk with proven human presence (352 check-ins); the patient passes it on the way out whether or not they collect medicines  |
| consultant  |  ✅   | holds the patient at the moment the document comes into being (Finalize)                                                              |
| pharmacy    |  ✅   | correct by design; near-zero traffic today, ready when the floor adopts it                                                            |
| coordinator |  ✅   | already holds `GINIFLOW_STATION_RECEPTION` + `_MO`; is asked for reprints                                                             |
| admin       |  ✅   | holds everything                                                                                                                      |
| **mo**      |  ❌   | see §3.1                                                                                                                              |

### 3.1 Why MO/SD is excluded

MO/SD sees the patient at `with_sd` → `ready_for_doctor`, **before** the consultant finalizes. At
that point today's prescription does not exist — only a `giniflow_rx_items` draft, which Finalize
deletes (`finalize.js`, "the draft has become the prescription"). A print button there would either
sit disabled for every patient, or print **last visit's** prescription — a different document, and
an easy one to hand over by mistake.

If the real need is "the MO wants to show the patient their current regimen", that is the **medicine
card**, not the prescription, and it is already computed: `medicineCard.js` `buildCard(patientId)`.
Treat that as a separate request.

## 4. When the button appears

The gate is **the document, not the status**. A visit can sit at `pharmacy_pending` with no PDF yet,
because `savePrescriptionForVisit` runs _after_ the commit and is fire-and-forget.

```
                                    button state
consultant has not finalized   →    hidden
finalized, PDF not yet written →    visible, disabled, "Preparing prescription…"
finalized, PDF in documents    →    visible, enabled
```

Concretely, enabled when a row exists in `documents` with:

- `patient_id` = the visit's patient
- `consultation_id` = the consultation Finalize created
- `doc_type = 'prescription'`

That is the same key `prescriptionAutoSave` uses for its idempotency check, so the button and the
saver agree by construction rather than by coincidence.

Hidden — not disabled — before Finalize. A disabled button on every pre-consult patient trains staff
to ignore it, and by §3.1 the only roles that see patients that early are ones we are not granting.

### 4.1 The window between commit and PDF

Measured in seconds, but real. Two acceptable behaviours; pick one:

- **(a) Wait.** Poll the document; enable when it lands. Simplest, and the pane already polls.
- **(b) Generate on demand.** If no document exists, call `savePrescriptionForVisit` on click and
  serve the result. Removes the wait but duplicates the trigger; only worth it if (a) proves slow.

Start with (a).

### 4.2 This does not depend on HealthRay

Worth stating because a sibling feature does. The Rx PDF is rendered by **our own** Puppeteer
(`prescriptionHtmlPdf.js` `renderHtmlToPdf`) from **our own** data. It does not call HealthRay and is
unaffected by the lab/HealthRay WAF cooldowns that leave `lab_cases.pdf_storage_path` null (see
[[healthray-auth-expiry]]). Prescription PDFs are landing today; lab report PDFs are not. Do not
conflate the two when triaging "no PDF".

## 5. What gets printed

The **full medicine card**, not the pharmacy's filtered view.

`14` §303 routes different content to different places on purpose:

```
💊 Pharmacy — Gini medicines only        📱 Patient MHG — full medicine card
```

The pharmacy view omits external medicines — they are `Ext` on the card and _"never dispensable —
the pharmacy sees them, cannot hand them over"_ (`14` §123). Printing the pharmacy view would silently
drop the patient's external medicines from the only copy they take home. The patient's paper must
match the patient's app.

## 6. Scope of the endpoint

Restrict to **the current day's visits**, addressed by `visitId` — not by arbitrary `patientId`.

Reception printing means reception staff can pull a prescription for anyone in front of them, which
is the point; it should not also mean they can pull any patient's prescription for any past date. A
`visitId` on today's board is a much smaller surface than a patient directory, and matches how every
other station route on `giniflowStations.js` is already scoped.

Reprints of an older visit stay where they are — the patient's chart, behind the existing document
capabilities.

## 7. Where it is wired

Per `CLAUDE.md`, a capability lands on both sides or it lands nowhere.

| file                                                                             | change                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `shared/permissions.js`                                                          | add `GINIFLOW_PRINT_RX` to `CAPABILITIES`; add to the five roles in `ROLE_CAPABILITIES`                         |
| `server/routes/giniflowStations.js`                                              | `const printRxGate = requireCapability(CAP.GINIFLOW_PRINT_RX);` — same shape as `receptionGate`, `pharmacyGate` |
| `server/services/giniflow/printRx.js`                                            | new — resolve visit → consultation → document; stream or 409 `not_ready`                                        |
| `src/pages/giniflow/ReceptionStationPage.jsx`, `.../pharmacy/*`, consultant pane | the button, guarded by the capability and §4's document check                                                   |

No migration. No schema change. The document, the renderer and the storage path all exist.

## 8. Open questions

1. **Print or download?** A `window.print()` on an HTML view and a served PDF are different builds.
   The reference (`gini-stations.html`) has neither. Reception has a printer; the consultant room may
   not.
2. **Does printing need recording?** A dispense is an event; a print currently would not be. If
   "did the patient get their copy?" is a question anyone will ask, it needs a
   `giniflow_visit_events` row or a column — decide before building, because retrofitting it means
   not knowing about every print before the change.
3. **Reprint limits.** Nothing stops a desk printing ten copies. Probably fine; note it rather than
   discover it.
4. **Language.** The counselling note is Hindi-first (`16` §5.1). The prescription PDF is English.
   Whether the printed card follows the note's convention is a clinical decision, not a technical one.
