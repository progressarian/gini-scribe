# 56 — Services priced per patient: the doctor (or MO, reception, counter) sets the amount for this patient only

Status: **BUILT 30 Sep 2026 (tasks 1–7), not committed.** Migration `2026-10-31_per_patient_price.sql` applied to prod. Verified with rolled-back transaction checks against the live database (every rule in §3, §5, §7), then reviewed; review fixes in §9. Not done: task 8 (Playwright e2e specs) and task 9 (flagging the OPD-sheet procedures, waiting on the sheet).

---

## 1. The case, in the floor's words

Some OPD procedures have no fixed price. The consultant decides the amount for each patient at the
time (a dressing, a keloid injection, a small excision…). The billing master lists them at ₹0.

Today a ₹0 service bills at ₹0: nobody can type the agreed amount anywhere, so these services go
out free or are billed by hand outside Scribe.

We want the person who adds the service for a patient to enter **that patient's price**, while the
service in the master stays ₹0 and is never changed.

---

## 2. What the code does today

| #   | Today                                                                                                                                                                                                                                      | Where                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| T1  | Doctors and MOs can order **tests only** (lab / machine). The picker reads `giniflow_test_catalog`; there is no way to order a procedure.                                                                                                  | `moStation.js:698-876` `orderTests`, `:655` `getTestPanels`; `consult/TestsSection.jsx` |
| T2  | `service_items.kind = 'procedure'` exists, but `service_items_test_check` ties catalogue links to `kind='test'`, so procedures can never reach the doctor's picker.                                                                        | `migrations/2026-10-08_billing_service_master.sql:68`                                   |
| T3  | A procedure reaches a bill only when the cashier adds it by hand at the counter (`source='added'`).                                                                                                                                        | `counter/AddItems.jsx` → `bills.js addLineIn`                                           |
| T4  | Every bill line is priced from the master (`category_item_rates` → `service_items.base_price`) on every reprice. **No per-line or per-patient price exists anywhere.**                                                                     | `bills.js:425 reprice`, `priceBill.js:513`, `priceLine.js:58-150 lineActual`            |
| T5  | Precedent: the doctor can order a one-off test "for this patient only" with a typed price. It reaches reception's payment (`giniflow_lab_order_tests.price`) but **never the counter bill**; it shows under "Ordered tests with no price". | `TestsSection.jsx:182-196`, `moStation.js:708-744`, `visitLines.js:312-360`             |
| T6  | Desk requests (`billing_requests`) explicitly refuse a price: "the admin sets the price when the item is created".                                                                                                                         | `billingRequests.js:98-106`                                                             |
| T7  | A ₹0 bill can be finalised with nothing collected.                                                                                                                                                                                         | `bills.js finaliseBill` (`payable === 0` allowed)                                       |

---

## 3. Decisions (agreed)

| #   | Question                                 | Decision                                                                                                                                                                                                                |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which services are priced per patient    | A new flag on the service: **"Price decided per patient"**. Set only on the procedures chosen from the OPD sheet (`OPD Billing Master OPD.xlsx`) when it is imported; admins can tick/untick it in Settings → Services. |
| D2  | Who can add such a service for a patient | **Consultant, MO, reception, billing counter.**                                                                                                                                                                         |
| D3  | Is the price required                    | **Yes, for everyone.** A flagged service can never be added without a price, so nothing is ever left unpriced.                                                                                                          |
| D4  | Who can change a price once set          | **Only the person who set it, or an admin**, with a typed reason. Everyone else sees it read-only.                                                                                                                      |
| D5  | Automatic discounts                      | **Apply on top** of the per-patient price, like any other line.                                                                                                                                                         |
| D6  | CGHS / scheme patients                   | **The category rate wins.** If the patient's category has a rate for the service, no ₹ box is asked and any typed price is ignored.                                                                                     |
| D7  | Reception badge                          | **Info badge** on the patient's "On the floor" row: "2 procedures · ₹3,500"; click opens the list (service, price, who set it).                                                                                         |

---

## 4. Design

### 4.1 Schema (one migration)

- `service_items.price_per_patient BOOLEAN NOT NULL DEFAULT FALSE` — the flag (D1). Allowed on non-test kinds only (`procedure`, `other`); a test stays priced by the master and the floor's order flow.
- `bill_lines.agreed_rate NUMERIC(12,2) NULL CHECK (agreed_rate >= 0)`, `agreed_by INT REFERENCES doctors(id)`, `agreed_at TIMESTAMPTZ`.
- New line source `'ordered'` in `bill_lines_source_check` for services added by the consultant / MO / reception (the counter keeps `'added'`).

