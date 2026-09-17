import ExcelJS from "exceljs";
import { isLabOnlyDoctor } from "../../../shared/labOnly.js";
import { CONSULTATION_VISIT_TYPES } from "./importColumns.js";

export const CONSULTANT_VISIT_TYPES = CONSULTATION_VISIT_TYPES;
export const RECENT_DAYS = 90;
export const UPCOMING_DAYS = 30;

const PAST = `appointments_last_${RECENT_DAYS}_days`;
const NEXT = `appointments_next_${UPCOMING_DAYS}_days`;

export const CONSULTANT_COLUMNS = [
  { header: "doctor", key: "doctor", width: 30 },
  { header: "visit_type", key: "visit_type", width: 12 },
  { header: "doctor_id", key: "doctor_id", width: 10 },
  { header: "short_name", key: "short_name", width: 18 },
  { header: "specialty", key: "specialty", width: 20 },
  { header: "chief", key: "chief", width: 8 },
  { header: PAST, key: "past", width: 14 },
  { header: NEXT, key: "upcoming", width: 14 },
  { header: "general_fee", key: "general_fee", width: 12 },
  { header: "note", key: "note", width: 60 },
];

export const OTHER_STAFF_COLUMNS = [
  { header: "doctor_id", key: "doctor_id", width: 10 },
  { header: "name", key: "name", width: 30 },
  { header: "role", key: "role", width: 16 },
  { header: PAST, key: "past", width: 14 },
  { header: NEXT, key: "upcoming", width: 14 },
  { header: "note", key: "note", width: 64 },
];

const lower = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase();

