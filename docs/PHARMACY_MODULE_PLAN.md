# Pharmacy Management Module — Plan

## Context

Today Scribe has **no money flow for pharmacy**. Billing and stock run in the external DARPAN software; Scribe only has:

- **Stock snapshot upload** — the DARPAN "Item Wise Stock Report" `.xlsx` (`server/services/pharmacy/stock*.js`, `server/routes/pharmacyStock.js`, `src/pages/pharmacy/PharmacyStockPage.jsx`). It stores totals by name in `pharmacy_stock_items` and rolls them into `pharmacy_inventory`. There are no batches, expiry dates, racks or vendors.
- **Pharmacy station** — `/giniflow/station/pharmacy` (`server/services/giniflow/pharmacyStation.js`, `PharmacyStationPage.jsx`, `DispenseCard.jsx`). It only records whether each prescribed medicine was given, not given or partly given (`medicine_collections`, via `services/medication/collection.js`). It also moves the visit through `pharmacy_pending → dispensed → exited`.
- **Supporting pieces:**
  - `pharmacy_medicine_requests` and `pharmacy_needed_orders` ("needed in stock").
  - `pharmacy_inventory.reorder_level`, which nothing sets.
  - `medicine_catalog` and `scheme_medicine_prices`, which nothing uses.

The goal is a production-grade pharmacy inside Scribe:

- vendors, a medicine master, and batch / expiry / rack stock
- pharmacy billing (OPD, IPD, walk-in) with split payment
- credit with approval
- department stores (IPD, OT) with indents billed at reception
- low/over-stock and expiry alerts, and reports

DARPAN keeps running alongside during a cut-over period, then is retired.

### Decisions already made

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Run in parallel with DARPAN** for a cut-over period. Scribe gets an opening stock import from DARPAN, plus a reconciliation report, then the upload is retired.                                                                                                                                                                                                                                                                                                                                                                                      |
| D2  | **Revised at the start of P3 (2026-11-17): separate pharmacy bill tables.** `pharmacy_bills`, `pharmacy_bill_lines` and `pharmacy_payments` reuse the billing _code_ (GST maths `lineTax`, bill numbering `nextNumber`/`bill_series`, payment checks, PDF builders, `billing_audit`) but not the hospital tables. Hospital `bills` is read by ~320 queries in 49 files, many totalling every bill by date, so sharing the table would have meant filtering every hospital report. Cash shifts and reception collection are wired in explicitly (P5.4). |
| D3  | **Stock is held in the smallest unit** (tablet/ml). Each medicine has a `pack_size`, and the counter can sell whole packs or loose units.                                                                                                                                                                                                                                                                                                                                                                                                              |
| D4  | **The pharmacist picks the batch.** The batch list is sorted by expiry, soonest at the top and latest at the bottom, with the rack shown. There is also an "Auto-fill (earliest expiry first)" button. Expired batches can never be picked.                                                                                                                                                                                                                                                                                                            |
| D5  | **IPD sale = GST folded into the rate, 0% GST on the bill.** For example, an OPD sale is ₹100 + 5% GST, and the same item in IPD is ₹105 at 0% GST.                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## What we reuse (do not rebuild)

