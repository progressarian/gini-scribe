import pool from "../../config/db.js";
import { stripFormPrefix, canonicalMedKey } from "../medication/normalize.js";

// The consultant's prescription draft — gini-doctor-final.html `s-rx`.
//
// docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md
//
// Nothing here touches `medications`. The draft lives in giniflow_rx_items until
// Finalize, so a consultation interrupted halfway is never dispensable and never
// reaches the patient's app.

// The 13 timing values the prototype offers, machine-readable. The card groups
// on these; the patient reads the free-text `timing`.
export const TIMING_CATEGORIES = [
  "before_breakfast",
  "with_breakfast",
  "after_breakfast",
  "before_lunch",
  "with_lunch",
  "after_lunch",
  "evening",
  "before_dinner",
  "with_dinner",
  "after_dinner",
  "bedtime",
  "with_meals",
  "sos",
  "weekly",
  "fortnightly",
];

export const CHANGE_TYPES = ["continued", "changed", "new", "stopped", "paused"];

// The clock time each timing slot means, when the consultant does not set one.
// A card that says "with lunch" and a card that says "1:30 PM" are the same
// instruction; the patient reads the second one better.
const DEFAULT_TIME = {
  before_breakfast: "07:30",
  with_breakfast: "08:00",
  after_breakfast: "08:30",
  before_lunch: "13:00",
  with_lunch: "13:30",
  after_lunch: "14:00",
  evening: "17:00",
  before_dinner: "19:30",
  with_dinner: "20:00",
  after_dinner: "21:00",
  bedtime: "22:00",
  with_meals: "08:00",
};

export const defaultTimeFor = (category) => DEFAULT_TIME[category] || null;

const ITEM_COLUMNS = `id, visit_id, source_medication_id, medicine_name, pharmacy_match,
  composition, dose, previous_dose, frequency, timing, timing_category,
  time_of_day::text AS time_of_day, route, form, duration, reason,
  patient_instruction, change_type, stop_reason, resume_on::text AS resume_on,
  drug_class, sort_order`;

// Stock is joined, never assumed. A medicine with no inventory row comes back
// with `stock: null`, which the screen renders as "Stock —" (plan §7).
const withStock = async (items, db) => {
  if (!items.length) return items;
  const names = items.map((i) => i.pharmacy_match || i.medicine_name);
  const { rows } = await db.query(
    `SELECT medicine_name, stock_qty, reorder_level, price_per_unit, drug_class, alternatives
       FROM pharmacy_inventory
      WHERE UPPER(medicine_name) = ANY($1::text[])`,
    [names.map((n) => n.toUpperCase())],
  );
  const byName = new Map(rows.map((r) => [r.medicine_name.toUpperCase(), r]));
  return items.map((i) => {
    const stock = byName.get((i.pharmacy_match || i.medicine_name).toUpperCase()) || null;
    return {
      ...i,
      stock: stock
        ? {
            qty: stock.stock_qty,
            reorderLevel: stock.reorder_level,
            price: stock.price_per_unit,
            low: stock.stock_qty != null && stock.stock_qty <= (stock.reorder_level ?? 0),
            out: stock.stock_qty === 0,
          }
        : null,
    };
  });
};