No change to `giniflow_lab_orders`: procedures stay off the lab and machine queues entirely.

### 4.2 Pricing

`agreed_rate` is threaded through the one pricing path so every reprice keeps it:

1. `LINE_COLUMNS` and `addLineIn` INSERT carry `agreed_rate / agreed_by / agreed_at` (`bills.js`).
2. `reprice` passes `rate: line.agreed_rate` in each line; `priceBill` forwards it in `lineInputs`.
3. `lineActual` (`priceLine.js:96`, today `pick(own_rate, parent_rate, base_price)`) becomes `pick(own_rate, parent_rate, agreed_rate, base_price)`: **the category rate still wins (D6)**, then the patient's price, then the master. New `rate_source: 'agreed'`.
4. Discounts, tax, payment rules and claims run on top unchanged (D5).
5. The draft-save snapshot (`draftSaves.js`) and `restoreSavedIn` carry `agreed_rate`, so Discard restores the price too (see §5 for which lines Discard must leave alone).
6. `'ordered'` is added to `LINE_SOURCES` (`bills.js`) and the source check constraint, and stays out of `DESK_LINE_SOURCES` (`schemas/billing.js`) so the counter can't send it.
7. Credit notes need no change: they copy the finalised line's stored `rate` (`creditNotes.js:247`, `:588`), which already holds the agreed price.

### 4.3 Server endpoints (as built)

| Who                  | Endpoint                                                                                                              | Capability                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Consultant           | `GET/POST /giniflow/stations/doctor/:visitId/services`, `GET …/services/choices?q=`, `POST …/services/:lineId/remove` | read `GINIFLOW_STATION_DOCTOR`; write + `requireOwnVisit` |
| MO                   | same paths under `/giniflow/stations/mo/…`                                                                            | `GINIFLOW_STATION_MO`                                     |
| Reception            | same paths under `/giniflow/stations/reception/…`                                                                     | read `GINIFLOW_STATION_RECEPTION`; write `BILLING_DESK`   |
| Counter              | existing `POST /billing/bills/:billId/lines` accepts `agreed_rate` for flagged items                                  | `BILLING_DESK`                                            |
| Correct a price (D4) | `POST /billing/bills/:billId/lines/:lineId/price {agreed_rate, reason}`                                               | `BILLING_DESK`, and the line's price setter or an admin   |
| Badge data           | `orderedServices {count, total}` on each row of the reception arrivals list                                           | —                                                         |

The reception endpoint uses `BILLING_DESK` (reception, reception admin, admin), not `GINIFLOW_STATION_RECEPTION`, because it writes to a bill; coordinators, who have the station capability but not the desk, can see the badge but not add.

All four "add" paths share one service function: `openDraftIn` + `addLineIn({item_id, source, agreed_rate})`. It
refuses a flagged item without a price (D3) unless the category rate applies (D6), and refuses a price on an
unflagged item. Every add and every correction writes `billing_audit` (who, role, old/new price, reason).

### 4.4 UI

- **Consultant** — `consult/TestsSection.jsx`: a "Procedures" picker next to tests; choosing a flagged item shows a required ₹ box.
- **MO** — `MoStationPage.jsx`: the same picker.
- **Reception** — `ReceptionStationPage.jsx` "On the floor" row: the info badge (D7) and an "+ Add service" action with the required ₹ box.
- **Counter** — `AddItems.jsx` asks for the price when a flagged item is chosen; `BillLinesTable.jsx` shows the agreed price with a "set by" hint and an edit button only for the setter or an admin (D4).
- **Settings → Services** — `ItemDialog.jsx`: a "Price decided per patient" checkbox (non-test items only).

---

## 5. Fit with Save / Discard drafts (billing counter, built 29 Sep)

The counter now keeps a draft **unsaved** until the cashier presses Save draft, quietly throws away an unsaved,
unedited draft when the cashier switches patients, and on Discard puts a saved draft back to its last save.
Services added by the consultant, MO or reception land on that same visit draft, so without changes they
would be lost:

