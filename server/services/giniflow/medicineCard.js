import pool from "../../config/db.js";
import {
  MED_SLOTS,
  SLOT_ORDER,
  UNSLOTTED,
  WHEN_TO_TAKE_SLOT,
} from "../../../shared/giniflowMedTiming.js";

const slotFor = (entry) => {
  if (SLOT_ORDER.has(entry.timingCategory)) return entry.timingCategory;
  const values = Array.isArray(entry.whenToTake)
    ? entry.whenToTake
    : entry.whenToTake
      ? [entry.whenToTake]
      : [];
  const slots = values
    .map((v) =>
      WHEN_TO_TAKE_SLOT.get(
        String(v || "")
          .trim()
          .toLowerCase(),
      ),
    )
    .filter((k) => SLOT_ORDER.has(k));
  if (!slots.length) return UNSLOTTED.key;
  return slots.sort((a, b) => SLOT_ORDER.get(a) - SLOT_ORDER.get(b))[0];
};

const timeLabel = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
};

export async function buildCard(patientId, db = pool) {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.composition, m.dose, m.previous_dose, m.frequency, m.timing,
            m.timing_category, m.time_of_day::text AS time_of_day, m.external_doctor,
            m.external_specialty, m.external_hospital, m.external_condition, m.interaction_flag,
            m.clinical_note, m.instructions, m.change_type, m.is_new, m.when_to_take,
            m.form, m.route, m.for_diagnosis, m.med_group,
            i.stock_qty, i.reorder_level, i.alternatives
       FROM medications m
       LEFT JOIN pharmacy_inventory i
              ON UPPER(i.medicine_name) = UPPER(COALESCE(m.pharmacy_match, m.name))
      WHERE m.patient_id = $1 AND m.is_active = true
      ORDER BY m.time_of_day NULLS LAST, m.name`,
    [patientId],
  );

  const entries = rows.map((m) => ({
    medicationId: m.id,
    name: m.name,
    composition: m.composition,
    dose: m.dose,
    previousDose: m.previous_dose,
    frequency: m.frequency,
    form: m.form,
    route: m.route,
    forDiagnosis: m.for_diagnosis || [],
    medGroup: m.med_group,
    instruction: m.instructions,
    timing: m.timing,
    timingCategory: m.timing_category,
    timeOfDay: m.time_of_day ? m.time_of_day.slice(0, 5) : null,
    timeLabel: timeLabel(m.time_of_day),
    external: !!m.external_doctor,
    prescriber: m.external_doctor,
    prescriberSpecialty: m.external_specialty,
    prescriberHospital: m.external_hospital,
    condition: m.external_condition,
    interactionFlag: m.interaction_flag,
    note: m.clinical_note,
    changeType: m.change_type || (m.is_new ? "new" : null),
    whenToTake: m.when_to_take || null,
    stock:
      m.stock_qty === null || m.stock_qty === undefined
        ? null
        : {
            qty: m.stock_qty,
            low: m.stock_qty <= (m.reorder_level ?? 0),
            out: m.stock_qty === 0,
            alternatives: m.alternatives || [],
          },
  }));

  const bySlot = new Map();
  for (const entry of entries) {
    const key = slotFor(entry);
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(entry);
  }

  const groups = [...MED_SLOTS, UNSLOTTED]
    .filter((slot) => bySlot.has(slot.key))
    .map((slot) => {
      const meds = bySlot
        .get(slot.key)
        .sort((a, b) => (a.timeOfDay || "").localeCompare(b.timeOfDay || ""));
      return {
        key: slot.key,
        label: slot.label,
        timeLabel: meds.find((m) => m.timeLabel)?.timeLabel || null,
        medicines: meds,
      };
    });

  return {
    patientId,
    groups,
    counts: {
      total: entries.length,
      gini: entries.filter((e) => !e.external).length,
      external: entries.filter((e) => e.external).length,
      unslotted: bySlot.get(UNSLOTTED.key)?.length || 0,
    },
  };
}