// The draft, plus the patient's currently active medicines so the screen can
// show what is being continued rather than making the consultant retype it.
export async function getDraft(visitId, db = pool) {
  const { rows: visit } = await db.query(
    `SELECT patient_id, current_status FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  if (!visit.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

  const [
    { rows: items },
    { rows: active },
    { rows: external },
    { rows: lastUpdatedRows },
    { rows: stoppedRows },
  ] = await Promise.all([
    db.query(
      `SELECT ${ITEM_COLUMNS} FROM giniflow_rx_items WHERE visit_id = $1 ORDER BY sort_order, created_at`,
      [visitId],
    ),
    db.query(
      `SELECT id, name, pharmacy_match, composition, dose, frequency, timing, timing_category,
              time_of_day::text AS time_of_day, route, form, drug_class, clinical_note,
              med_group, when_to_take
         FROM medications
        WHERE patient_id = $1 AND is_active = true AND external_doctor IS NULL
        ORDER BY med_group NULLS LAST, name`,
      [visit[0].patient_id],
    ),
    // Other doctors' prescriptions. Shown, interaction-flagged, never dispensable.
    db.query(
      `SELECT id, name, composition, dose, frequency, timing, timing_category,
              time_of_day::text AS time_of_day, external_doctor, clinical_note,
              started_date::text AS since_date, notes
         FROM medications
        WHERE patient_id = $1 AND is_active = true AND external_doctor IS NOT NULL
        ORDER BY name`,
      [visit[0].patient_id],
    ),
    // The two the prototype puts in the section header. "Last updated" is when
    // this patient's regimen last changed — a consultant reads it to know
    // whether they are looking at last week's decisions or last year's.
    db.query(
      `SELECT max(COALESCE(updated_at, created_at))::date::text AS last_updated
         FROM medications WHERE patient_id = $1`,
      [visit[0].patient_id],
    ),
    // Stopped medicines, most recent first: asked for often enough that the
    // prototype gives it a button, because "why is he not on X any more" is a
    // question with a real answer.
    db.query(
      `SELECT name AS medicine_name, stopped_date::text AS stopped_on, stop_reason, prescriber
         FROM medications
        WHERE patient_id = $1 AND is_active = false
        ORDER BY stopped_date DESC NULLS LAST LIMIT 12`,
      [visit[0].patient_id],
    ),
  ]);

  return {
    patientId: visit[0].patient_id,
    items: await withStock(items, db),
    activeMedications: await withStock(
      active.map((m) => ({ ...m, medicine_name: m.name })),
      db,
    ),
    external,
    lastUpdated: lastUpdatedRows[0]?.last_updated || null,
    stopped: stoppedRows,
    // A draft that has not been started yet is not the same as an empty
    // prescription — the screen offers to seed it from the active regimen.
    started: items.length > 0,
  };
}

// Seeds the draft from what the patient is already taking, every row marked
// `continued`. The consultant then changes the two or three that need changing,
// rather than retyping nine medicines — which is how medicines get dropped.
export async function seedDraftFromRegimen(visitId, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      `SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`,
      [visitId],
    );
    if (existing[0].n > 0) {
      await client.query("ROLLBACK");
      return { seeded: 0, reason: "draft already started" };
    }
    const { rows } = await client.query(
      `INSERT INTO giniflow_rx_items
         (visit_id, source_medication_id, medicine_name, pharmacy_match, composition, dose,
          frequency, timing, timing_category, time_of_day, route, form, drug_class,
          reason, change_type, sort_order)
       SELECT $1, m.id, m.name, m.pharmacy_match, m.composition, m.dose,
              m.frequency, m.timing, m.timing_category, m.time_of_day, m.route, m.form,
              m.drug_class, m.clinical_note, 'continued',
              row_number() OVER (ORDER BY m.med_group NULLS LAST, m.name)
         FROM medications m
         JOIN giniflow_visits v ON v.id = $1
        WHERE m.patient_id = v.patient_id AND m.is_active = true AND m.external_doctor IS NULL
       RETURNING id`,
      [visitId],
    );
    await client.query("COMMIT");
    return { seeded: rows.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const normaliseItem = (item) => {
  const { name: cleanName, form: detectedForm } = stripFormPrefix(item.medicineName || "");
  const name = cleanName || item.medicineName;
  return {
    name,
    pharmacyMatch: item.pharmacyMatch || canonicalMedKey(name) || null,
    form: item.form || detectedForm || null,
    timeOfDay: item.timeOfDay || defaultTimeFor(item.timingCategory),
  };
};

export async function addItem(visitId, item, db = pool) {
  const n = normaliseItem(item);
  const { rows } = await db.query(
    `INSERT INTO giniflow_rx_items
       (visit_id, source_medication_id, medicine_name, pharmacy_match, composition, dose,
        previous_dose, frequency, timing, timing_category, time_of_day, route, form,
        duration, reason, patient_instruction, change_type, drug_class, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::time,$12,$13,$14,$15,$16,$17,$18,
             COALESCE((SELECT MAX(sort_order) + 1 FROM giniflow_rx_items WHERE visit_id = $1), 1))
     RETURNING ${ITEM_COLUMNS}`,
    [
      visitId,
      item.sourceMedicationId ?? null,
      n.name,
      n.pharmacyMatch,
      item.composition ?? null,
      item.dose ?? null,
      item.previousDose ?? null,
      item.frequency ?? null,
      item.timing ?? null,
      item.timingCategory ?? null,
      n.timeOfDay,
      item.route ?? "Oral",
      n.form,
      item.duration ?? null,
      item.reason ?? null,
      item.patientInstruction ?? null,
      item.changeType ?? "new",
      item.drugClass ?? null,
    ],
  );
  return rows[0];
}

export async function updateItem(itemId, patch, db = pool) {
  // A dose change is a clinical event, not an edit: the row remembers what it
  // was changed from so the pharmacy's counselling note and the card's "↑
  // Changed" chip have something to say.
  const { rows } = await db.query(
    `UPDATE giniflow_rx_items
        SET dose = COALESCE($2, dose),
            previous_dose = CASE
              WHEN $2 IS NOT NULL AND $2 IS DISTINCT FROM dose AND change_type = 'continued'
                THEN dose ELSE previous_dose END,
            change_type = CASE
              WHEN $2 IS NOT NULL AND $2 IS DISTINCT FROM dose AND change_type = 'continued'
                THEN 'changed' ELSE COALESCE($9, change_type) END,
            frequency = COALESCE($3, frequency),
            timing_category = COALESCE($4, timing_category),
            time_of_day = COALESCE($5::time, time_of_day),
            duration = COALESCE($6, duration),
            reason = COALESCE($7, reason),
            patient_instruction = COALESCE($8, patient_instruction),
            route = COALESCE($10, route),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ITEM_COLUMNS}`,
    [
      itemId,
      patch.dose ?? null,
      patch.frequency ?? null,
      patch.timingCategory ?? null,
      patch.timeOfDay ?? null,
      patch.duration ?? null,
      patch.reason ?? null,
      patch.patientInstruction ?? null,
      patch.changeType ?? null,
      patch.route ?? null,
    ],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return rows[0];
}

// Removing a row the consultant added by mistake. A medicine the patient is
// actually taking is stopped, not removed — see stopItem.
export async function removeItem(itemId, db = pool) {
  const { rows } = await db.query(
    `DELETE FROM giniflow_rx_items WHERE id = $1 RETURNING id, source_medication_id`,
    [itemId],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return { removed: rows[0].id };
}

// Pause and stop are different clinical acts and the schema already knows it:
// pause keeps the medicine with a resume date, stop ends it with a reason.
export async function pauseItem(itemId, weeks, db = pool) {
  const { rows } = await db.query(
    `UPDATE giniflow_rx_items
        SET change_type = 'paused', resume_on = CURRENT_DATE + ($2::int * 7), updated_at = NOW()
      WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
    [itemId, weeks],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return rows[0];
}