| Need                                | Existing code                                                                                                                                                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Split payment, receipts, cash shift | `server/services/billing/payments.js` (`cleanPayments`, `takePayments`), `bills.js` `payAndFinalise`, `cash_shifts`                                                                                                                          |
| Partial pay / outstanding balance   | `bills.pay_later`, `server/services/billing/dues.js` (`DUE_OUTSTANDING`, `listDuesRegister`)                                                                                                                                                 |
| Approval workflow                   | `billing_requests` + `server/services/billing/billingRequests.js` (`approveRequest`, `rejectRequest`, `checkPending`), `DeskRequestsInbox.jsx`, `DeskRequestDecisionDialog.jsx`                                                              |
| GST maths (paise, CGST/SGST split)  | `server/services/billing/lineTax.js` `lineTax()`                                                                                                                                                                                             |
| Bill numbers                        | `bill_series` + `billNumber.js` `nextNumber()`                                                                                                                                                                                               |
| Audit trail (append-only)           | `billing_audit` + `audit.js` `writeAudit` / `writeAuditMany`, `transaction.js` `inTransaction`                                                                                                                                               |
| Bill / receipt / credit-note PDF    | `billPdf.js` (`buildBillHtml`, `itemsTableHtml`), `receiptPdf.js`, `amountInWords.js`, `src/components/billing/counter/PdfViewer.jsx`                                                                                                        |
| Counter payment UI                  | `src/components/billing/TotalsAndPayment.jsx`, `PaymentsReceived.jsx`, `useMakeFinal.js`, `src/components/billing/format.js` (`rupees`, `fromPaise`)                                                                                         |
| Walk-in patient → real patient      | `POST /api/patients` with a `GNI-xxxxx` file number. The patient is upgraded automatically on the next HealthRay sync by `matchIdentitylessByPhone` in `server/services/healthray/db.js` `upsertPatient` (phone + name/sex match).           |
| Linking prescriptions to medicines  | `services/medication/normalize.js` `canonicalMedKey`, `pharmacy_stock_links`, `stockMatch.js` `suggestMatches`                                                                                                                               |
| Excel parsing                       | `server/services/pharmacy/stockParse.js` (ExcelJS). Its ignored "Location" column becomes the rack number.                                                                                                                                   |
| Realtime push                       | `server/services/giniflow/realtimeBus.js` + `src/lib/giniflowRealtime.js` (Supabase broadcast)                                                                                                                                               |
| UI primitives                       | `src/components/ui/` (`ConfirmModal`, `SearchBox`, `Pagination`, `FilterPopover`, `Dropdown`, `CustomCalendar`), `Badge.jsx`, `Shimmer.jsx`, `Toast.jsx` `useToast()`; Settings pattern in `SettingsLayout.jsx` + `ServicesSettingsPage.jsx` |
| Route / service / query pattern     | `server/routes/pharmacyStock.js` (`route()` wrapper, `requireCapability`, `validateQuery`), `server/schemas/pharmacyStock.js`, `src/queries/hooks/usePharmacyStock.js`                                                                       |

---

## Data model (new migrations: `server/migrations/2026-11-xx_pharmacy_*.sql`)

**Masters**

- `pharmacy_vendors`
  - Business details: name, contact_person, phone, alt_phone, email, address, city, state, pincode
  - Tax and licences: gstin, pan, drug_license_no, drug_license_expiry
  - Payment: payment_terms_days, bank_name, bank_account, ifsc
  - notes, is_active, created_by/at
- `pharmacy_medicines`
  - Identity: code (unique), name, generic_name/composition, manufacturer, form, strength
  - Units: pack_size (units per pack), unit_label (tab/cap/ml/unit), pack_label (strip/bottle)
  - Tax: hsn_code, gst_rate_pct (5/12/18/0/custom), schedule (`none|H|H1|X|narcotic`)
  - Default prices per pack: default_mrp, default_sale_rate
  - Stock levels and storage: min_stock_units, max_stock_units, reorder_qty_units, default_rack
  - Prescription link: medicine_key (= `canonicalMedKey`, which links prescriptions and `medicine_db.json`)
  - Other: allow_loose_sale, is_active
- `pharmacy_locations` — code (`MAIN`, `IPD`, `OT`, …), name, kind (`main|department`), is_active. Admins manage department locations.
- `pharmacy_location_levels` (location_id, medicine_id, min_units, max_units). Each department has its own stock levels; `MAIN` uses the medicine defaults.

**Stock**

- `pharmacy_purchases` (goods receipt against a vendor invoice)
  - vendor_id, invoice_no, invoice_date, received_at, location_id (=MAIN)
  - status `draft|posted|cancelled`, totals (taxable, gst, discount, net), posted_by
  - unique (vendor_id, invoice_no)
- `pharmacy_purchase_lines`
  - medicine_id, batch_no, mfg_date, expiry_date
  - qty_packs, free_packs, purchase_rate (per pack), mrp (per pack), sale_rate (per pack)
  - gst_rate_pct, discount_pct, rack_no, line totals
- `pharmacy_batches`
  - medicine_id, batch_no, expiry_date
  - Per-unit prices: mrp, purchase_rate, sale_rate
  - gst_rate_pct, rack_no, vendor_id, purchase_line_id
  - unique (medicine_id, batch_no, expiry_date)
  - CHECK `sale_rate <= mrp` (selling above MRP is illegal)
- `pharmacy_stock` (location_id, batch_id) → qty_units with CHECK `>= 0`. This is the current-balance cache and is updated in the same transaction as the ledger.
- `pharmacy_stock_movements` — an **append-only ledger** (trigger, same pattern as `billing_audit`).
  - Columns: location_id, batch_id, delta_units, kind, ref_type/ref_id, actor_id, reason, at.
  - kind is one of: `opening | purchase | sale | sale_return | transfer_out | transfer_in | indent_issue | indent_return | adjustment | expiry_writeoff | vendor_return`.
  - Stock always equals the sum of the ledger; a nightly check compares it with `pharmacy_stock`.
