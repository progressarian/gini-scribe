import pool from "../config/db.js";

// ============================================================================
// Scheme pricing (33-PATIENT-SCHEME-PLAN.md §4, rule R3).
//
// One rule, three domains: OVERRIDE IF PRESENT, ELSE THE BASE PRICE. Schemes
// differ on some items, not all, so the override tables stay small and adding a
// scheme does not mean re-entering the whole tariff.
//
// Every override table is empty today — the hospital's rate card has not landed
// — which means every call falls through to the base price and prices are
// exactly what they were before this file existed. That is the intended state
// until real rates arrive, and it is what makes this safe to ship early.
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
export async function testPricesFor(testNames, schemeCode = null, db = pool) {
  const names = [...new Set((testNames || []).filter(Boolean))];
  if (!names.length) return {};

  const { rows } = await db.query(
    `SELECT c.test_name, c.price AS base, c.category, s.price AS scheme
       FROM giniflow_test_catalog c
       LEFT JOIN scheme_test_prices s
              ON s.test_name = c.test_name AND s.scheme_code = $2
      WHERE c.test_name = ANY($1::text[])`,
    [names, schemeCode],
  );

  const out = {};
  for (const r of rows) out[r.test_name] = num(r.scheme ?? r.base);
  return out;
}

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

// What one OPD consultation should cost. Display only — HealthRay raises the
// bill and Gini cannot write to it (plan D3) — so this answers "what should the
// desk key in", never "what was charged".
//
// A row with this doctor wins over the scheme's default for the visit type,
// which is why the ORDER BY puts a non-null doctor_id first.
export async function opdFeeFor({ schemeCode, doctorId = null, visitType }, db = pool) {
  if (!schemeCode || !visitType) return null;
  const { rows } = await db.query(
    `SELECT fee, doctor_id FROM scheme_opd_fees
      WHERE scheme_code = $1
        AND visit_type = $2
        AND (doctor_id IS NULL OR doctor_id = $3)
      ORDER BY doctor_id NULLS LAST
      LIMIT 1`,
    [schemeCode, visitType, doctorId],
  );
  return rows.length ? num(rows[0].fee) : null;
}

// Medicines. `null` is a real answer here and means "we have no price for this",
// which is the honest state for most of the catalogue: 9,964 medicines have been
// prescribed and the tariff fills by volume, top 200 first (plan D6). A caller
// showing money must render "no rate" rather than ₹0.
export async function medicinePricesFor(names, schemeCode = null, db = pool) {
  const wanted = [...new Set((names || []).filter(Boolean).map((n) => n.toUpperCase()))];
  if (!wanted.length) return {};

  const { rows } = await db.query(
    `SELECT m.name, m.price AS base, m.source, s.price AS scheme
       FROM medicine_catalog m
       LEFT JOIN scheme_medicine_prices s
              ON UPPER(s.medicine_name) = m.name AND s.scheme_code = $2
      WHERE m.name = ANY($1::text[]) AND m.is_active`,
    [wanted, schemeCode],
  );

  const out = {};
  for (const r of rows) {
    const price = r.scheme ?? r.base;
    out[r.name] = {
      price: num(price),
      // Says WHY there is no number, so the counter is told rather than shown a
      // zero it might believe.
      priced: price !== null && price !== undefined,
      source: r.scheme != null ? `scheme:${schemeCode}` : r.source,
    };
  }
  // A medicine nobody has catalogued at all is not an error — it is the normal
  // case until the tariff fills.
  for (const n of wanted)
    if (!out[n]) out[n] = { price: null, priced: false, source: "uncatalogued" };
  return out;
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
