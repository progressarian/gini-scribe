# Pharmacy cut-over: DARPAN → Scribe

The pharmacy module (`docs/PHARMACY_MODULE_PLAN.md`) runs beside DARPAN until the pharmacy admin
switches **Pharmacy settings → Stock source** to Scribe. This is the checklist for that day and
the days around it. Nothing here deletes DARPAN data; switching back is one setting.

## 1. Before deploying the code

Run the migrations on production **in this order**, before the new API and worker go live. The
hospital cash-shift screens read `pharmacy_payments` from the moment the code is deployed.

| Order | File                                          | What it adds                                                    |
| ----- | --------------------------------------------- | --------------------------------------------------------------- |
| 1     | `2027-01-03_pharmacy_vendors.sql`             | Vendors                                                         |
| 2     | `2027-01-04_pharmacy_medicines.sql`           | Medicine master                                                 |
| 3     | `2027-01-05_pharmacy_locations.sql`           | Main pharmacy + departments, department levels                  |
| 4     | `2027-01-06_pharmacy_settings.sql`            | Pharmacy settings                                               |
| 5     | `2027-01-07_pharmacy_stock_ledger.sql`        | Batches, stock, movement history                                |
| 6     | `2027-01-08_pharmacy_purchases.sql`           | Goods receipts                                                  |
| 7     | `2027-01-09_pharmacy_adjustments.sql`         | Stock adjustments                                               |
| 8     | `2027-01-10_pharmacy_stock_source.sql`        | DARPAN / Scribe switch                                          |
| 9     | `2027-01-11_pharmacy_row_security.sql`        | Row-level security on the tables above                          |
| 10    | `2027-01-12_pharmacy_bills.sql`               | Pharmacy bills, lines, payments; `patients.registration_source` |
| 11    | `2027-01-13_pharmacy_credit.sql`              | Credit requests, dues on returns                                |
| 12    | `2027-01-14_pharmacy_transfers_indents.sql`   | Transfers, indents                                              |
| 13    | `2027-01-15_notifications_vendor_returns.sql` | Notifications, vendor returns                                   |
| 14    | `2027-01-16_pharmacy_credit_limit.sql`        | Credit limit setting                                            |
| 15    | `2027-01-17_pharmacy_discounts.sql`           | Line and bill discounts, maximum discount setting               |
| 16    | `2027-01-18_pharmacy_patient_accounts.sql`    | Patient deposits, write-offs, manual vouchers                   |
| 17    | `2027-01-19_notifications_role_audience.sql`  | Pharmacy alerts go to the pharmacy admin role only              |
| 18    | `2027-01-20_pharmacy_bill_rx_outcomes.sql`    | First version of per-line outcomes (replaced by 19)             |
| 19    | `2027-01-21_pharmacy_bill_med_outcomes.sql`   | Per-medicine outcomes keyed by `medications`; drops 18 if empty |
| 20    | `2027-01-22_pharmacy_needed_reasons.sql`      | Note on not-given outcomes; reason/note/qty/date/source on medicine requests for the sheet import |

```bash
cd server
node migrations/_runOne.mjs migrations/2027-01-03_pharmacy_vendors.sql   # …and so on, one at a time
```

Check after each one that it finished without an error. Every file is safe to run twice.

## 2. Set-up (can be done days before)

- [ ] **Pharmacy settings**: legal name, GSTIN, drug licence number, address, phone, bill
      footer, near-expiry warning days, expiry alert days. Leave Stock source on **DARPAN**.
- [ ] **Sale rate rule** in settings: whether the sale rate entered on receipts already includes
      GST. Decide once; bills keep the rule they were made with.
- [ ] **Credit limit per patient** in settings (blank means no limit).
- [ ] **Maximum discount %** in settings: the most any pharmacist can give on a line or a
      bill (blank means no cap).
- [ ] **Number series** (Pharmacy settings → Number series) for this financial year:
      PH (bills), PHR (receipts), PHCN (credit notes). Billing refuses until PH and PHR exist.
- [ ] **Vendors** entered (GSTIN, drug licence, phone).
- [ ] **Medicine master** seeded from DARPAN and the formulary (bulk-write rules apply):
      `bash
node server/scripts/pharmacy-seed-medicines.mjs            # dry run, prints counts
node server/scripts/pharmacy-seed-medicines.mjs --apply    # writes in batches of 100
`
      Then review the medicines marked **Needs review** (pack size, unit, HSN, GST, schedule).
- [ ] **Min / max stock** on the medicines that matter, so low-stock alerts mean something.
- [ ] **Departments** (IPD, OT, …) and their own min / max levels.
- [ ] **People**: pharmacy admin, pharmacists, nurses who raise indents, reception who collect.
      Check each can open the screens they need (`node server/scripts/verify-rbac.mjs`).

## 3. Opening stock (the count day)

- [ ] Pick a quiet time. Freeze DARPAN sales for the count, or count shelf by shelf and note
      sales made during the count.
- [ ] Goods Receipts → **Opening stock** → **Download template**. Fill one row per batch:
      batch, expiry, quantity in packs, MRP and sale rate per pack, purchase rate, rack.
- [ ] **Import from Excel** into the opening-stock receipt. Fix every row the import report
      skips, re-import, then **Post**.
- [ ] Department stock: post it at the main pharmacy, then **Stock Transfers** to each
      department (or count each department separately into its own transfer).

## 4. Parallel run (about one to two weeks)

- [ ] Keep uploading the DARPAN Item Wise report daily.
- [ ] Bill from Scribe at the counter. If DARPAN must also record the sale, enter it there too.
- [ ] Each day open **Pharmacy Reports → DARPAN reconciliation**. Work the "Different" rows:
      a wrong pack size, a missing link, or a sale recorded in one system only.
- [ ] Check **Stock** for "Below minimum" and **Expiry** for expired stock still on the shelf.
- [ ] Check the bell: no "Stock does not match its history" alert (that one goes to the
      Scribe team).

## 5. Switch-over

- [ ] Reconciliation differences explained or fixed.
- [ ] Pharmacy settings → **Stock source → Scribe** (asks for confirmation). Doctors, the Rx
      desk and the pharmacy station now see Scribe stock, updated with every sale, receipt,
      transfer and return.
- [ ] Stop billing in DARPAN. Stop the daily DARPAN upload; the DARPAN report tab stays for
      looking back.
- [ ] Hospital billing dashboard: the "Pharmacy Charges" column now shows Scribe pharmacy sales
      (marked "not in net revenue"). Before the switch it says "Not in Scribe".

## 6. Going back

If the switch has to be undone: Pharmacy settings → Stock source → **DARPAN**, upload today's
DARPAN report, and carry on in DARPAN. Pharmacy bills, payments and stock history already in
Scribe stay as they are.