- `pharmacy_stock_adjustments` (physical count, damage, and expiry write-off with a reason). Admin only.
- `pharmacy_vendor_returns` + lines (expired or near-expiry stock sent back for replacement or credit).

**Departments**

- `pharmacy_transfers` + lines: MAIN → department restock, or department → MAIN return. Status `requested|approved|issued|cancelled`.
- `pharmacy_indents` + lines: a department uses stock for a patient.
  - location_id, patient_id, ipd_number (free text, as deposits already do), raised_by, status, bill_id
  - Lines: medicine_id, batch_id, qty_units

**Billing extension (alter existing)**

- `bills`:
  - Add `account TEXT NOT NULL DEFAULT 'hospital' CHECK (account IN ('hospital','pharmacy'))`.
  - Add `sale_type` (`opd|ipd|walkin|indent`) and `pharmacy_location_id`.
  - Make **`visit_id` nullable**, with CHECK `account='pharmacy' OR visit_id IS NOT NULL`.
  - Exempt pharmacy from the one-draft-per-visit unique index.
- `bill_lines`:
  - Make `visit_id` nullable with the same CHECK.
  - Allow source values `pharmacy` and `indent`.
  - Add `pharmacy_medicine_id`, `pharmacy_batch_id`, `qty_units`, `medicine_collection_id`.
- `bill_series`: add `PH` (pharmacy invoice), `PHR` (pharmacy receipt), `PHCN` (pharmacy credit note). Extend `shared/billingVocab.js`.
- `billing_requests.kind`: add `credit_sale`, carrying the approved credit amount.
- `patients`: add `registration_source` (to mark `pharmacy_walkin`).
- `medications`: add `duration` and `quantity_units`, and stop losing duration in `giniflow/finalize.js` `writeMedicines`. This lets a pharmacy bill be prefilled from the prescription.

**Notifications (new, generic)**

- `notifications`
  - Who it is for: role or doctor_id
  - Content: kind, title, body, entity_type/entity_id, severity, dedupe_key (unique while unread)
  - State: read_at, created_at
- First kinds:
  - `stock_low`, `stock_over_max`, `dept_stock_low`
  - `batch_near_expiry` (90/60/30 days), `batch_expired`
  - `credit_request`, `credit_decided`, `transfer_request`

---

## Key business rules

1. **Pricing per line** — a new `server/services/pharmacy/pharmacyPricing.js` that reuses `lineTax()`:
   - **OPD / walk-in:**
     - The rate is `batch.sale_rate`, with GST at `batch.gst_rate_pct`.
     - Whether the rate is tax-exclusive or inclusive is a single pharmacy setting. MRP is inclusive, so the default is "sale rate is pre-GST".
     - The line amount must not go above MRP.
   - **IPD / indent:** `rate = round(sale_rate × (1 + gst%))`, GST 0%, and the line is flagged `gst_folded = true` so reports can still show the hidden GST.
   - Loose unit price = pack rate ÷ pack_size, rounded to paise.
2. **Stock is deducted at finalise, not at draft.** The batch rows are locked `FOR UPDATE` and the quantity is re-checked. A draft only shows what is available.
   - Expired batches are always blocked.
   - Batches expiring within 30 days show a warning that must be confirmed.
3. **Batch picker:** batches with stock at that location, sorted by `expiry_date ASC` (soonest first), each showing rack, expiry, quantity and MRP. "Auto-fill" splits the requested quantity across batches, earliest expiry first.
4. **Credit:**
   - The biller raises a `credit_sale` request with the amount the patient can't pay now. The bill stays as a draft and is blocked until the request is decided.
   - On approval by pharmacy_admin or admin, the bill is finalised with `paid ≥ payable − approved_credit` and `pay_later = true`.
   - The remainder shows in **Pharmacy dues**. The patient can pay at the next visit or remotely (UPI/NEFT, recorded with a reference).
   - The patient header shows the outstanding pharmacy credit.
5. **Department stock** belongs to that location: the main pharmacy sees it but cannot sell from it.
   - Restocking is a transfer from MAIN, which reduces MAIN and increases the department.
   - When a department falls below its min level, an alert goes to the admin.
6. **Indent:**
   - A department user (e.g. nurse/IPD staff) raises an indent for a patient. It deducts from the department location immediately (`indent_issue`).
   - It creates a pharmacy-account bill (`sale_type='indent'`, IPD pricing), finalised with `pay_later`.
   - The bill shows in a new **Pharmacy bills** tab at reception, where it is collected through the normal payment flow under the pharmacy account.
