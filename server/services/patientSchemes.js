import pool from "../config/db.js";

// The scheme vocabulary, read from patient_schemes rather than the hardcoded
// array shared/patientCategories.js used to be (33-PATIENT-SCHEME-PLAN.md §1).
//
// `code` is the join key every later feature hangs off — scheme_test_prices,
// scheme_opd_fees, the daily cap — so nothing here may rename or delete a code.
// Retiring a scheme flips is_active, which keeps historical appointments
// resolving their label.

const SELECT = `SELECT code, label, color, is_active, requires_ref, daily_cap, sort_order
                  FROM patient_schemes`;

export async function listSchemes({ all = false } = {}, db = pool) {
  const { rows } = await db.query(
    `${SELECT} ${all ? "" : "WHERE is_active"} ORDER BY sort_order, label`,
  );
  return rows.map((r) => ({ ...r, daily_cap: r.daily_cap === null ? null : Number(r.daily_cap) }));
}

// The server's own validator. Reads the table rather than a cached list on
// purpose: a scheme added a minute ago must be accepted by the very next PATCH,
// and a cold cache would reject it (§2).
export async function isKnownScheme(code, db = pool) {
  if (!code) return true; // "" / null is General — the absence of a scheme
  const { rows } = await db.query(`SELECT 1 FROM patient_schemes WHERE code = $1 AND is_active`, [
    code,
  ]);
  return rows.length > 0;
}

const CODE_RE = /^[a-z0-9_]{2,32}$/;

export async function createScheme(input, db = pool) {
  const code = String(input?.code || "")
    .trim()
    .toLowerCase();
  const label = String(input?.label || "").trim();
  if (!CODE_RE.test(code)) {
    throw Object.assign(new Error("Code must be 2–32 characters: a–z, 0–9 and _ only"), {
      status: 400,
    });
  }
  if (!label) throw Object.assign(new Error("A scheme needs a label"), { status: 400 });

  const { rows } = await db
    .query(
      `INSERT INTO patient_schemes (code, label, color, requires_ref, daily_cap, sort_order)
       VALUES ($1,$2,COALESCE($3,'gray'),COALESCE($4,FALSE),$5,COALESCE($6,0))
       RETURNING code, label, color, is_active, requires_ref, daily_cap, sort_order`,
      [
        code,
        label,
        input.color || null,
        input.requires_ref ?? null,
        normalizeCap(input.daily_cap),
        input.sort_order ?? null,
      ],
    )
    .catch((e) => {
      if (e.code === "23505") {
        throw Object.assign(new Error(`A scheme with code "${code}" already exists`), {
          status: 409,
        });
      }
      throw e;
    });
  return rows[0];
}

// A cap of 0 is meaningful — "we are not taking any today" — so only an absent
// or blank value means unlimited.
function normalizeCap(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw Object.assign(new Error("Daily cap must be a whole number, 0 or more"), { status: 400 });
  }
  return n;
}

const EDITABLE = ["label", "color", "is_active", "requires_ref", "daily_cap", "sort_order"];

export async function updateScheme(code, patch, db = pool) {
  const sets = [];
  const vals = [];
  for (const key of EDITABLE) {
    if (!(key in patch)) continue;
    // The code is the join key for prices and caps; renaming it would orphan
    // every row that references it. Retire and re-add instead.
    const value = key === "daily_cap" ? normalizeCap(patch[key]) : patch[key];
    if (key === "label" && !String(value || "").trim()) {
      throw Object.assign(new Error("A scheme needs a label"), { status: 400 });
    }
    vals.push(value);
    sets.push(`${key} = $${vals.length}`);
  }
  if (!sets.length) throw Object.assign(new Error("Nothing to update"), { status: 400 });

  vals.push(code);
  const { rows } = await db.query(
    `UPDATE patient_schemes SET ${sets.join(", ")}, updated_at = NOW()
      WHERE code = $${vals.length}
      RETURNING code, label, color, is_active, requires_ref, daily_cap, sort_order`,
    vals,
  );
  if (!rows.length) throw Object.assign(new Error("Scheme not found"), { status: 404 });
  return rows[0];
}
