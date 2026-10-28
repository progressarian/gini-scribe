import pool from "../../config/db.js";
import { stripFormPrefix, canonicalMedKey } from "../medication/normalize.js";
import { SLOT_ORDER, whenToTakeFor } from "../../../shared/giniflowMedTiming.js";

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
  composition, dose, previous_dose, frequency, timing, timing_category, timing_categories,
  time_of_day::text AS time_of_day, route, form, duration, reason,
  patient_instruction, change_type, stop_reason, resume_on::text AS resume_on,
  drug_class, sort_order,
  proposed_by, approval_status, decided_by, decided_at, decision_note,
  (SELECT COALESCE(d.short_name, d.name) FROM doctors d WHERE d.id = proposed_by) AS proposed_by_name`;

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
      `SELECT ${ITEM_COLUMNS},
              EXISTS (SELECT 1 FROM pharmacy_medicine_requests r
                       WHERE r.visit_id = giniflow_rx_items.visit_id
                         AND UPPER(BTRIM(r.medicine_name)) = UPPER(BTRIM(giniflow_rx_items.medicine_name))
                     ) AS typed_by_doctor
         FROM giniflow_rx_items WHERE visit_id = $1 ORDER BY sort_order, created_at`,
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
    db.query(
      `SELECT max(COALESCE(updated_at, created_at))::date::text AS last_updated
         FROM medications WHERE patient_id = $1`,
      [visit[0].patient_id],
    ),
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
    started: items.length > 0,
  };
}

export const SEEDED_SLOTS = `COALESCE(
  (SELECT ARRAY_AGG(k) FROM (
     SELECT CASE lower(btrim(w::text))
              WHEN 'fasting' THEN 'fasting'
              WHEN 'before breakfast' THEN 'before_breakfast'
              WHEN 'after breakfast' THEN 'after_breakfast'
              WHEN 'before lunch' THEN 'before_lunch'
              WHEN 'after lunch' THEN 'after_lunch'
              WHEN 'before dinner' THEN 'before_dinner'
              WHEN 'after dinner' THEN 'after_dinner'
              WHEN 'at bedtime' THEN 'bedtime'
              WHEN 'sos only' THEN 'sos'
              WHEN 'any time' THEN 'any_time'
            END AS k
       FROM unnest(COALESCE(m.when_to_take, '{}')) w) t
    WHERE k IS NOT NULL),
  CASE WHEN m.timing_category IS NOT NULL THEN ARRAY[m.timing_category] END
)`;

export async function seedDraftOn(client, visitId) {
  const { rows: existing } = await client.query(
    `SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`,
    [visitId],
  );
  if (existing[0].n > 0) return { seeded: 0, reason: "draft already started" };

  const { rows } = await client.query(
    `INSERT INTO giniflow_rx_items
         (visit_id, source_medication_id, medicine_name, pharmacy_match, composition, dose,
          frequency, timing, timing_category, timing_categories, time_of_day, route, form,
          drug_class, reason, change_type, sort_order)
       SELECT $1, m.id, m.name, m.pharmacy_match, m.composition, m.dose,
              m.frequency, m.timing, m.timing_category, ${SEEDED_SLOTS},
              m.time_of_day, m.route, m.form,
              m.drug_class, m.clinical_note, 'continued',
              row_number() OVER (ORDER BY m.med_group NULLS LAST, m.name)
         FROM medications m
         JOIN giniflow_visits v ON v.id = $1
        WHERE m.patient_id = v.patient_id AND m.is_active = true AND m.external_doctor IS NULL
       RETURNING id`,
    [visitId],
  );
  return { seeded: rows.length };
}

// The standalone entry, unchanged from outside: the route still calls this.
export async function seedDraftFromRegimen(visitId, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await seedDraftOn(client, visitId);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export const orderSlots = (slots) =>
  [...new Set((slots || []).filter((s) => SLOT_ORDER.has(s)))].sort(
    (a, b) => SLOT_ORDER.get(a) - SLOT_ORDER.get(b),
  );

const normaliseItem = (item) => {
  const { name: cleanName, form: detectedForm } = stripFormPrefix(item.medicineName || "");
  const name = cleanName || item.medicineName;
  const slots = orderSlots(
    item.timingCategories?.length ? item.timingCategories : [item.timingCategory],
  );
  const primary = slots[0] ?? item.timingCategory ?? null;
  return {
    name,
    pharmacyMatch: item.pharmacyMatch || canonicalMedKey(name) || null,
    form: item.form || detectedForm || null,
    timingCategory: primary,
    timingCategories: slots.length ? slots : null,
    timeOfDay: item.timeOfDay || null,
  };
};

export async function decideItem(itemId, { status, note = null }, actorId = null, db = pool) {
  if (!["approved", "adjusted", "rejected"].includes(status)) {
    throw Object.assign(new Error(`Unknown decision: ${status}`), { status: 400 });
  }
  if (status === "rejected" && !note) {
    throw Object.assign(new Error("Rejecting a proposal needs a reason"), { status: 400 });
  }

  const { rows } = await db.query(
    `SELECT id, visit_id, source_medication_id, approval_status
       FROM giniflow_rx_items WHERE id = $1`,
    [itemId],
  );
  if (!rows.length) throw Object.assign(new Error("Row not found"), { status: 404 });
  if (!rows[0].approval_status) {
    throw Object.assign(new Error("This row is not a proposal"), { status: 409 });
  }

  // A rejected addition leaves nothing behind — the patient was not on it.
  if (status === "rejected" && !rows[0].source_medication_id) {
    await db.query(`DELETE FROM giniflow_rx_items WHERE id = $1`, [itemId]);
    return { decided: status, removed: true };
  }

  const { rows: updated } = await db.query(
    `UPDATE giniflow_rx_items
        SET approval_status = $2, decided_by = $3, decided_at = NOW(),
            decision_note = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING ${ITEM_COLUMNS}`,
    [itemId, status, actorId, note],
  );
  return updated[0];
}

export async function addItem(visitId, item, db = pool) {
  const n = normaliseItem(item);
  const proposedBy = item.proposedBy ?? null;
  const approvalStatus = proposedBy ? "pending" : null;

  const { rows: clash } = await db.query(
    `SELECT id, medicine_name, change_type FROM giniflow_rx_items
      WHERE visit_id = $1 AND change_type <> 'stopped'
        AND UPPER(COALESCE(pharmacy_match, medicine_name)) = UPPER($2)
      LIMIT 1`,
    [visitId, n.pharmacyMatch || n.name],
  );
  if (clash.length) {
    throw Object.assign(
      new Error(
        `${clash[0].medicine_name} is already in this prescription — edit that row instead`,
      ),
      { status: 409, existingItemId: clash[0].id },
    );
  }

  const { rows } = await db.query(
    `INSERT INTO giniflow_rx_items
       (visit_id, source_medication_id, medicine_name, pharmacy_match, composition, dose,
        previous_dose, frequency, timing, timing_category, timing_categories, time_of_day,
        route, form, duration, reason, patient_instruction, change_type, drug_class,
        proposed_by, approval_status, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$21::text[],$11::time,$12,$13,$14,$15,$16,$17,$18,$19,$20,
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
      n.timingCategory,
      n.timeOfDay,
      item.route ?? "Oral",
      n.form,
      item.duration ?? null,
      item.reason ?? null,
      item.patientInstruction ?? null,
      item.changeType ?? "new",
      item.drugClass ?? null,
      proposedBy,
      approvalStatus,
      n.timingCategories,
    ],
  );
  return rows[0];
}