7. **Walk-in patient:**
   - The quick form asks for name, phone (required), age, sex and an optional address.
   - It calls the existing `POST /api/patients` with a GNI number and `registration_source='pharmacy_walkin'`.
   - When the person later books an appointment, the existing HealthRay phone/name match adopts the record, so it never has to be re-entered.
   - A check for an existing patient by phone runs first (`/patients/check-duplicate`).
8. **Sale return:** a credit note on a `PH` bill (reusing the credit-note flow) puts stock back into the **same batch** (`sale_return`). Expired items cannot be returned to stock.
9. **Schedule H1 / X:** the bill must record the prescriber and patient, and these lines feed an H1 register report (a legal requirement).
10. **All writes are audited** with `writeAudit` (masters, purchases, adjustments, transfers, indents, credit decisions). The stock ledger is append-only.

---

## RBAC (`shared/permissions.js` + `server/middleware/auth.js` + `src/config/routes.js`)

New capabilities:

| Capability                | What it covers                                                 |
| ------------------------- | -------------------------------------------------------------- |
| `PHARMACY_MASTER`         | vendors, medicines, locations, levels, settings                |
| `PHARMACY_PURCHASE`       | goods receipt, vendor returns                                  |
| `PHARMACY_STOCK_ADJUST`   | stock adjustments and write-offs                               |
| `PHARMACY_BILL`           | pharmacy billing counter (POS), walk-in patients, sale returns |
| `PHARMACY_CREDIT_REQUEST` | raising a credit request                                       |
| `PHARMACY_CREDIT_APPROVE` | approving or rejecting credit                                  |
| `PHARMACY_DEPT_MANAGE`    | departments, transfers                                         |
| `PHARMACY_INDENT`         | raising indents                                                |
| `PHARMACY_COLLECT`        | reception collecting pharmacy bills                            |
| `PHARMACY_REPORTS`        | pharmacy reports                                               |

- **pharmacy_admin:** all of the above.
- **pharmacy:** BILL, CREDIT_REQUEST and the existing stock view.
- **reception / reception_admin:** COLLECT.
- **nurse (and other department roles):** INDENT.
- **admin:** `*`.

Add longest-prefix route entries under `/api/pharmacy/*` (otherwise `/api/pharmacy` falls back to `MED_COLLECTION`). Add `PAGE_CAPABILITIES` for every new page and nav entries in `AppLayout.jsx` under the `pharmacy` group. Run `verify-rbac.mjs` after each change.

---

## Task breakdown

Each task should be small, then tested (an e2e spec in `e2e/pharmacy/` against the local test DB, or a smoke script), then moved past. Pharmacy users are added to `e2e/fixtures/data.mjs` once, in P0.

### P0 — Foundations

- [x] P0.1 Save this plan as `docs/PHARMACY_MODULE_PLAN.md`; add a numbered doc for each phase as it starts.
- [x] P0.2 RBAC: the capabilities above, role mapping, route prefixes, page caps. Check with `verify-rbac.mjs`.
- [x] P0.3 Add shared pharmacy users (`pharmacy_admin` 9011, `pharmacy` 9012, `nurse` 9013) to the e2e fixtures and the access spec `e2e/pharmacy/PH00-pharmacy-access.spec.js`. `helpers/pharmacy.mjs` builders are added in P1/P2, alongside the tables they insert into.
- [x] P0.4 `shared/pharmacyVocab.js`: movement kinds, statuses, GST presets, schedules, sale types.

### P1 — Masters

- [x] P1.1 Vendors
  - Migration, service, routes, Zod schema
  - `/pharmacy/vendors` page (list, search, create/edit dialog, deactivate)
  - Validation: GSTIN/PAN/phone format
  - Spec PH10
- [x] P1.2 Medicine master
  - Migration, CRUD, search API
  - `/pharmacy/medicines` page (form, pack, HSN, GST preset or custom, schedule, MRP/sale rate, min/max, default rack)
  - Spec PH11
- [x] P1.3 Seed and link the master: a one-off script `server/scripts/pharmacy-seed-medicines.mjs`
  - Sources: `medicine_db.json` + current `pharmacy_stock_items` + `pharmacy_stock_links`
  - Batched, rerunnable, dry run first (per the bulk-write rules)
