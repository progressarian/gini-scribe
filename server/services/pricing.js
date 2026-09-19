import pool from "../config/db.js";
import { billingVisitTypeSql } from "../../shared/billingVisitType.js";
import { indiaToday } from "./billing/categoryResolver.js";

// ============================================================================
// Scheme pricing (33-PATIENT-SCHEME-PLAN.md §4, rule R3).
//
// One rule: OVERRIDE IF PRESENT, ELSE THE BASE PRICE. The base price of a test
// is its billing service item's price (52-BILLING-PLAN.md §5.1) and, until the
// test has an item, the catalogue price; the override is the category's rate in
// category_item_rates, else its parent category's.
//
// Until the hospital's items and rate card are loaded every call falls through
// to the catalogue price, so prices are exactly what they were before.
//
// Money is NUMERIC in the database and arrives from pg as a string. Nothing
// here does floating-point arithmetic on it: prices are passed through as
// numbers only at the boundary, and the caller sums them with the integer-paise
// helpers in shared/labPayment.js.
// ============================================================================

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Base catalogue price per test, then the scheme's override where it has one.
// Returns a plain { [test_name]: price } the caller can index, because that is
// the shape moStation.js's priceOf already is.
export const catalogBasePriceSql = (alias) =>
  `COALESCE((SELECT i.base_price FROM service_items i
              WHERE i.test_catalog_id = ${alias}.id AND i.is_active), ${alias}.price)`;

const categoryRateSql = (itemExpr, schemeParam, dateParam) => `(
  SELECT r.rate
    FROM patient_schemes s
    LEFT JOIN patient_schemes sp ON sp.code = s.parent_code
    JOIN category_item_rates r
      ON r.scheme_code IN (s.code, s.parent_code) AND r.service_item_id = ${itemExpr}
   WHERE s.code = ${schemeParam} AND r.rate IS NOT NULL
     AND s.is_active AND COALESCE(sp.is_active, TRUE)
     AND r.valid_from <= ${dateParam}::date
     AND (r.valid_to IS NULL OR r.valid_to >= ${dateParam}::date)
   ORDER BY (r.scheme_code = s.code) DESC, r.valid_from DESC
   LIMIT 1)`;

export async function testPricesFor(testNames, schemeCode = null, db = pool, date = indiaToday()) {
  const names = [...new Set((testNames || []).filter(Boolean))];
  if (!names.length) return {};

  const { rows } = await db.query(
    `SELECT c.test_name, COALESCE(i.base_price, c.price) AS base,
            CASE WHEN i.id IS NULL OR $2::text IS NULL THEN NULL
                 ELSE ${categoryRateSql("i.id", "$2", "$3")} END AS scheme
       FROM giniflow_test_catalog c
       LEFT JOIN service_items i ON i.test_catalog_id = c.id AND i.is_active
      WHERE c.test_name = ANY($1::text[])`,
    [names, schemeCode, date],
  );

  const out = {};
  for (const r of rows) out[r.test_name] = num(r.scheme ?? r.base);
  return out;
}

export const consultationRateJoinSql = ({ scheme, doctor, visitType, date }) => `
    LEFT JOIN LATERAL (
      SELECT i.id FROM service_items i
       WHERE i.kind = 'consultation' AND i.is_active
         AND i.visit_type = ${billingVisitTypeSql(visitType)}
         AND (i.doctor_id = ${doctor} OR i.doctor_id IS NULL)
       ORDER BY (i.doctor_id IS NULL), i.id
       LIMIT 1
    ) opd_item ON TRUE
    LEFT JOIN LATERAL (
      SELECT ${categoryRateSql("opd_item.id", scheme, date)} AS rate
    ) opd_fee ON TRUE`;

// Which station each catalogued test belongs to. Separate from the price so the
// caller asks for what it needs — but read from the same row, because a test's
// station and its price are one decision the admin makes in one place
// (36-MACHINE-TEST-STATION-PLAN.md §7 Phase 0).
//
// A name the catalogue does not have is `lab`: that is what a one-off test typed
// in for a single patient is, and it is what every order was before this column
// existed.
export async function testCategoriesFor(testNames, db = pool) {
  const names = [...new Set((testNames || []).filter(Boolean))];
  if (!names.length) return {};
  const { rows } = await db.query(
    `SELECT test_name, category FROM giniflow_test_catalog WHERE test_name = ANY($1::text[])`,
    [names],
  );
  return Object.fromEntries(rows.map((r) => [r.test_name, r.category || "lab"]));
}

// The scheme an order should be priced at: the appointment's tag, snapshotted
// onto the order at creation. Never a live join back to the patient — a card
// corrected next week must not re-price a settled order (plan §4a).
export async function schemeForVisit(visitId, db = pool) {
  if (!visitId) return null;
  const { rows } = await db.query(
    `SELECT a.patient_category AS scheme_code
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0]?.scheme_code || null;
}

export async function testPriceForVisit(visitId, testName, db = pool) {
  const { rows } = await db.query(
    `SELECT test_name FROM giniflow_test_catalog
      WHERE UPPER(test_name) = UPPER($1) AND COALESCE(is_active, TRUE)
      ORDER BY test_name LIMIT 1`,
    [testName],
  );
  if (!rows.length) return null;
  const name = rows[0].test_name;
  const prices = await testPricesFor([name], await schemeForVisit(visitId, db), db);
  return prices[name] ?? null;
}