export async function updateItem(itemId, patch, db = pool) {
  const slots = orderSlots(
    patch.timingCategories?.length ? patch.timingCategories : [patch.timingCategory],
  );
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
            timing_categories = COALESCE($12::text[], timing_categories),
            time_of_day = COALESCE($5::time, time_of_day),
            duration = COALESCE($6, duration),
            reason = COALESCE($7, reason),
            patient_instruction = COALESCE($8, patient_instruction),
            route = COALESCE($10, route),
            form = COALESCE($13, form),
            -- Editing a pending proposal IS the "Adjust" decision (addendum
            -- v1.1 §3): the doctor changed it and kept it, which is not the same
            -- as approving it as proposed. A row that was never a proposal is
            -- untouched here.
            approval_status = CASE
              WHEN approval_status = 'pending' THEN 'adjusted' ELSE approval_status END,
            decided_by = CASE
              WHEN approval_status = 'pending' THEN $11 ELSE decided_by END,
            decided_at = CASE
              WHEN approval_status = 'pending' THEN NOW() ELSE decided_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ITEM_COLUMNS}`,
    [
      itemId,
      patch.dose ?? null,
      patch.frequency ?? null,
      slots[0] ?? patch.timingCategory ?? null,
      patch.timeOfDay ?? null,
      patch.duration ?? null,
      patch.reason ?? null,
      patch.patientInstruction ?? null,
      patch.changeType ?? null,
      patch.route ?? null,
      patch.actorId ?? null,
      slots.length ? slots : null,
      patch.form || null,
    ],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return rows[0];
}

export async function removeItem(itemId, db = pool) {
  const { rows } = await db.query(
    `DELETE FROM giniflow_rx_items WHERE id = $1 RETURNING id, source_medication_id`,
    [itemId],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return { removed: rows[0].id };
}

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

export async function resumeItem(itemId, db = pool) {
  const { rows } = await db.query(
    `UPDATE giniflow_rx_items
        SET change_type = 'continued', resume_on = NULL, stop_reason = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
    [itemId],
  );
  if (!rows.length) throw Object.assign(new Error("Draft row not found"), { status: 404 });
  return rows[0];
}

const DOSAGE_FORM =
  /^(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|inj|injection|syp|syr|syrup|susp|suspension|drop|drops|oint|ointment|gel|cream|sachet)\.?$/i;