export const stripDoctorName = (name) =>
  lower(name)
    .replace(/^dr\.?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

async function readSources(db) {
  const doctors = await db.query(
    `SELECT id, name, short_name, specialty, role, COALESCE(is_chief, FALSE) AS is_chief
       FROM doctors
      WHERE COALESCE(is_active, TRUE)
      ORDER BY name, id`,
  );
  const window = `appointment_date >= CURRENT_DATE - $1::int
                  AND appointment_date <= CURRENT_DATE + $2::int`;
  const counts = `SUM((appointment_date <= CURRENT_DATE)::int)::int AS past,
                  SUM((appointment_date > CURRENT_DATE)::int)::int AS upcoming`;
  const byId = await db.query(
    `SELECT doctor_id, ${counts}
       FROM appointments
      WHERE doctor_id IS NOT NULL AND ${window}
      GROUP BY doctor_id`,
    [RECENT_DAYS, UPCOMING_DAYS],
  );
  const byName = await db.query(
    `SELECT btrim(doctor_name) AS name, ${counts}
       FROM appointments
      WHERE doctor_id IS NULL AND doctor_name IS NOT NULL AND btrim(doctor_name) <> ''
        AND ${window}
      GROUP BY 1`,
    [RECENT_DAYS, UPCOMING_DAYS],
  );
  return { doctors: doctors.rows, byId: byId.rows, byName: byName.rows };
}

export function matchDoctorByName(doctors, name) {
  const exact = doctors.filter((d) => lower(d.name) === lower(name));
  if (exact.length) return exact;
  const needle = stripDoctorName(name);
  if (!needle) return [];
  const stripped = doctors.filter((d) => stripDoctorName(d.name) === needle);
  if (stripped.length) return stripped;
  const short = doctors.filter((d) => d.short_name && stripDoctorName(d.short_name) === needle);
  if (short.length) return short;
  const contains = doctors.filter((d) => {
    const own = stripDoctorName(d.name);
    return own.includes(needle) || needle.includes(own);
  });
  return contains.length === 1 ? contains : [];
}

const isDoctorName = (name) => /^dr\b/i.test(String(name ?? "").trim());

function possibleSamePerson(a, b) {
  if (!isDoctorName(a.name) || !isDoctorName(b.name)) return false;
  const na = stripDoctorName(a.name);
  const nb = stripDoctorName(b.name);
  if (!na || !nb) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (
    longer.startsWith(shorter) &&
    (longer.length - shorter.length <= 2 || longer[shorter.length] === " ")
  )
    return true;
  const sa = stripDoctorName(a.short_name);
  const sb = stripDoctorName(b.short_name);
  return Boolean((sa && (sa === nb || sa === sb)) || (sb && sb === na));
}

export function buildConsultantList({ doctors, byId, byName }) {
  const counts = new Map(doctors.map((d) => [Number(d.id), { past: 0, upcoming: 0 }]));
  const add = (id, row) => {
    const c = counts.get(Number(id));
    if (!c) return;
    c.past += Number(row.past ?? 0);
    c.upcoming += Number(row.upcoming ?? 0);
  };
  for (const row of byId) add(row.doctor_id, row);
  const unmatched = [];
  for (const row of byName) {
    const hits = matchDoctorByName(doctors, row.name);
    if (!hits.length) unmatched.push({ name: row.name, past: Number(row.past ?? 0) });
    for (const d of hits) add(d.id, row);
  }

  const nameUses = new Map();
  for (const d of doctors) nameUses.set(lower(d.name), (nameUses.get(lower(d.name)) ?? 0) + 1);

  const sameAs = (d) =>
    doctors
      .filter((o) => o !== d && lower(o.name) !== lower(d.name) && possibleSamePerson(d, o))
      .map((o) => `${o.name} (id ${o.id}, ${o.role})`);

  const consultants = [];
  const others = [];
  for (const d of doctors) {
    const { past, upcoming } = counts.get(Number(d.id));
    const labOnly = isLabOnlyDoctor(d.name);
    const similar = sameAs(d);
    const notes = [];
    if (nameUses.get(lower(d.name)) > 1)
      notes.push("Name shared with another doctor — use doctor_id in the sheets");
    if (similar.length)
      notes.push(`Possibly the same person as ${similar.join(", ")} — check and keep one`);

    if (d.role === "consultant" && !labOnly) {
      if (past + upcoming === 0)
        notes.push(
          `No appointments in the last ${RECENT_DAYS} or next ${UPCOMING_DAYS} days — check they still consult`,
        );
      notes.push("Enter the General fee for this visit type");
      for (const visitType of CONSULTANT_VISIT_TYPES) {
        consultants.push({
          doctor: d.name,
          visit_type: visitType,
          doctor_id: Number(d.id),
          short_name: d.short_name ?? "",
          specialty: d.specialty ?? "",
          chief: d.is_chief ? "yes" : "no",
          past,
          upcoming,
          general_fee: null,
          note: notes.join(" · "),
        });
      }
      continue;
    }
    if (labOnly) notes.unshift("Lab-only provider for samples-only visits — no consultation fee");
    else if (past + upcoming > 0)
      notes.push(
        "Has appointments — if this person sees patients, add a consultation fee for them too",
      );
    others.push({
      doctor_id: Number(d.id),
      name: d.name,
      role: d.role ?? "",
      past,
      upcoming,
      lab_only: labOnly,
      note: notes.join(" · "),
    });
  }

  consultants.sort(
    (a, b) =>
      a.doctor.localeCompare(b.doctor, "en", { sensitivity: "base" }) ||
      a.doctor_id - b.doctor_id ||
      CONSULTANT_VISIT_TYPES.indexOf(a.visit_type) - CONSULTANT_VISIT_TYPES.indexOf(b.visit_type),
  );
  others.sort(
    (a, b) => b.past + b.upcoming - (a.past + a.upcoming) || a.name.localeCompare(b.name),
  );
  unmatched.sort((a, b) => b.past - a.past);
  return { consultants, others, unmatched };
}

export async function collectConsultantList(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const sources = await readSources(client);
    await client.query("COMMIT");
    return buildConsultantList(sources);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const letter = (count) => String.fromCharCode(64 + count);

function addSheet(workbook, name, columns, rows) {
  const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: "A1", to: `${letter(columns.length)}${Math.max(rows.length, 1) + 1}` };
  for (const row of rows) ws.addRow(row);
  return ws;
}

export async function writeConsultantList({ consultants, others }, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  addSheet(workbook, "Consultants to price", CONSULTANT_COLUMNS, consultants);
  addSheet(workbook, "Other active staff", OTHER_STAFF_COLUMNS, others);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