export async function stopItem(itemId, reason, db = pool) {
  if (!reason || !reason.trim()) {
    throw Object.assign(new Error("Stopping a medicine needs a reason"), { status: 400 });
  }
  const { rows } = await db.query(
    `UPDATE giniflow_rx_items
        SET change_type = 'stopped', stop_reason = $2, updated_at = NOW()
      WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
    [itemId, reason.trim()],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return rows[0];
}

// Medicine search.
//
// PLAN CORRECTION. The plan said to reuse `src/medmatch.js` and its ~6,900-brand
// `medicine_db.json`. That module cannot run here: it imports `src/lib/medName`
// without a file extension, which Vite resolves and Node does not, so importing
// it server-side throws ERR_MODULE_NOT_FOUND. Rather than rewrite a working
// browser module to satisfy a server caller, search reads what the database
// already knows, ranked so the most useful answers come first:
//
//   1. what this hospital has actually prescribed before (`medications`) — the
//      real formulary, with the brand spellings the pharmacy recognises
//   2. the curated `drug_master` brand list
//   3. `mhg_drug_formulary`, which carries molecule and route
//
// Stock is joined on top wherever it is known.
export async function searchMedicines(query, db = pool) {
  const q = (query || "").trim();
  if (q.length < 2) return [];
  const term = q.replace(/[%_\\]/g, "\\$&");

  const { rows } = await db.query(
    `WITH prescribed AS (
       SELECT DISTINCT ON (UPPER(m.name))
              m.name, m.composition, m.drug_class, count(*) OVER (PARTITION BY UPPER(m.name)) AS uses
         FROM medications m
        WHERE m.name ILIKE '%' || $1 || '%'
        ORDER BY UPPER(m.name), m.updated_at DESC NULLS LAST
     ),
     master AS (
       SELECT unnest(COALESCE(brand_names, ARRAY[generic_name])) AS name,
              generic_name AS composition, drug_class, 0::bigint AS uses
         FROM drug_master
        WHERE generic_name ILIKE '%' || $1 || '%'
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(brand_names, '{}')) b WHERE b ILIKE '%' || $1 || '%')
     ),
     formulary AS (
       SELECT brand AS name, molecule AS composition, drug_class, 0::bigint AS uses
         FROM mhg_drug_formulary
        WHERE brand ILIKE '%' || $1 || '%' OR molecule ILIKE '%' || $1 || '%'
     ),
     all_hits AS (
       SELECT * FROM prescribed UNION ALL SELECT * FROM master UNION ALL SELECT * FROM formulary
     ),
     deduped AS (
       SELECT DISTINCT ON (UPPER(name)) name, composition, drug_class, uses
         FROM all_hits
        WHERE name IS NOT NULL AND length(trim(name)) > 1
        ORDER BY UPPER(name), uses DESC
     )
     -- Rank BEFORE the limit. Ordering by name and then cutting at 40 dropped
     -- the obvious answer: a search for "metfor" lost "Metformin" itself behind
     -- forty alphabetically earlier combination brands.
     SELECT name, composition, drug_class, uses
       FROM deduped
      ORDER BY CASE
                 WHEN LOWER(name) = LOWER($2) THEN 0
                 WHEN LOWER(name) LIKE LOWER($2) || '%' THEN 1
                 ELSE 2
               END,
               uses DESC,
               length(name)
      LIMIT 24`,
    [term, q],
  );

  const ranked = rows.map((r) => ({ ...r, name: r.name.trim() })).slice(0, 12);

  const { rows: stockRows } = await db.query(
    `SELECT medicine_name, stock_qty, price_per_unit, drug_class
       FROM pharmacy_inventory WHERE UPPER(medicine_name) = ANY($1::text[])`,
    [ranked.map((r) => r.name.toUpperCase())],
  );
  const byName = new Map(stockRows.map((r) => [r.medicine_name.toUpperCase(), r]));

  return ranked.map((r) => {
    const stock = byName.get(r.name.toUpperCase()) || null;
    return {
      name: r.name,
      composition: r.composition || null,
      drugClass: r.drug_class || stock?.drug_class || null,
      timesPrescribed: Number(r.uses) || 0,
      // null means "no inventory row", which the screen must render as
      // "Stock —" and never as in stock (plan §7).
      stock: stock
        ? { qty: stock.stock_qty, price: stock.price_per_unit, out: stock.stock_qty === 0 }
        : null,
    };
  });
}

// Same-class substitutes that are actually in stock. Returns an empty list when
// the inventory is unknown — an empty alternatives modal is honest, a fabricated
// one sends the patient to a counter that cannot serve them.
export async function alternativesFor(medicineName, db = pool) {
  const { rows } = await db.query(
    `SELECT drug_class, alternatives FROM pharmacy_inventory
      WHERE UPPER(medicine_name) = UPPER($1)`,
    [medicineName],
  );
  if (!rows.length) return { known: false, alternatives: [] };

  const { rows: alts } = await db.query(
    `SELECT medicine_name, stock_qty, price_per_unit
       FROM pharmacy_inventory
      WHERE (UPPER(medicine_name) = ANY($1::text[])
             OR ($2::text IS NOT NULL AND drug_class = $2))
        AND UPPER(medicine_name) <> UPPER($3)
        AND COALESCE(stock_qty, 0) > 0
      ORDER BY stock_qty DESC LIMIT 8`,
    [(rows[0].alternatives || []).map((a) => a.toUpperCase()), rows[0].drug_class, medicineName],
  );
  return {
    known: true,
    alternatives: alts.map((a) => ({
      name: a.medicine_name,
      qty: a.stock_qty,
      price: a.price_per_unit,
    })),
  };
}

// A medicine from another doctor. Written straight to `medications` rather than
// to the draft: it is not something Gini is prescribing, it is something the
// patient is already taking, and the interaction check needs it visible now.
export async function addExternal(patientId, med, db = pool) {
  const { name: cleanName, form } = stripFormPrefix(med.medicineName || "");
  const name = cleanName || med.medicineName;
  const { rows } = await db.query(
    `INSERT INTO medications
       (patient_id, name, pharmacy_match, composition, dose, frequency, timing,
        timing_category, time_of_day, form, external_doctor, med_group, clinical_note,
        started_date, is_active, is_new, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::time,$10,$11,'external',$12,$13,true,false,$14)
     ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
     DO UPDATE SET dose = EXCLUDED.dose, frequency = EXCLUDED.frequency,
                   timing = EXCLUDED.timing, timing_category = EXCLUDED.timing_category,
                   time_of_day = EXCLUDED.time_of_day,
                   external_doctor = EXCLUDED.external_doctor,
                   clinical_note = EXCLUDED.clinical_note, updated_at = NOW()
     RETURNING id, name, dose, external_doctor`,
    [
      patientId,
      name,
      canonicalMedKey(name) || null,
      med.composition ?? null,
      med.dose ?? null,
      med.frequency ?? null,
      med.timing ?? null,
      med.timingCategory ?? null,
      med.timeOfDay || defaultTimeFor(med.timingCategory),
      form,
      med.prescriberName,
      // The interaction flag is written by a human, never generated. An
      // unchecked pair must look unchecked: rendering "✓ no interaction" for a
      // pair nobody has checked is the most dangerous thing this screen could do.
      med.interactionFlag ?? null,
      med.sinceDate || null,
      [med.prescriberSpecialty, med.prescriberHospital].filter(Boolean).join(" · ") || null,
    ],
  );
  return rows[0];
}
