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

| #   | Decision                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Run in parallel with DARPAN** for a cut-over period. Scribe gets an opening stock import from DARPAN, plus a reconciliation report, then the upload is retired.                                                                           |
| D2  | **Extend the existing `bills` system** with a `pharmacy` account. This reuses split payments, cash shifts, dues/pay-later, credit notes, `billing_requests` approvals, `billing_audit`, bill numbering and the PDF builders.                |
| D3  | **Stock is held in the smallest unit** (tablet/ml). Each medicine has a `pack_size`, and the counter can sell whole packs or loose units.                                                                                                   |
| D4  | **The pharmacist picks the batch.** The batch list is sorted by expiry, soonest at the top and latest at the bottom, with the rack shown. There is also an "Auto-fill (earliest expiry first)" button. Expired batches can never be picked. |
| D5  | **IPD sale = GST folded into the rate, 0% GST on the bill.** For example, an OPD sale is ₹100 + 5% GST, and the same item in IPD is ₹105 at 0% GST.                                                                                         |

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

- [ ] P1.1 Vendors
  - Migration, service, routes, Zod schema
  - `/pharmacy/vendors` page (list, search, create/edit dialog, deactivate)
  - Validation: GSTIN/PAN/phone format
  - Spec PH10
- [ ] P1.2 Medicine master
  - Migration, CRUD, search API
  - `/pharmacy/medicines` page (form, pack, HSN, GST preset or custom, schedule, MRP/sale rate, min/max, default rack)
  - Spec PH11
- [ ] P1.3 Seed and link the master: a one-off script `server/scripts/pharmacy-seed-medicines.mjs`
  - Sources: `medicine_db.json` + current `pharmacy_stock_items` + `pharmacy_stock_links`
  - Batched, rerunnable, dry run first (per the bulk-write rules)
- [ ] P1.4 Locations + department stock levels: `/pharmacy/departments` page (admin and pharmacy_admin). Spec PH12.
- [ ] P1.5 Pharmacy settings: price-inclusive flag, near-expiry days, pharmacy GSTIN/drug licence for the bill header.

### P2 — Inventory

- [ ] P2.1 Batches + stock + movement ledger tables, append-only trigger, `stockLedger.js` (`postMovement(client, …)`, the only way stock ever changes).
- [ ] P2.2 Goods receipt
  - `/pharmacy/purchases/new`: vendor, invoice no/date
  - Lines: medicine, batch, expiry, qty + free, purchase rate, MRP, sale rate, GST (5/12/18/custom), discount, rack
  - Draft → Post creates batches and the ledger rows
  - Duplicate invoice guard
  - Spec PH20
- [ ] P2.3 Stock view
  - Rework `/pharmacy/stock` into a batch-level stock list per location: rack, expiry, qty in packs + loose, value
  - Filters: low / over / near-expiry / out
  - Keep the DARPAN upload tab during the parallel run
- [ ] P2.4 Stock adjustments + expiry write-off (reason required, admin only). Spec PH21.
- [ ] P2.5 Opening stock import from the DARPAN batch report
  - Extend `stockParse.js`; Location becomes the rack
  - Preview → commit, the same pattern as `stockUpload.js`
- [ ] P2.6 Keep `pharmacy_inventory` in sync from the new stock (MAIN location) so the doctor screen, pharmacy station queue and "needed in stock" keep working unchanged.

### P3 — Pharmacy billing (POS)

- [ ] P3.1 Billing schema extension
  - `bills.account`, nullable `visit_id`, the new line columns and series
  - **Audit every existing `bills` reader** (dashboard, dues, MIS, reports, counterPatients) and add `account='hospital'` where pharmacy must not appear
  - Run the existing billing e2e suite to confirm nothing changed
- [ ] P3.2 `pharmacyPricing.js` (OPD GST vs IPD folded, loose units, MRP cap), with focused smoke tests.
- [ ] P3.3 Billing service: open draft (visit patient / walk-in / IPD), add line with batch(es), reprice, finalise (lock batches, post `sale` movements, number from `PH`)
  - Reuses `payAndFinalise` + split payments
