import pool from "../../config/db.js";
import { medicineKey } from "./stockMatch.js";

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

export async function listNeeded({ days = NEEDED_DAYS } = {}, db = pool) {
  const [{ rows: items }, { rows: stock }, { rows: marks }] = await Promise.all([
    db.query(
      `SELECT i.medicine_name, i.pharmacy_match, v.patient_id, v.visit_date::text AS visit_date,
              d.name AS doctor_name, i.visit_id, NULL::uuid AS request_id
         FROM giniflow_rx_items i
         JOIN giniflow_visits v ON v.id = i.visit_id
         LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
        WHERE v.visit_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
          AND v.current_status = ANY($2::text[])
          AND i.change_type = ANY($3::text[])
       UNION ALL
       SELECT r.medicine_name, NULL, r.patient_id,
              (r.requested_at AT TIME ZONE 'Asia/Kolkata')::date::text, d.name, r.visit_id, r.id
         FROM pharmacy_medicine_requests r
         LEFT JOIN doctors d ON d.id = r.requested_by
        WHERE r.requested_at >= NOW() - make_interval(days => $1::int)`,
      [days, PRESCRIBED_STATUSES, DISPENSABLE],
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

  const groups = new Map();
  for (const item of items) {
    const keys = keysFor(item);
    const key = keys[0];
    if (!key) continue;
    const known = keys.find((k) => qtyOf.has(k));
    if (known && qtyOf.get(known) > 0) continue;
    const group = groups.get(key) || {
      medicineKey: key,
      names: new Map(),
      patients: new Set(),
      prescribed: new Set(),
      doctors: new Set(),
      prescriptions: 0,
      lastPrescribed: null,
      status: known ? "out_of_stock" : "not_stocked",
    };
    group.names.set(item.medicine_name, (group.names.get(item.medicine_name) || 0) + 1);
    if (item.patient_id) group.patients.add(item.patient_id);
    if (item.doctor_name) group.doctors.add(item.doctor_name);
    const seen = item.visit_id || item.request_id;
    if (!group.prescribed.has(seen)) {
      group.prescribed.add(seen);
      group.prescriptions += 1;
    }
    if (!group.lastPrescribed || item.visit_date > group.lastPrescribed) {
      group.lastPrescribed = item.visit_date;
    }
    groups.set(key, group);
  }

  return {
    days,
    items: [...groups.values()]
      .map((group) => {
        const mark = markOf.get(group.medicineKey);
        return {
          medicineKey: group.medicineKey,
          medicineName: [...group.names].sort((a, b) => b[1] - a[1])[0][0],
          status: group.status,
          patients: group.patients.size,
          prescriptions: group.prescriptions,
          doctors: [...group.doctors].sort(),
          lastPrescribed: group.lastPrescribed,
          ordered: mark
            ? { at: mark.ordered_at, by: mark.ordered_by_name ?? null, note: mark.note ?? null }
            : null,
        };
      })
      .sort(
        (a, b) =>
          Number(Boolean(a.ordered)) - Number(Boolean(b.ordered)) ||
          b.patients - a.patients ||
          String(b.lastPrescribed).localeCompare(String(a.lastPrescribed)) ||
          a.medicineName.localeCompare(b.medicineName),
      ),
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
