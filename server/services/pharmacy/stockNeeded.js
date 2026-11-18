import pool from "../../config/db.js";
import { medicineKey } from "./stockMatch.js";
import { resolveNotifications } from "../notifications.js";
import { NEEDED_REASON_LABEL, notGivenReasonOf } from "../../../shared/pharmacyVocab.js";

export const NEEDED_DAYS = 30;
const PRESCRIBED_STATUSES = [
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
  "exited",
];
const DISPENSABLE = ["continued", "changed", "new"];

const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const keysFor = (item) =>
  [
    medicineKey(item.pharmacy_match || item.medicine_name),
    medicineKey(item.medicine_name),
    String(item.pharmacy_match || "")
      .trim()
      .toUpperCase(),
    String(item.medicine_name || "")
      .trim()
      .toUpperCase(),
  ].filter(Boolean);

export { NEEDED_REASON_LABEL };

const SYSTEM_NOTES = /^(On bill|Substitute |Requested; patient will collect later)/;

const dayKey = (row) => `${row.patient_id}|${row.key}|${row.on_date}`;

export async function listNeeded({ days = NEEDED_DAYS, reason = null, q = null } = {}, db = pool) {
  const [
    { rows: prescribed },
    { rows: notGiven },
    { rows: requests },
    { rows: stock },
    { rows: marks },
  ] = await Promise.all([
    db.query(
      `SELECT i.medicine_name, i.pharmacy_match, v.patient_id, v.visit_date::text AS on_date,
                d.name AS doctor_name, i.visit_id::text AS seen
           FROM giniflow_rx_items i
           JOIN giniflow_visits v ON v.id = i.visit_id
           LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
          WHERE v.visit_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
            AND v.current_status = ANY($2::text[])
            AND i.change_type = ANY($3::text[])`,
      [days, PRESCRIBED_STATUSES, DISPENSABLE],
    ),
    db.query(
      `SELECT m.name AS medicine_name, m.pharmacy_match, mc.patient_id,
                mc.collected_date::text AS on_date, mc.reason, mc.qty_note AS note,
                m.prescriber AS doctor_name, mc.id::text AS seen
           FROM medicine_collections mc
           JOIN medications m ON m.id = mc.medication_id
          WHERE mc.status IN ('not_given', 'partial')
            AND mc.collected_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int`,
      [days],
    ),
    db.query(
      `SELECT r.medicine_name, NULL AS pharmacy_match, r.patient_id, r.source, r.reason, r.note,
                r.qty_units,
                COALESCE(r.needed_on, (r.requested_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS on_date,
                d.name AS doctor_name, r.id::text AS seen
           FROM pharmacy_medicine_requests r
           LEFT JOIN doctors d ON d.id = r.requested_by
          WHERE COALESCE(r.needed_on, (r.requested_at AT TIME ZONE 'Asia/Kolkata')::date)
                >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int`,
      [days],
    ),
    db.query(`SELECT UPPER(medicine_name) AS key, stock_qty FROM pharmacy_inventory`),
    db.query(
      `SELECT o.medicine_key, o.note, o.ordered_at, d.name AS ordered_by_name
           FROM pharmacy_needed_orders o LEFT JOIN doctors d ON d.id = o.ordered_by
          WHERE o.ordered_at >= NOW() - make_interval(days => $1::int)`,
      [days],
    ),
  ]);
  const qtyOf = new Map(stock.map((row) => [row.key, Number(row.stock_qty) || 0]));
  const markOf = new Map(marks.map((row) => [row.medicine_key, row]));
  const stockOf = (keys) => {
    const known = keys.find((k) => qtyOf.has(k));
    return !known ? "not_stocked" : qtyOf.get(known) > 0 ? "in_stock" : "out_of_stock";
  };

  const entries = [];
  const withKey = (item) => {
    const keys = keysFor(item);
    return keys[0] ? { ...item, keys, key: keys[0], stock: stockOf(keys) } : null;
  };
  for (const item of prescribed.map(withKey).filter(Boolean)) {
    if (item.stock !== "in_stock") entries.push({ ...item, reason: "prescribed" });
  }
  const marked = new Set();
  for (const item of notGiven.map(withKey).filter(Boolean)) {
    marked.add(dayKey(item));
    const { reason: code, note } = notGivenReasonOf(item.reason);
    entries.push({ ...item, reason: code, note: item.note || note });
  }
  for (const item of requests.map(withKey).filter(Boolean)) {
    if (item.source === "import") {
      entries.push({ ...item, reason: item.reason || "imported" });
    } else if (item.stock !== "in_stock" && !marked.has(dayKey(item))) {
      entries.push({ ...item, reason: "requested" });
    }
  }

  const search = q ? String(q).trim().toUpperCase() : "";
  const shown = entries.filter(
    (e) =>
      (!reason || e.reason === reason) &&
      (!search || String(e.medicine_name).toUpperCase().includes(search)),
  );

  const groups = new Map();
  const byReason = {};
  const allPatients = new Set();
  for (const item of shown) {
    byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    if (item.patient_id) allPatients.add(item.patient_id);
    const group = groups.get(item.key) || {
      medicineKey: item.key,
      names: new Map(),
      patients: new Set(),
      seen: new Set(),
      doctors: new Set(),
      reasons: {},
      notes: [],
      qtyUnits: 0,
      lastDate: null,
      status: item.stock,
    };
    group.names.set(item.medicine_name, (group.names.get(item.medicine_name) || 0) + 1);
    if (item.patient_id) group.patients.add(item.patient_id);
    if (item.doctor_name) group.doctors.add(item.doctor_name);
    group.seen.add(`${item.reason}|${item.seen}`);
    group.reasons[item.reason] = (group.reasons[item.reason] || 0) + 1;
    if (item.note && !SYSTEM_NOTES.test(item.note)) {
      group.notes.push({ text: item.note, date: item.on_date });
    }
    if (item.qty_units) group.qtyUnits += Number(item.qty_units);
    if (!group.lastDate || item.on_date > group.lastDate) group.lastDate = item.on_date;
    groups.set(item.key, group);
  }

  const items = [...groups.values()]
    .map((group) => {
      const mark = markOf.get(group.medicineKey);
      const notes = [];
      for (const note of group.notes.sort((a, b) => b.date.localeCompare(a.date))) {
        if (!notes.some((n) => n.text === note.text)) notes.push(note);
      }
      return {
        medicineKey: group.medicineKey,
        medicineName: [...group.names].sort((a, b) => b[1] - a[1])[0][0],
        status: group.status,
        times: group.seen.size,
        patients: group.patients.size,
        prescriptions: group.seen.size,
        reasons: group.reasons,
        notes: notes.slice(0, 5),
        qtyUnits: group.qtyUnits || null,
        doctors: [...group.doctors].sort(),
        lastPrescribed: group.lastDate,
        ordered: mark
          ? { at: mark.ordered_at, by: mark.ordered_by_name ?? null, note: mark.note ?? null }
          : null,
      };
    })
    .sort(
      (a, b) =>
        Number(Boolean(a.ordered)) - Number(Boolean(b.ordered)) ||
        b.times - a.times ||
        b.patients - a.patients ||
        String(b.lastPrescribed).localeCompare(String(a.lastPrescribed)) ||
        a.medicineName.localeCompare(b.medicineName),
    );

  return {
    days,
    summary: {
      medicines: items.length,
      times: shown.length,
      patients: allPatients.size,
      byReason,
    },
    items,
  };
}