- [x] P1.4 Locations + department stock levels: `/pharmacy/departments` page (admin and pharmacy_admin). Spec PH12.
- [x] P1.5 Pharmacy settings: price-inclusive flag, near-expiry days, pharmacy GSTIN/drug licence for the bill header.

> P1 notes (built):
>
> - Vendors, medicines and departments share one service (`server/services/pharmacy/masterRecords.js`), one route file (`server/routes/pharmacyMasters.js`), one list page (`src/components/pharmacy/MasterListPage.jsx`) and one dialog frame + form hook (`MasterFormDialog.jsx`, `useMasterForm.jsx`).
> - Medicines imported by `server/scripts/pharmacy-seed-medicines.mjs` (dry run by default, `--apply` to save) are flagged **Needs review**: pack size 1, GST 5% and no HSN are placeholders until the admin opens and saves each one.
> - GSTINs are checked against their check digit (`gstinCheckCharacter`, now in `shared/pharmacyVocab.js`, re-exported by billing).
> - Pharmacy settings left blank fall back to the hospital billing settings on the bill header (answers open question 1 either way).

### P2 — Inventory

- [x] P2.1 Batches + stock + movement ledger tables, append-only trigger, `stockLedger.js` (`postMovement(client, …)`, the only way stock ever changes).
- [x] P2.2 Goods receipt
  - `/pharmacy/purchases/new`: vendor, invoice no/date
  - Lines: medicine, batch, expiry, qty + free, purchase rate, MRP, sale rate, GST (5/12/18/custom), discount, rack
  - Draft → Post creates batches and the ledger rows
  - Duplicate invoice guard
  - Spec PH20
- [x] P2.3 Stock view
  - Rework `/pharmacy/stock` into a batch-level stock list per location: rack, expiry, qty in packs + loose, value
  - Filters: low / over / near-expiry / out
  - Keep the DARPAN upload tab during the parallel run
- [x] P2.4 Stock adjustments + expiry write-off (reason required, admin only). Spec PH21.
- [x] P2.5 Opening stock import from the DARPAN batch report
  - Extend `stockParse.js`; Location becomes the rack
  - Preview → commit, the same pattern as `stockUpload.js`
- [x] P2.6 Keep `pharmacy_inventory` in sync from the new stock (MAIN location) so the doctor screen, pharmacy station queue and "needed in stock" keep working unchanged.

> P2 notes (built):
>
> - `server/services/pharmacy/stockLedger.js` `postMovements` is the only code that changes stock. Increases upsert, decreases use a plain UPDATE (a negative upsert trips the not-negative check before conflict resolution).
> - Batches store prices per pack plus a `pack_size` snapshot, so a later pack-size change on the medicine cannot corrupt stock maths.
> - Opening stock = a goods receipt of kind `opening` (no vendor). DARPAN's item report has no batch/expiry, so opening stock comes from the downloadable Excel template (`/pharmacy/purchases/template.xlsx`), imported into a draft and posted.
> - `pharmacy_settings.stock_source` (`darpan` | `scribe`) decides who feeds `pharmacy_inventory`. Switching rebuilds it in the same transaction; with `scribe`, every movement at the main pharmacy re-syncs the affected medicines. Flipping it is the cut-over.

### P3 — Pharmacy billing (POS)

- [x] P3.1 Pharmacy bill schema (separate tables, see D2)
  - `2027-01-11_pharmacy_row_security.sql`: row-level security on every P1/P2 pharmacy table (they were missing it; every hospital table has it)
  - `2027-01-12_pharmacy_bills.sql`: `pharmacy_bills` (draft → final, credit notes, PH / PHCN numbers, sale_type, gst_folded, visit link, IPD number, prescriber, issued GSTIN / legal name / drug licence snapshot), `pharmacy_bill_lines` (batch snapshot, units, pack MRP / rate, GST or folded GST, MRP cap), `pharmacy_payments` (in / out, PHR receipts), `patients.registration_source`
  - `bill_series` accepts PH / PHR / PHCN (`billSeries.js` `NUMBER_SERIES`); hospital Billing settings still only lists and edits MAIN / RCPT / CN. The pharmacy admin sets the pharmacy series in Pharmacy settings → Number series (shared `components/billing/SeriesCard.jsx`)
