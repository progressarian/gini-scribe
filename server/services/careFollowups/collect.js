import crypto from "node:crypto";
import pool from "../../config/db.js";
import { referralsFromNote } from "../healthray/noteSections.js";
import { ACTIVE_STATUSES, REFERRAL_KINDS } from "../../../shared/careFollowups.js";
import { loadCatalog, matchReferral, personOf } from "./match.js";
import { markDeskBookedAtGhm } from "./deskReferral.js";

const BATCH = 100;
const IST_DATE = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

export async function followupsSince(db = pool) {
  const { rows } = await db.query(`SELECT value FROM app_kv WHERE key = 'care_followups_since'`);
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

const shortHash = (text) =>
  crypto
    .createHash("sha1")
    .update(text.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);

const DOCTOR_IN_TEXT =
  /\bdr\.?\s+([a-z][a-z0-9.]*(?:\s+[a-z][a-z0-9.]*){0,3}?)(?=\s*(?:\(|,|;|$|\bfor\b|\bat\b|\bin\b|\band\b))/i;

const doctorInReferral = (text) => {
  const name = String(text || "").match(DOCTOR_IN_TEXT)?.[1];
  if (!name) return null;
  return `Dr ${name.replace(/\b([a-z])([a-z]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase())}`;
};

const notCollected = (key) =>
  `NOT EXISTS (SELECT 1 FROM care_followups cf WHERE cf.source_key = ${key})`;

export const DESK_REFERRAL_SELECT = `
  SELECT r.id::text AS ref, r.patient_id, r.specialty, r.to_doctor, r.hospital, r.reason,
         r.investigations, r.appointment_date::text AS due_on,
         r.created_by AS by_id, COALESCE(d.short_name, d.name) AS by_name,
         v.visit_date::text AS ordered_on
    FROM giniflow_referrals r
    JOIN giniflow_visits v ON v.id = r.visit_id
    LEFT JOIN doctors d ON d.id = r.created_by`;

const SOURCES = [
  {
    source: "gf_referral",
    sql: `${DESK_REFERRAL_SELECT}
           WHERE v.visit_date BETWEEN $1::date AND $2::date AND ${notCollected("'gf:' || r.id")}
           ORDER BY r.created_at LIMIT ${BATCH}`,
    shape: (r, catalog) => ({
      key: `gf:${r.ref}`,
      ...matchReferral(catalog, { doctor: r.to_doctor, specialty: r.specialty, reason: r.reason }),
      target: [r.specialty, r.to_doctor].filter(Boolean).join(" — "),
      detail: [
        r.reason,
        r.hospital && `At ${r.hospital}`,
        r.investigations && `Tests: ${r.investigations}`,
      ]
        .filter(Boolean)
        .join(" · "),
      dueOn: r.due_on,
    }),
  },
  {
    source: "rx_referral",
    sql: `SELECT r.id::text AS ref, r.patient_id, r.doctor_name, r.speciality, r.reason,
                 COALESCE(ap.appointment_date, ${IST_DATE("r.created_at")})::text AS ordered_on,
                 NULL::int AS by_id, ap.doctor_name AS by_name, NULL::text AS due_on
            FROM referrals r
            LEFT JOIN appointments ap ON ap.id = r.appointment_id
           WHERE COALESCE(r.status, '') <> 'cancelled'
             AND COALESCE(ap.appointment_date, ${IST_DATE("r.created_at")}) BETWEEN $1::date AND $2::date
             AND ${notCollected("'rx:' || r.id")}
           ORDER BY r.created_at LIMIT ${BATCH}`,
    shape: (r, catalog) => ({
      key: `rx:${r.ref}`,
      ...matchReferral(catalog, {
        doctor: r.doctor_name,
        specialty: r.speciality,
        reason: r.reason,
      }),
      target: [r.speciality, r.doctor_name].filter(Boolean).join(" — ") || "Referral",
      detail: r.reason || null,
      dueOn: null,
    }),
  },
  {
    source: "hr_note_referral",
    keyset: true,
    sql: `SELECT a.id AS ref, a.patient_id, a.healthray_clinical_notes AS note,
                 a.appointment_date::text AS ordered_on, NULL::int AS by_id,
                 a.doctor_name AS by_name, NULL::text AS due_on
            FROM appointments a
           WHERE a.patient_id IS NOT NULL
             AND a.appointment_date BETWEEN $1::date AND $2::date
             AND a.id > $3::int
             AND COALESCE(a.status, '') <> 'cancelled'
             AND a.healthray_clinical_notes ~* '(consult(ation)?[[:space:]]+with|refer(red)?[[:space:]]+to|opinion)'
           ORDER BY a.id LIMIT ${BATCH}`,
    shape: (r, catalog) =>
      referralsFromNote(r.note).map((ref) => {
        const doctor = doctorInReferral(ref.reason);
        const specialty = ref.specialty === "Referral" ? null : ref.specialty;
        return {
          key: `hn:${r.patient_id}:${shortHash(ref.reason)}`,
          ...matchReferral(catalog, { doctor, specialty, reason: ref.reason }),
          target: [specialty, doctor].filter(Boolean).join(" — ") || "Referral",
          detail: ref.reason,
          dueOn: null,
        };
      }),
  },
];

export const deskReferralShape = (row, catalog) => SOURCES[0].shape(row, catalog);

export const itemRow = (r, shaped) => ({
  patient_id: r.patient_id,
  source_key: shaped.key,
  kind: shaped.kind,
  target: shaped.target.slice(0, 300),
  detail: shaped.detail ? shaped.detail.slice(0, 1000) : null,
  matched_doctor_id: shaped.matchedDoctorId ?? null,
  matched_specialty: shaped.matchedSpecialty ?? null,
  matched_tests: shaped.matchedTests ?? null,
  availability: shaped.availability,
  ordered_by_id: r.by_id ?? null,
  ordered_by_name: r.by_name ?? null,
  ordered_on: r.ordered_on,
  due_on: shaped.dueOn ?? null,
});

export async function insertItems(db, source, items) {
  if (!items.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO care_followups
       (patient_id, source, source_key, kind, target, detail, matched_doctor_id, matched_specialty,
        matched_tests, availability, ordered_by_id, ordered_by_name, ordered_on, due_on)
     SELECT x.patient_id, $2, x.source_key, x.kind, x.target, x.detail, x.matched_doctor_id,
            x.matched_specialty, x.matched_tests, x.availability, x.ordered_by_id,
            x.ordered_by_name, x.ordered_on::date, x.due_on::date
       FROM jsonb_to_recordset($1::jsonb) AS x(
              patient_id int, source_key text, kind text, target text, detail text,
              matched_doctor_id int, matched_specialty text, matched_tests text[],
              availability text, ordered_by_id int, ordered_by_name text,
              ordered_on text, due_on text)
     ON CONFLICT (source_key) DO NOTHING`,
    [JSON.stringify(items), source],
  );
  return rowCount;
}

const OPEN_END = "9999-12-31";

async function collectSource(db, spec, since, catalog, dryRun, until = OPEN_END) {
  let added = 0;
  let seen = 0;
  let after = 0;
  for (let round = 0; round < 50; round += 1) {
    const { rows } = await db.query(spec.sql, spec.keyset ? [since, until, after] : [since, until]);
    if (!rows.length) break;
    if (spec.keyset) after = rows[rows.length - 1].ref;
    const items = rows
      .flatMap((r) => {
        const shaped = spec.shape(r, catalog);
        if (!shaped) return [{ skip: `${spec.source}:${r.ref}` }];
        return [shaped].flat().map((one) => ({ row: r, shaped: one }));
      })
      .map((x) => (x.skip ? x : itemRow(x.row, x.shaped)))
      .filter((x) => x.patient_id && !x.skip);
    seen += rows.length;
    if (dryRun && !spec.keyset) {
      added += items.length;
      break;
    }
    if (!dryRun) added += await insertItems(db, spec.source, items);
    else added += items.length;
    if (rows.length < BATCH || (!items.length && !spec.keyset)) break;
  }
  return { seen, added };
}

async function moveItem(db, id, { from, to, reason, appointmentId, kind = "auto" }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE care_followups
          SET status = $2, outcome_reason = COALESCE($3, outcome_reason),
              booked_appointment_id = CASE WHEN $4::int IS NULL THEN booked_appointment_id ELSE $4 END,
              updated_at = NOW()
        WHERE id = $1 AND status = $5`,
      [id, to, to === "open" ? null : reason, appointmentId ?? null, from],
    );
    if (rowCount) {
      await client.query(
        `INSERT INTO care_followup_events (followup_id, kind, from_status, to_status, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, kind, from, to, reason],
      );
    }
    await client.query("COMMIT");
    return rowCount;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const fmtDay = (d) => String(d).slice(0, 10);

async function laterFacts(db, patientIds, since) {
  const { rows } = await db.query(
    `SELECT id, patient_id, appointment_date::text AS day, doctor_name, status
       FROM appointments
      WHERE patient_id = ANY($1::int[]) AND appointment_date >= $2::date
        AND COALESCE(status, '') <> 'cancelled'`,
    [patientIds, since],
  );
  return { appointments: rows };
}

function decide(item, facts, catalog) {
  const ordered = fmtDay(item.ordered_on);
  if (item.status === "booked" && item.booked_appointment_id) {
    const booked = facts.appointments.find((a) => a.id === item.booked_appointment_id);
    if (!booked) {
      return { to: "open", reason: "The booked visit was cancelled — call again" };
    }
    if (booked.status === "completed") {
      return { to: "done", reason: `Visit completed on ${booked.day}` };
    }
    if (booked.status === "no_show") {
      return { to: "open", reason: `Didn't come on ${booked.day} — call again` };
    }
  }
  if (item.status !== "open") return null;
  const later = facts.appointments
    .filter((a) => a.patient_id === item.patient_id && a.day > ordered)
    .filter((a) => {
      const person = personOf(catalog, a.doctor_name);
      if (!person) return false;
      if (item.matched_doctor_id) return person.id === item.matched_doctor_id;
      return item.matched_specialty && person.specialty === item.matched_specialty;
    })
    .sort((a, b) => a.day.localeCompare(b.day));
  const visit = later[0];
  if (!visit) return null;
  if (visit.status === "completed") {
    return { to: "done", reason: `Seen by ${visit.doctor_name} on ${visit.day}` };
  }
  return {
    to: "booked",
    reason: `Already booked with ${visit.doctor_name} on ${visit.day}`,
    appointmentId: visit.id,
    visit,
  };
}

async function closeGoneSources(db) {
  const gone = await db.query(
    `SELECT cf.id, cf.status,
            CASE
              WHEN cf.source = 'gf_referral'
                   AND NOT EXISTS (SELECT 1 FROM giniflow_referrals r
                                    WHERE 'gf:' || r.id = cf.source_key)
                THEN 'closed:Referral removed at source'
              WHEN cf.source = 'rx_referral'
                   AND NOT EXISTS (SELECT 1 FROM referrals r
                                    WHERE 'rx:' || r.id = cf.source_key
                                      AND COALESCE(r.status, '') <> 'cancelled')
                THEN 'closed:Referral cancelled at source'
            END AS verdict
       FROM care_followups cf
      WHERE cf.status = ANY($1)
      LIMIT 500`,
    [ACTIVE_STATUSES],
  );
  let moved = 0;
  for (const row of gone.rows) {
    if (!row.verdict) continue;
    const [to, ...why] = row.verdict.split(":");
    moved += await moveItem(db, row.id, { from: row.status, to, reason: why.join(":") });
  }
  return moved;
}

export async function autoProgress(db = pool, catalog = null) {
  if (!(await followupsSince(db))) return { moved: 0 };
  const cat = catalog || (await loadCatalog(db));
  let moved = await closeGoneSources(db);
  const { rows } = await db.query(
    `SELECT id, patient_id, kind, status, ordered_on::text AS ordered_on, source, source_key,
            matched_doctor_id, matched_specialty, booked_appointment_id
       FROM care_followups
      WHERE status IN ('open', 'booked') AND kind = ANY($1)
      ORDER BY ordered_on
      LIMIT 1000`,
    [REFERRAL_KINDS],
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const earliest = batch.map((r) => fmtDay(r.ordered_on)).sort()[0];
    const facts = await laterFacts(db, [...new Set(batch.map((r) => r.patient_id))], earliest);
    for (const item of batch) {
      const next = decide(item, facts, cat);
      if (next && next.to !== item.status) {
        const { visit, ...move } = next;
        const changed = await moveItem(db, item.id, { from: item.status, ...move });
        moved += changed;
        if (changed && visit && item.source === "gf_referral") {
          await markDeskBookedAtGhm(db, item.source_key, visit);
        }
      }
    }
  }
  return { moved };
}

let running = null;

const singleFlight = (job) => {
  if (running) return running.then(() => ({ alreadyRunning: true }));
  running = job().finally(() => {
    running = null;
  });
  return running;
};

export function collectFollowups({ db = pool, dryRun = false } = {}) {
  return singleFlight(async () => {
    const since = await followupsSince(db);
    if (!since) return { since: null, sources: {}, moved: 0 };
    const catalog = await loadCatalog(db);
    const sources = {};
    for (const spec of SOURCES) {
      sources[spec.source] = await collectSource(db, spec, since, catalog, dryRun);
    }
    if (dryRun) return { since, sources, dryRun: true };
    const { moved } = await autoProgress(db, catalog);
    return { since, sources, moved };
  });
}

export function collectDay({ db = pool, day }) {
  return singleFlight(async () => {
    const since = await followupsSince(db);
    if (!since || day >= since) return { day, sources: {}, moved: 0, skipped: true };
    const catalog = await loadCatalog(db);
    const sources = {};
    for (const spec of SOURCES) {
      sources[spec.source] = await collectSource(db, spec, day, catalog, false, day);
    }
    const { moved } = await autoProgress(db, catalog);
    return { day, sources, moved };
  });
}