- [ ] P3.4 `/pharmacy/billing` counter page
  - Patient search + "New walk-in" form
  - Prefill from today's prescription
  - Medicine search with stock
  - Batch picker sorted by expiry with rack + Auto-fill
  - Totals and split payment (reusing `TotalsAndPayment`)
  - Spec PH30
- [ ] P3.5 IPD sale mode (sale_type `ipd`, IPD number field, 0% GST bill print). Spec PH31.
- [ ] P3.6 Pharmacy bill / receipt PDF (pharmacy header, HSN, batch, expiry, GST break-up, H1 prescriber line), reusing `billPdf.js`.
- [ ] P3.7 Link to the pharmacy station: finalising a bill for a visit patient marks `medicine_collections` given/partial and advances the giniflow status. The station card shows a "Bill" action.
- [ ] P3.8 Duration/quantity on `medications` (finalize fix) so the prefill knows quantities.
- [ ] P3.9 Sale return → `PHCN` credit note + `sale_return` movement into the same batch. Spec PH32.

### P4 — Credit

- [ ] P4.1 `credit_sale` request kind + `approveRequest` branch, notification to pharmacy_admin/admin.
- [ ] P4.2 Counter: "Request credit" (amount, reason). The bill is locked while pending; finalise is allowed with partial pay after approval. Spec PH40.
- [ ] P4.3 Approvals inbox for pharmacy_admin (reusing `DeskRequestsInbox` filtered to pharmacy).
- [ ] P4.4 Pharmacy dues
  - Per-patient outstanding, collect later (any mode, reference for UPI/NEFT)
  - Outstanding shown on the patient header and at the counter
  - Spec PH41

### P5 — Department stock & indents

- [ ] P5.1 Transfers MAIN ↔ department (request → approve → issue), ledger `transfer_out/in`. Spec PH50.
- [ ] P5.2 Department stock view and low-level alerts to admin/pharmacy_admin.
- [ ] P5.3 Indent: a department user raises an indent for a patient, which deducts department stock and creates an `indent` pharmacy bill (IPD pricing, pay_later). Spec PH51.
- [ ] P5.4 Reception **Pharmacy bills** tab in `BillingDesk.jsx`
  - List pharmacy dues/indent bills, collect payment
  - Receipts go to `PHR`; payments are tagged to the pharmacy account
  - Cash-shift totals are split by account
  - Spec PH52

### P6 — Alerts & expiry

- [ ] P6.1 `notifications` table, `/api/notifications` (list, mark read), and a bell in `AppLayout.jsx` with an unread count, plus realtime push via `realtimeBus`.
- [ ] P6.2 Event checks after every stock write (low / over max).
- [ ] P6.3 Daily sweep in the **worker** (`services/cron/`, a self-rescheduling `setTimeout`, using `cronPool`): near-expiry / expired batches, department levels, ledger vs cache drift.
- [ ] P6.4 `/pharmacy/expiry` page: batches by expiry bucket (expired / 30 / 60 / 90 days) with vendor and contact, plus "Return to vendor" → vendor return (P6.5).
- [ ] P6.5 Vendor return / replacement flow (`vendor_return` movement, replacement goods receipt linked).

### P7 — Reports & cut-over

- [ ] P7.1 Reports:
  - daily sales by mode/account
  - GST summary by HSN/rate (for filing; IPD folded GST shown separately)
  - stock valuation
  - movement ledger by medicine/batch
  - credit outstanding
  - purchase register by vendor
  - H1 register
  - expiry loss
- [ ] P7.2 Pharmacy dashboard `/pharmacy` (today's sales, dues, alerts, low stock, near expiry). This is the pharmacy_admin home.
- [ ] P7.3 DARPAN reconciliation report (Scribe stock vs latest DARPAN upload per medicine) during the parallel run.
- [ ] P7.4 Billing dashboard: show pharmacy revenue (currently "Not in Scribe" in `dashboardCharges.js`).
- [ ] P7.5 Cut-over checklist, then retire the DARPAN upload (feature flag), and update `docs/PHARMACY_STOCK_PLAN.md` and `README.md`.

---

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