- [x] P3.2 `shared/pharmacyPricing.js`: loose units priced from the pack rate, GST on top or inside (setting), MRP cap (inclusive), IPD folds GST into the rate at 0%, bill rounded to the rupee. `pharmacyReturnAmounts` prices returns incrementally so all returns add up to exactly what was charged.
- [x] P3.3 `services/pharmacy/bills.js`: create (reuses an open draft for the same visit), save lines (expired refused, near-expiry needs confirmation, whole packs only when loose sale is off, stock checked), finalise (stock taken with `postMovements` `sale`, PH number, PHR receipt per payment, split payment must equal the total, header snapshot), discard draft. Walk-ins: `billPatients.js` (GNI file number, `registration_source = pharmacy_walkin`, same phone + name reuses the record).
- [x] P3.4 `/pharmacy/billing` list + `/pharmacy/billing/:id` counter (patient search / walk-in, sale type, stock search, batch picker soonest expiry first with rack and auto-fill, split payment, confirmation). Spec PH30.
- [x] P3.5 IPD sale mode. Spec PH31.
- [x] P3.6 Bill / credit note PDF (`services/pharmacy/billPdf.js`, reuses the hospital bill builders): tax invoice vs pharmacy bill, drug licence, HSN, batch, expiry, GST split or folded GST note, H1/X prescriber note, receipts. Spec PH31.
- [x] P3.7 Prefill from today's prescription (`giniflow_rx_items`, matched by `medicine_key`, quantity suggested from frequency × duration only when both are clear, tablets/capsules only) and the station link: a "Pharmacy bill" button on the station pane; finalising marks the billed medicines `given` in `medicine_collections` while the visit is `pharmacy_pending`. Spec PH32.
- [ ] P3.8 Not needed for now: today's prescription items already carry `duration`, so the prefill does not depend on `medications`. Revisit only if bills must be prefilled from older prescriptions.
- [x] P3.9 Sale return → PHCN credit note, refund (`pharmacy_payments` direction `out`), `sale_return` back into the same batch, expired lines refused. Spec PH33.

P3 notes:

- Pharmacy cash is not yet in the hospital cash-shift drawer (`pharmacy_payments.shift_id` stays empty). It is wired in with reception collection in P5.4.
- Line discounts are not in P3; add them with an approval rule if the pharmacy gives discounts.

### P4 — Credit

- [x] P4.1 `2027-01-13_pharmacy_credit.sql`: `pharmacy_credit_requests` (pending → approved / rejected / withdrawn → used; one open request per bill; approved amount ≤ asked ≤ bill total; a refusal needs a reason) and `pharmacy_bills.due_adjusted` (how much of a credit note went against money still due). Service `services/pharmacy/credit.js`, routes `routes/pharmacyCredit.js`. Notifications to approvers wait for the P6 notifications table; until then the Credit page lists what is waiting.
- [x] P4.2 Counter: "Ask for credit" (amount, reason). The draft is locked while the request waits and while an approval stands (withdraw to edit). After approval the bill is finalised with at least bill − approved credit; the rest stays due (`pay_later`). Spec PH40.
- [x] P4.3 `/pharmacy/credit` → Credit requests: approvers (PHARMACY_CREDIT_APPROVE) approve the asked amount or less, or refuse with a reason. Nobody approves their own request. The approver sees the patient's existing pharmacy due.
- [x] P4.4 Dues: `/pharmacy/credit?tab=dues` (oldest first, total outstanding), "Collect due" on the bill (any mode, part payments, PHR receipts, never more than is due). The patient's pharmacy due shows in the patient search and on the bill. A return on a bill with money due clears the due first and refunds only the rest. Specs PH40, PH41.

P4 notes:

- No per-patient credit limit (open question 3); the approver sees the existing due before deciding.
- Reception collecting pharmacy dues is P5.4 (it reuses `collectDue`).

### P5 — Department stock & indents

- [x] P5.1 Transfers (`2027-01-14_pharmacy_transfers_indents.sql`, `services/pharmacy/transfers.js`, `/pharmacy/transfers`): the pharmacy admin moves chosen batches between the main pharmacy and a department, or back. A transfer posts at once (`transfer_out` / `transfer_in`, TRF number); a mistake is undone with a reverse transfer. The separate request → approve step was dropped: departments are restocked by the admin. Expired batches cannot go to a department. Spec PH50, PH51.
- [x] P5.2 Department stock: the Stock page already shows any location with its own min/max levels; the main pharmacy cannot sell from department stock. Low-level alerts come with P6.
- [x] P5.3 Indents (`services/pharmacy/indents.js`, `/pharmacy/indents`): a nurse (PHARMACY_INDENT) picks the department, the patient and batches from that department's stock. It posts `indent_issue` and makes a finalised `indent` pharmacy bill at IPD pricing (GST folded), fully due. IND number. Spec PH50, PH51.
- [x] P5.4 Reception "Pharmacy bills" tab on the billing desk (PHARMACY_COLLECT): pharmacy bills with money due, collected with PHR receipts. Cash needs an open shift. `pharmacy_payments.shift_id` is recorded whenever the person has a shift open; the shift shows pharmacy cash on its own lines, the expected drawer includes it, and the hospital collected totals stay hospital-only (`cashShifts.js`, `staffDashboard.js`, ShiftPanel, ShiftSummary, HandoverSlip). Spec PH50, PH51.