| #   | Gap                                                                                                                                                                                                    | Change                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The cashier has the patient open on an **unsaved** draft; the doctor adds a procedure to it; the cashier switches patients without editing → the draft is quietly discarded and the procedure with it. | Adding an `'ordered'` line **saves the draft** (`markDraftSaved`), the same way taking a payment already does.                                                                                            |
| S2  | Discard on a **saved** draft removes every line added since the last save (`restoreSavedIn` diffs against the snapshot), including a doctor's procedure added meanwhile.                               | `restoreSavedIn` leaves `'ordered'` lines untouched: they are not the cashier's edits. (Floor test lines are re-added by the counter's prefill; procedures have no prefill, so they must not be removed.) |
| S3  | **Delete draft** removes all lines, including doctor-ordered procedures.                                                                                                                               | `deleteDraft` refuses while the draft has `'ordered'` lines: "This draft has procedures ordered by the doctor — they must be removed by whoever ordered them first" (D8).                                 |

## 6. Risks and checks

1. **Every reprice must carry `agreed_rate`** — `releaseOrderLines`, `adoptLabCaseLine`, credit notes (`creditNotes.js`) and the draft restore must not rebuild a line without it. Covered by an e2e test that reprices a bill several ways and checks the price survives.
2. **Finalise guard** — belt and braces: `finaliseBill` refuses a flagged line with no price and no category rate, even though D3 should make that impossible.
3. **CGHS register / claim reports** read `bill_lines.rate`; with D6 the category rate still wins for scheme patients, so claims are unchanged.
4. **Deploy order** — migration first, then API + worker; old code ignores the new columns.
5. **The OPD sheet** is still on hold: this feature needs its list of procedures before anything is flagged (D1).
6. **Category changes after the service is added** (D6): setting a scheme later makes its category rate take over automatically on the next reprice; clearing it falls back to the agreed price. A service added for a scheme patient _without_ a price (allowed by D6) would bill ₹0 if the scheme is later removed — the finalise guard (2) stops that bill, and the counter then asks for the price (the one case where the counter sets a price nobody set, so D4 doesn't block it).
7. **Bill already final** when the doctor orders: `openDraftIn` opens a new draft for the visit, so the procedure goes on a second bill. The info badge and counter list show it; no change needed.
8. **Automatic discounts on top (D5)**: a `fixed_price` line discount rule aimed at a flagged item would override the agreed price. Admins should not aim fixed-price rules at flagged items; the Discounts form can warn.

---

## 7. Decisions added in review (30 Sep)

- **D8** — A procedure added by the consultant, MO or reception can be **removed only by the person who added it, or an admin**, with a typed reason (audited). The counter and reception see such lines without a Remove button. The consultant and MO get a Remove action on their own screens.
- **D9** — **₹0 is a valid price** (a deliberate free procedure). "Price required" (D3) means a value must be typed, which may be 0. The finalise guard checks for a _missing_ price (`agreed_rate IS NULL`), not a zero one.

## 8. Tasks

1. Migration (`service_items.price_per_patient`, `bill_lines.agreed_*`, `'ordered'` source).
2. Pricing thread-through (§4.2) + finalise guard.
3. Shared add/correct/remove service functions + the endpoints in §4.3, with audit (D4, D8, D9); Save/Discard fixes S1–S3.
4. Counter: ask for price on add, show / correct price (D4).
5. Consultant and MO procedure picker.
6. Reception info badge + "Add service".
7. Settings → Services checkbox.
8. E2E specs under `e2e/billing/` (add with price, refused without, scheme patient uses category rate, discount on top, correction by setter vs other user, price survives reprice / save / discard / finalise, doctor's procedure survives the cashier's quiet discard and Discard-to-save, Delete draft refused, removal by adder/admin only, ₹0 accepted and finalises).
9. Import the chosen OPD-sheet procedures with the flag set.

## 9. Review fixes (30 Sep)

- A station order saves the draft only if it was never saved, so the cashier's own unsaved edits can still be discarded.
- The picker decides "price needed" from the category rate the same way pricing does (rate present, parent category, India date); if the server still asks for a price, the box appears.
- Ordering a procedure already on the visit gets a clear message ("already ordered — change its quantity, or remove it and add it again"); billing keeps its one-live-line-per-item rule (`bill_lines_live_item_key`), so a true repeat still needs an admin's repeat approval.
- The counter can't change the quantity of an ordered line unless it added it or is admin (D4/D8).
- Lock order matches Discard (advisory lock before the visit row), avoiding a deadlock.
- An entered price is kept even if the flag is later unticked (the master price is used only when no price was entered).
- Discard restores who set the price, not the person discarding.
- Oversized prices return a clear 400; orders on cancelled / no-show / merged visits are refused.
- Counter shows "Needs this patient's price" for an unpriced flagged line; the doctor's list refreshes every 30 s.

Known limits (accepted): a cashier can cancel an unpaid final bill and re-bill without an ordered line; the badge and lists show what the patient pays (for scheme patients the category share), not the list price.