export async function requestMedicine({ medicineName, visitId = null }, actorId, db = pool) {
  const name = String(medicineName || "").trim();
  const key = medicineKey(name) || name.toUpperCase();
  if (!name || !key) throw badRequest("Type the medicine name");
  const { rows } = await db.query(
    `INSERT INTO pharmacy_medicine_requests (medicine_key, medicine_name, visit_id, patient_id, requested_by)
     SELECT $1, $2, v.id, v.patient_id, $4
       FROM (SELECT $3::uuid AS wanted) w
       LEFT JOIN giniflow_visits v ON v.id = w.wanted
     ON CONFLICT (visit_id, medicine_key) WHERE visit_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [key, name, visitId, actorId],
  );
  return { medicineKey: key, medicineName: name, recorded: rows.length > 0 };
}

export async function markOrdered(
  { medicineKey: key, medicineName, note = null },
  actorId,
  db = pool,
) {
  const cleanKey = String(key || "").trim();
  const cleanName = String(medicineName || "").trim();
  if (!cleanKey || !cleanName) throw badRequest("Choose the medicine to mark as ordered");
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  const { rows } = await db.query(
    `INSERT INTO pharmacy_needed_orders (medicine_key, medicine_name, note, ordered_at, ordered_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (medicine_key) DO UPDATE
       SET medicine_name = EXCLUDED.medicine_name, note = EXCLUDED.note,
           ordered_at = NOW(), ordered_by = EXCLUDED.ordered_by
     RETURNING medicine_key, ordered_at`,
    [cleanKey, cleanName, cleanNote, actorId],
  );
  await resolveNotifications(db, `pharmacy:needed:${cleanKey}`);
  return { medicineKey: rows[0].medicine_key, orderedAt: rows[0].ordered_at };
}

export async function clearOrdered(key, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM pharmacy_needed_orders WHERE medicine_key = $1`,
    [String(key || "").trim()],
  );
  if (!rowCount) throw notFound("That medicine was not marked as ordered");
  return { medicineKey: key, cleared: true };
}