export async function searchMedicines(query, db = pool) {
  const q = (query || "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  while (words.length && DOSAGE_FORM.test(words[0])) words.shift();
  const core = words.join(" ");
  if (core.length < 2) return [];
  const term = core.replace(/[%_\\]/g, "\\$&");

  const { rows } = await db.query(
    `WITH prescribed AS (
       -- Grouped on the canonical dispensing key, not the raw name.
       --
       -- medications is 181,703 rows in 34,105 spellings, and a search for
       -- "atc" returned twelve of them for one drug: Atchol, Atchol 20,
       -- Atchol 20mg, Atchol-F, ATCHOL 10 TAB, plus the typos Atcol, Atcholf
       -- and Atcohol. Every one is a real prescription, so none can be deleted,
       -- but they are one medicine and the picker should say so.
       --
       -- pharmacy_match already collapses them — 12 spellings behind ATCHOL,
       -- 11 behind ATCHOL F — because canonicalMedKey strips the TAB/CAP/INJ
       -- prefix and the case. It is null on roughly half the table, so the name
       -- is the fallback and those rows behave exactly as they did before.
       --
       -- The spelling shown is the one prescribed most often, and the count is
       -- the whole group: "Atchol · 3,373×" rather than twelve rows summing to
       -- the same thing.
       SELECT DISTINCT ON (grp) name, composition, drug_class, uses
         FROM (
           SELECT UPPER(COALESCE(NULLIF(BTRIM(m.pharmacy_match), ''), m.name)) AS grp,
                  m.name, m.composition, m.drug_class, m.updated_at,
                  count(*) OVER (
                    PARTITION BY UPPER(COALESCE(NULLIF(BTRIM(m.pharmacy_match), ''), m.name))
                  ) AS uses,
                  count(*) OVER (
                    PARTITION BY UPPER(COALESCE(NULLIF(BTRIM(m.pharmacy_match), ''), m.name)), m.name
                  ) AS spelling_uses
             FROM medications m
            -- Only the name is searched. pharmacy_match is derived FROM the
            -- name, so it can never match a term the name misses — checked
            -- across several terms, zero such rows — and the extra OR widened
            -- the scan for nothing.
            WHERE m.name ILIKE '%' || $1 || '%'
         ) g
        ORDER BY grp, spelling_uses DESC, updated_at DESC NULLS LAST
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
      stock: stock
        ? { qty: stock.stock_qty, price: stock.price_per_unit, out: stock.stock_qty === 0 }
        : null,
    };
  });
}

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

export async function removeExternal(patientId, medicationId, db = pool) {
  const { rows } = await db.query(
    `UPDATE medications
        SET is_active = false, stopped_date = CURRENT_DATE,
            stop_reason = 'Removed from the medicines typed by doctor', updated_at = NOW()
      WHERE id = $1 AND patient_id = $2 AND is_active = true AND external_doctor IS NOT NULL
      RETURNING id, name`,
    [medicationId, patientId],
  );
  if (!rows[0]) {
    throw Object.assign(new Error("This medicine was already removed or is not a typed medicine"), {
      status: 404,
    });
  }
  return rows[0];
}

export async function addExternal(patientId, med, db = pool) {
  const { name: cleanName, form: detectedForm } = stripFormPrefix(med.medicineName || "");
  const name = cleanName || med.medicineName;
  const form = med.form || detectedForm;
  const slots = orderSlots(
    med.timingCategories?.length ? med.timingCategories : [med.timingCategory],
  );
  const whenToTake = whenToTakeFor(slots);
  const { rows } = await db.query(
    `INSERT INTO medications
       (patient_id, name, pharmacy_match, composition, dose, frequency, timing,
        timing_category, when_to_take, time_of_day, form, external_doctor, med_group,
        interaction_flag, started_date, is_active, is_new, external_specialty,
        external_hospital, external_condition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$17::when_to_take_pill[],$9::time,$10,$11,'external',
             $12,$13,true,false,$14,$15,$16)
     ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
     DO UPDATE SET dose = EXCLUDED.dose, frequency = EXCLUDED.frequency,
                   timing = EXCLUDED.timing, timing_category = EXCLUDED.timing_category,
                   when_to_take = COALESCE(EXCLUDED.when_to_take, medications.when_to_take),
                   time_of_day = EXCLUDED.time_of_day,
                   form = COALESCE(EXCLUDED.form, medications.form),
                   external_doctor = EXCLUDED.external_doctor,
                   external_specialty = EXCLUDED.external_specialty,
                   external_hospital = EXCLUDED.external_hospital,
                   external_condition = EXCLUDED.external_condition,
                   interaction_flag = EXCLUDED.interaction_flag, updated_at = NOW()
     RETURNING id, name, dose, external_doctor`,
    [
      patientId,
      name,
      canonicalMedKey(name) || null,
      med.composition ?? null,
      med.dose ?? null,
      med.frequency ?? null,
      med.timing ?? null,
      slots[0] ?? med.timingCategory ?? null,
      med.timeOfDay || null,
      form,
      med.prescriberName,

      med.interactionFlag ?? null,
      med.sinceDate || null,

      med.prescriberSpecialty ?? null,
      med.prescriberHospital ?? null,
      med.condition ?? null,
      whenToTake.length ? whenToTake : null,
    ],
  );
  return rows[0];
}