P5 notes:

- Deploy order: `2027-01-12_pharmacy_bills.sql` must run before this code goes live, because the hospital cash-shift queries now read `pharmacy_payments`.
- Returning indented medicines to a department is not built yet (the pharmacist can make a sale return on the indent bill).

### P6 — Alerts & expiry

- [x] P6.1 `2027-01-15_notifications_vendor_returns.sql`: `notifications` (audience is a capability or one person; `dedupe_key` keeps one open alert per condition; `resolved_at` closes it when the condition clears) and `notification_reads` (read per person). `services/notifications.js` (`raiseNotification`, `resolveNotifications`, list / mark read), `/api/notifications` for every signed-in staff member (filtered to the capabilities they hold). Bell with unread count in the header (`components/NotificationBell.jsx`), polled every 60 s; clicking an alert opens the screen it is about.
- [x] P6.2 After every stock write (`postMovements`), and when a min/max is changed, the medicine's level at that location is checked: low / out of stock (PHARMACY_PURCHASE for the main pharmacy, PHARMACY_DEPT_MANAGE for departments) and over the maximum. Credit requests notify approvers; the decision notifies the person who asked.
- [x] P6.3 Worker sweep every 6 h (`services/cron/pharmacyAlertsSweep.js`, cron lock, `PHARMACY_ALERTS=0` turns it off): expired stock on shelves and stock expiring within the alert window (one alert per location), a full recheck of every level, and ledger vs stock drift (critical, PHARMACY_MASTER).
- [x] P6.4 `/pharmacy/expiry`: batches by expiry bucket (expired / 30 / 60 / 90 days) for any location, with rack, vendor and contact. Cost value only for purchase / master users.
- [x] P6.5 Vendor returns (`services/pharmacy/vendorReturns.js`): choose batches on the expiry page → "Return to vendor" (vendor, reason, vendor credit note reference); posts `vendor_return` from the main pharmacy at the batch purchase cost, VRT number. The replacement stock is recorded as a normal goods receipt. Specs PH60, PH61.

P6 notes:

- Department stock must be moved back to the main pharmacy before it is returned to a vendor.
- The bell polls; switching it to the existing realtime bus can come later if a minute's delay matters.

### After P7 — completion pass (2026-11-17)

- Indent returns: a nurse returns unused indent medicines from `/pharmacy/indents` (`POST /pharmacy/indents/:id/returns`); stock goes back to the department as `indent_return` and only the amount still due is reduced. When the bill is already paid the return is refused and goes to the pharmacy, which can refund.
- Review fixes: alert rows locked in one order (no deadlock between two sales); credit approve / withdraw lock the bill before the request (same order as finalise); credit notes are not rounded up and are capped at what is left of the bill, so returns never credit more than was charged; tiny loose quantities give a clear 400; the same new batch posted twice at once no longer fails, and a known batch with a different sale rate is refused; walk-in file numbers retry if another desk took the number; a visit's open draft is reused only for the same sale type; vendor returns refuse a deactivated vendor; dues queries use the outstanding-bill index; the 61–90 day expiry filter stops at 90 days.
- Spec PH80: double-click finalise, stock taken between draft and finalise, expiry / deactivation after saving, racing returns, racing due collection, split returns, indent returns, odd search text, the MIS pharmacy column, and ledger = stock at the end.

### P8 — Discounts, stock list, patient accounts, top items (2026-11-17)

- [x] P8.1 Discounts (migration `2027-01-17`): any pharmacist types a % on each line and/or a % or ₹ on the whole bill when billing; it changes from patient to patient. Line % comes off the line total (after the MRP cap); a bill % applies to every line and a bill ₹ is shared across lines in proportion. GST is worked back out of the discounted amount. Admin sets **Maximum discount %** in Pharmacy settings; the line %, the bill % and the overall effect are each checked against it. The bill PDF shows a Disc column and the bill discount; returns credit the discounted price. Spec PH81.
- [x] P8.2 Stock list tab on `/pharmacy/stock` (`?tab=list`, `GET /pharmacy/batches/list[.xlsx]`): item name, type (TAB, INJ… — this is the "item type / category" asked for), supplier, unit, batch, expiry, MRP, PTR, LP, margin %. LP = PTR less purchase discount, plus GST, spread over free packs (from the latest posted purchase line, else the batch purchase rate); margin % = (MRP − LP) ÷ MRP. Cost columns only for users who can see purchases. Filters, sort on every column, Excel. Spec PH82.
- [x] P8.3 Patient accounts (migration `2027-01-18`): deposits and deposit refunds (pharmacist), paying a bill from the deposit, write-off of a bill's due and manual credit / debit vouchers (pharmacy admin, reason required). `/pharmacy/accounts/:patientId` shows balance, bills with money due and the full statement; `/pharmacy/ledger` lists every patient with S.no, payer, total amount, paid, write-off, deposit, deposit refund, discounts, sales-return vouchers, manual vouchers, due and balance, with search, filters, sorting and totals. Spec PH83.
- [x] P8.4 Top selling items `/pharmacy/reports/top-items` (`GET /pharmacy/reports/top-items[.xlsx]`, PHARMACY_REPORTS): Sr no, item, company, supplier(s), sales qty, return qty, net qty, sale amount, return amount, net amount. "Merge suppliers" gives one row per item; "Split by supplier" gives a row per item and supplier (the batch's vendor). Filters: dates, location, sale type, item type, supplier, search; sort on every column; totals over all pages; Excel. Spec PH84.

### P7 — Reports & cut-over

- [x] P7.1 `services/pharmacy/reports.js`, `/pharmacy/reports` (PHARMACY_REPORTS): daily sales, collections by mode, GST summary by HSN and rate (IPD GST inside the rate on its own rows), purchase register, Schedule H1 / X register, expiry and write-off loss, stock valuation, credit outstanding. Every report downloads as Excel with a total row. The movement history of a batch stays on the Stock page (History).
- [x] P7.2 `/pharmacy/dashboard` "Pharmacy today" (net sales, collected, money due, credit waiting, out of stock / below minimum, expired / expiring batches, latest bills); the pharmacy admin's home page. Spec PH70.
- [x] P7.3 DARPAN reconciliation report: Scribe main-pharmacy units beside the latest DARPAN upload for every linked medicine (Same / Different / only in one system).
- [x] P7.4 Hospital MIS "Pharmacy Charges": stays "Not in Scribe" while the stock source is DARPAN; once it is Scribe the column (screen and Excel) shows Scribe pharmacy sales after returns, labelled "not in net revenue", and hospital net revenue is unchanged. Hidden when the dashboard is filtered by category or consultant.
- [x] P7.5 `docs/PHARMACY_CUTOVER.md`: migration and deploy order, set-up, opening stock count, parallel run with the reconciliation report, the switch (Stock source → Scribe), and how to go back. README has a Pharmacy section.

## Verification

- After each task: run its e2e spec (`npm run test:e2e -- e2e/pharmacy/PHxx-*.spec.js`) against the local test DB (`npm run test:e2e:setup` after each migration). Never run against production.
- After P3.1: run the full billing suite (`npm run test:e2e:billing`) to prove that hospital billing is unchanged.
- After each RBAC change: run `node server/scripts/verify-rbac.mjs`.
- Ledger integrity: a smoke script asserts `pharmacy_stock = SUM(movements)` for every batch/location.
- Manual walkthrough on `npm run dev:client` with the API pointed at the test DB:
  - goods receipt → bill OPD with split payment → credit request/approve → collect due
  - IPD sale prints 0% GST
  - transfer to IPD → indent → collect at reception
  - expiry list + alert bell

## Suggestions (included above or worth adding)

- Hard-block expired batches and enforce MRP as a ceiling (legal).
- Schedule H1 register and prescriber capture (legal for H1 drugs).
- Monthly physical stock count (cycle count) using the adjustment flow.
- Later: barcode scanning on goods receipt and the counter, purchase orders to vendors from "needed in stock", and a UPI payment link via MSG91 for remote credit payment.

## Open questions (can be answered while P0–P2 are built)

1. Does the pharmacy invoice under a **different GSTIN / legal entity / drug licence** than the hospital? This affects the bill header and the GST report.
2. Which roles raise department **indents** (nurse only, or new IPD/OT roles)?
3. Should there be a **per-patient credit limit**, or is credit per request only?
4. Is the OPD sale rate entered **pre-GST or GST-inclusive** (MRP-style)?
