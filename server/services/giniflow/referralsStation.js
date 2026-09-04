import pool from "../../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { buildCard } from "./medicineCard.js";
import { todaysVitals, previousVitals } from "./visitVitals.js";
import { generateReferralLetterPdf } from "../prescriptionHtmlPdf.js";
import { sendReferralLetter } from "../msg91.js";
import { addExternal } from "./prescription.js";
import {
  isValidSpecialty,
  specialtyLabel,
  specialtyIcon,
  urgencyMeta,
  urgencyTargetHours,
  referralNo,
  referralStatusMeta,
  URGENCY_RANK,
  URGENCY_VALUES,
} from "../../../shared/giniflowReferrals.js";

// Referrals — the letter out, and the specialist who answers it.
//
// Design: docs/gini-flow/19-REFERRALS-STATION-PLAN.md
//
// A referral is a PARALLEL artefact, like a lab order — not a step in the chain.
// Nothing here touches `giniflow_visits.current_status`, and nothing here has an
// SLA: the floor's time budgets measure how long a patient waits inside the
// building, and a specialist appointment three weeks out is not a bottleneck the
// coordinator can clear. The list is ordered by urgency and age instead.
//
// Two things happen outside any transaction, and must: the Puppeteer render and
// the WhatsApp send. Both can fail slowly, both are idempotent, and neither may
// hold a row lock while it does.

const iso = (value) => (value ? new Date(value).toISOString() : null);

const PAST_WINDOW_DAYS = 30;

const SELECT_SQL = `
  SELECT r.id, r.visit_id, r.patient_id, r.to_doctor, r.to_doctor_phone, r.specialty,
         r.hospital, r.urgency, r.reason, r.investigations,
         r.presenting_complaint, r.requested_action, r.allergy_status, r.allergy_note,
         r.letter_file_url, r.letter_generated_at, r.letter_sent_at, r.sent_to,
         r.appointment_date::text AS appointment_date, r.appointment_note,
         r.status, r.created_at, r.ref_no,
         r.response_note, r.response_at, r.response_by,
         v.visit_date::text AS visit_date,
         p.name, p.file_no, p.age, p.sex, p.phone, p.dob::text AS dob,
         COALESCE(ref.short_name, ref.name) AS referred_by,
         COALESCE(doc.short_name, doc.name, sd.short_name, sd.name) AS visit_doctor
    FROM giniflow_referrals r
    JOIN giniflow_visits v ON v.id = r.visit_id
    JOIN patients p        ON p.id = r.patient_id
    LEFT JOIN doctors ref  ON ref.id = r.created_by
    LEFT JOIN doctors doc  ON doc.id = v.assigned_doctor_id
    LEFT JOIN doctors sd   ON sd.id  = v.assigned_sd_id
`;

const shape = (row) => {
  const urgency = urgencyMeta(row.urgency);
  const status = referralStatusMeta(row.status);
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    visitDate: row.visit_date,
    name: row.name,
    fileNo: row.file_no,
    age: row.age,
    sex: row.sex,
    phone: row.phone,
    dob: row.dob,
    toDoctor: row.to_doctor,
    toDoctorPhone: row.to_doctor_phone,
    specialty: row.specialty,
    specialtyLabel: specialtyLabel(row.specialty),
    icon: specialtyIcon(row.specialty),
    hospital: row.hospital,
    urgency: row.urgency,
    urgencyLabel: urgency.short,
    urgencyTone: urgency.tone,
    // The window the label promises, as a number a report can group by.
    targetHours: urgencyTargetHours(row.urgency),
    reason: row.reason,
    investigations: row.investigations,
    letterUrl: row.letter_file_url,
    letterGeneratedAt: iso(row.letter_generated_at),
    letterSentAt: iso(row.letter_sent_at),
    sentTo: row.sent_to,
    appointmentDate: row.appointment_date,
    appointmentNote: row.appointment_note,
    responseNote: row.response_note,
    responseAt: iso(row.response_at),
    responseBy: row.response_by,
    refNo: row.ref_no,
    referralNo: referralNo(row.ref_no, row.created_at),
    status: row.status,
    statusLabel: status.label,
    statusTone: status.tone,
    // The card's title: "Dr. Suresh Gupta — Nephrology", or the specialty alone
    // when nobody has named a doctor yet.
    title: row.to_doctor
      ? `${row.to_doctor} — ${specialtyLabel(row.specialty)}`
      : specialtyLabel(row.specialty),
    referredBy: row.referred_by || row.visit_doctor || null,
    createdAt: iso(row.created_at),
    // The station never draws "View specialist report" / "Add to medicines":
    // the return leg is deferred (19 §12.3), and a button that toasts and does
    // nothing is worse than an absent one on a screen a coordinator trusts.
    canRemove: row.status === "created" && !row.letter_file_url,
    // The reply can be recorded at any point after the referral was raised —
    // a specialist who saw the patient the same afternoon should not have to
    // wait for somebody to press "Book appointment" first.
    canRecordResponse: true,
    canSendToDoctor: !!row.to_doctor_phone,
    canSendToPatient: !!row.phone,
  };
};

// Urgency first, then age — the whole sort, because a referral has no budget
// colour to sort by (§2).
const compareReferrals = (a, b) => {
  const rank = (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9);
  if (rank) return rank;
  return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
};

// Two groups, both scoped by the VISIT's date rather than the row's timestamp:
// every other Gini Flow station means "the day this patient was on the floor"
// when it says today, and a referral written up at 00:05 for yesterday's clinic
// belongs with yesterday's patient.
export async function getReferrals(visitDate, { q = null } = {}, db = pool) {
  const search = String(q || "").trim();
  const like = search ? `%${search}%` : null;

  const { rows } = await db.query(
    `${SELECT_SQL}
      WHERE v.visit_date BETWEEN $1::date - $2::int AND $1::date
        AND ($3::text IS NULL OR p.name ILIKE $3 OR p.file_no ILIKE $3
             OR COALESCE(r.to_doctor, '') ILIKE $3 OR COALESCE(r.hospital, '') ILIKE $3)
      ORDER BY r.created_at DESC`,
    [visitDate, PAST_WINDOW_DAYS, like],
  );

  const all = rows.map(shape);
  const today = all.filter((r) => r.visitDate === visitDate).sort(compareReferrals);
  const past = all.filter((r) => r.visitDate !== visitDate);

  return {
    today,
    past,
    counts: {
      today: today.length,
      past: past.length,
      open: today.filter((r) => r.status !== "completed").length,
    },
    searched: search || null,
  };
}

// The create form's Patient field. The prototype's is a placeholder, not a
// picker — and free text lands a referral with no patient_id, which is a letter
// nobody can find again. A referral hangs off a visit, so the only patients
// offered are the ones on the floor that day.
export async function searchReferralPatients(visitDate, q, db = pool) {
  const raw = String(q || "").trim();
  if (raw.length < 2) return [];
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, p.id AS patient_id, p.name, p.file_no, p.age, p.sex, p.phone,
            v.current_status
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = $1::date
        AND (p.name ILIKE $2 OR p.file_no ILIKE $2)
      ORDER BY p.name
      LIMIT 15`,
    [visitDate, `%${raw}%`],
  );
  return rows.map((r) => ({
    visitId: r.visit_id,
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    phone: r.phone,
    status: r.current_status,
  }));
}

// The consultant's chips and finalizePreview read the same list, so a chip that
// looks selected and a Finalize panel that names the referral cannot disagree.
export async function referralsForVisit(visitId, db = pool) {
  const { rows } = await db.query(`${SELECT_SQL} WHERE r.visit_id = $1 ORDER BY r.created_at`, [
    visitId,
  ]);
  return rows.map(shape);
}

async function loadReferral(referralId, db = pool) {
  const { rows } = await db.query(`${SELECT_SQL} WHERE r.id = $1`, [referralId]);
  return rows[0] || null;
}

const bad = (message, status = 409) => Object.assign(new Error(message), { status });

// Creating. The consultant's chip sends specialty alone; the station's form
// sends all eight fields. Both land here, and the (visit_id, specialty) unique
// index makes a double tap idempotent rather than a second letter.
//
// RF-02. One function, two callers with different needs, and the difference is
// what the upsert may overwrite. The DO UPDATE is guarded on
// `status = 'created' AND letter_file_url IS NULL`, so a row whose letter has
// been generated — or sent, booked or closed — is never silently rewritten. That
// guard matters because without it a coordinator creating "Cardiology → Dr. B"
// for a visit already holding "Cardiology → Dr. A" got no error and no second
// row: `to_doctor` flipped to Dr. B while `letter_file_url`, `letter_sent_at`
// and `status` kept saying a letter naming Dr. A had already gone out.
//
// When the guard bites, the two callers want different things:
//   · `source: "chip"` — a re-tap on a specialty already raised is a no-op, and
//     the existing row comes back. A toggle must not throw.
//   · `source: "desk"` (the default, because it is the stricter one) — refused
//     with a sentence naming what is in the way.
export async function createReferral(visitId, fields = {}, db = pool) {
  const {
    specialty,
    toDoctor = null,
    toDoctorPhone = null,
    hospital = null,
    urgency = "routine",
    presentingComplaint = null,
    reason = null,
    requestedAction = null,
    allergyStatus = "not_known",
    allergyNote = null,
    investigations = null,
    actorId = null,
    source = "desk",
  } = fields;

  if (!isValidSpecialty(specialty)) throw bad("That is not a specialty we refer to", 400);
  if (!URGENCY_VALUES.includes(urgency)) throw bad("That is not an urgency", 400);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: visit } = await client.query(
      `SELECT id, patient_id FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!visit.length) throw bad("Visit not found", 404);

    const { rows } = await client.query(
      `INSERT INTO giniflow_referrals
         (visit_id, patient_id, to_doctor, to_doctor_phone, specialty, hospital,
          urgency, reason, investigations, created_by,
          presenting_complaint, requested_action, allergy_status, allergy_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (visit_id, specialty) DO UPDATE SET
         to_doctor       = COALESCE(EXCLUDED.to_doctor, giniflow_referrals.to_doctor),
         to_doctor_phone = COALESCE(EXCLUDED.to_doctor_phone, giniflow_referrals.to_doctor_phone),
         hospital        = COALESCE(EXCLUDED.hospital, giniflow_referrals.hospital),
         urgency         = EXCLUDED.urgency,
         reason          = COALESCE(EXCLUDED.reason, giniflow_referrals.reason),
         investigations  = COALESCE(EXCLUDED.investigations, giniflow_referrals.investigations),
         presenting_complaint = COALESCE(EXCLUDED.presenting_complaint,
                                         giniflow_referrals.presenting_complaint),
         requested_action     = COALESCE(EXCLUDED.requested_action,
                                         giniflow_referrals.requested_action),
         allergy_status       = EXCLUDED.allergy_status,
         allergy_note         = COALESCE(EXCLUDED.allergy_note, giniflow_referrals.allergy_note),
         updated_at      = NOW()
       WHERE giniflow_referrals.status = 'created'
         AND giniflow_referrals.letter_file_url IS NULL
       RETURNING id`,
      [
        visitId,
        visit[0].patient_id,
        toDoctor,
        toDoctorPhone,
        specialty,
        hospital,
        urgency,
        reason,
        investigations,
        actorId,
        presentingComplaint,
        requestedAction,
        allergyStatus,
        allergyStatus === "known" ? allergyNote : null,
      ],
    );
    // No row back means the conflict target existed and the guard refused it.
    if (!rows.length) {
      const { rows: existing } = await client.query(
        `SELECT id FROM giniflow_referrals WHERE visit_id = $1 AND specialty = $2`,
        [visitId, specialty],
      );
      await client.query("COMMIT");
      if (source === "chip") return shape(await loadReferral(existing[0].id, db));
      throw bad(
        `${specialtyLabel(specialty)} already has a letter for this visit — close or remove that referral before creating another`,
      );
    }

    await client.query("COMMIT");
    return shape(await loadReferral(rows[0].id, db));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Deselecting a chip. A row still in `created` is a decision the consultant has
// changed their mind about; a row past that has a letter behind it, and that
// letter may already be on its way to a specialist — so it is refused with a
// sentence the consultant can act on rather than deleted quietly.
export async function removeReferral(referralId, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status, letter_file_url FROM giniflow_referrals WHERE id = $1 FOR UPDATE`,
      [referralId],
    );
    if (!rows.length) throw bad("Referral not found", 404);
    if (rows[0].status !== "created" || rows[0].letter_file_url) {
      throw bad("A letter has been generated for this referral — it cannot be removed");
    }
    await client.query(`DELETE FROM giniflow_referrals WHERE id = $1`, [referralId]);
    await client.query("COMMIT");
    return { removed: true, id: referralId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// A PUBLIC object URL — the same treatment giniflow_lab_orders.report_file_url
// already gets, and the same exposure: readable by anyone holding the link,
// permanently, with no login. Stated on the record in 19 §7.3 as a DPDP/GDPR
// consideration to be revisited alongside the lab report, not separately.
async function uploadLetter(patientId, buffer) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }
  const storagePath = `giniflow/referrals/${patientId}/${Date.now()}_referral-letter.pdf`;
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`Letter upload failed: ${await resp.text()}`), { status: 502 });
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
}

// Assembling what the letter says. Kept separate from the render so the
// on-demand PDF route and the stored file are built from one description of the
// letter rather than two.
export async function buildLetterData(referralId, db = pool) {
  const row = await loadReferral(referralId, db);
  if (!row) throw bad("Referral not found", 404);

  // WHO REFERRED, not who clicked.
  //
  // This used to prefer `created_by`, so a referral raised by a coordinator or
  // an admin signed the letter with their name and their `specialty` — a real
  // letter went out reading "Gurjot · Admin & Strategy". A specialist has to
  // know which clinician is asking and who to reply to, and "Admin & Strategy"
  // is neither. The consultant on the visit is the referrer; the person who
  // typed it is recorded separately, which is also the better audit trail.
  const { rows: doctor } = await db.query(
    `SELECT COALESCE(d.name, d.short_name) AS name, d.specialty, d.license_no, d.phone,
            COALESCE(c.short_name, c.name)  AS created_by_name
       FROM giniflow_referrals r
       LEFT JOIN giniflow_visits v ON v.id = r.visit_id
       LEFT JOIN doctors d ON d.id = COALESCE(v.assigned_doctor_id, v.assigned_sd_id, r.created_by)
       LEFT JOIN doctors c ON c.id = r.created_by
      WHERE r.id = $1`,
    [referralId],
  );

  // Everything below is read from what the chart ALREADY holds. Nothing here
  // invents a clinical fact to fill a section — an empty section is honest and
  // a fabricated one is dangerous.
  const { rows: history } = await db.query(
    `SELECT label, since_year FROM diagnoses
      WHERE patient_id = $1 AND COALESCE(is_active, TRUE)
      ORDER BY category = 'primary' DESC, since_year NULLS LAST, label`,
    [row.patient_id],
  );

  // The reading behind the referral: this visit's if the station took one,
  // otherwise the most recent on the chart. Read through the shared helper, so
  // a reading taken on HealthRay is not invisible here either.
  const vitals =
    (await todaysVitals(
      row.visit_id,
      { patientId: row.patient_id, visitDate: row.visit_date },
      db,
    )) || (await previousVitals(row.patient_id, row.visit_date, db));

  // Current against previous, with the date, so a trend reads at a glance
  // rather than as two numbers in a sentence.
  // Current against the last DIFFERENT reading, per marker.
  //
  // Not "the two most recent appointments": a booking carries the last known
  // biomarkers forward, so today's row and the visit that produced it hold the
  // same number — and the letter printed 10.7 against 10.7 and called it a
  // trend. It also printed an empty "current" for a marker today's row happened
  // not to carry.
  //
  // So each marker is walked back independently until the value actually
  // changes. That is what a clinician means by "previous", and it is the
  // difference between a trend and a typo.
  const { rows: marks } = await db.query(
    `SELECT DISTINCT ON (appointment_date) appointment_date::text AS date, biomarkers
       FROM appointments
      WHERE patient_id = $1
        AND biomarkers IS NOT NULL AND biomarkers <> '{}'::jsonb
        AND appointment_date <= COALESCE($2::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
      ORDER BY appointment_date DESC NULLS LAST, id DESC
      LIMIT 12`,
    [row.patient_id, row.visit_date || null],
  );
  const MARKERS = [
    ["hba1c", "HbA1c", "%"],
    ["creatinine", "Creatinine", "mg/dL"],
    ["fg", "FBS", ""],
    ["weight", "Weight", "kg"],
  ];
  const trend = MARKERS.map(([key, label, unit]) => {
    const seen = marks
      .map((m) => ({ date: m.date, value: m.biomarkers?.[key] }))
      .filter((x) => x.value !== null && x.value !== undefined);
    if (!seen.length) return null;
    const current = seen[0];
    const previous = seen.find((x) => String(x.value) !== String(current.value)) || null;
    return {
      label,
      unit,
      current: current.value,
      currentDate: current.date,
      previous: previous?.value ?? null,
      previousDate: previous?.date ?? null,
    };
  }).filter(Boolean);

  // One medicine history, read the same way the card and the prescription read
  // it. The specialist needs to know what the patient is already on before they
  // prescribe (§7.1) — there is no `external_medicines` table and there will not
  // be one.
  const card = await buildCard(row.patient_id, db);

  return {
    row,
    data: {
      referral: {
        // Printed so the receiving clinic can quote it back. The UUID is the
        // key; this is the number a human can say out loud.
        referralNo: referralNo(row.ref_no, row.created_at),
        specialty: row.specialty,
        urgency: row.urgency,
        toDoctor: row.to_doctor,
        hospital: row.hospital,
        presentingComplaint: row.presenting_complaint,
        reason: row.reason,
        requestedAction: row.requested_action,
        investigations: row.investigations,
        createdAt: row.created_at,
      },
      patient: {
        name: row.name,
        age: row.age,
        sex: row.sex,
        // Age alone cannot identify a patient at the receiving end — two 68M
        // Singhs is not a hypothetical here. DOB is printed when the chart has
        // one, and simply omitted when it does not.
        dob: row.dob,
        fileNo: row.file_no,
        phone: row.phone,
      },
      doctor: {
        name: doctor[0]?.name || "Gini Advanced Care Hospital",
        qualification: doctor[0]?.specialty || null,
        registration: doctor[0]?.license_no ? `Reg. ${doctor[0].license_no}` : null,
        // Who the specialist calls back. The letterhead carries the hospital
        // switchboard, which is not the same thing as reaching the clinician
        // who asked the question.
        phone: doctor[0]?.phone || null,
        // Shown only when somebody other than the referring clinician typed it.
        preparedBy:
          doctor[0]?.created_by_name && doctor[0].created_by_name !== doctor[0].name
            ? doctor[0].created_by_name
            : null,
      },
      history: history.map((h) => ({
        label: h.label,
        since: h.since_year || null,
      })),
      // Asked at referral time, because there is no allergy field on the chart
      // and this is the moment somebody else is about to prescribe. Three
      // states, never blank: "none known" reaches a specialist only because a
      // human said so, and "nobody asked" is sayable rather than implied by an
      // empty box.
      allergies: {
        status: row.allergy_status || "not_known",
        note: row.allergy_note || null,
      },
      findings: vitals
        ? {
            bp: vitals.bp_sys && vitals.bp_dia ? `${vitals.bp_sys}/${vitals.bp_dia}` : null,
            pulse: vitals.pulse ?? null,
            spo2: vitals.spo2 ?? null,
            temp: vitals.temp ?? null,
            weight: vitals.weight ?? null,
            bmi: vitals.bmi ?? null,
            takenAt: vitals.recorded_at || null,
          }
        : null,
      trend,
      medicines: card.groups.flatMap((g) => g.medicines),
    },
  };
}

// Which letter the inline route should serve (RF-05). A stored file is the one
// the specialist was actually sent, so it wins; only a row without one is
// rendered live.
export async function storedLetterUrl(referralId, db = pool) {
  const { rows } = await db.query(`SELECT letter_file_url FROM giniflow_referrals WHERE id = $1`, [
    referralId,
  ]);
  if (!rows.length) throw bad("Referral not found", 404);
  return rows[0].letter_file_url || null;
}

// Just the fields the download filename needs, when the bytes came from storage
// and there is nothing to render.
export async function loadReferralHeader(referralId, db = pool) {
  const row = await loadReferral(referralId, db);
  if (!row) throw bad("Referral not found", 404);
  return { name: row.name, specialty: row.specialty };
}

// The stored letter's BYTES, fetched with the service key.
//
// Not a redirect to the stored URL, which is what this used to do and why the
// button 404'd: `patient-files` is a PRIVATE bucket, so the
// `/object/public/<bucket>/...` form Supabase hands you resolves to
// "Bucket not found". The bucket cannot be made public either — it holds every
// patient's prescriptions and lab reports.
//
// So the letter is proxied, exactly as `GET /documents/:id/stream` already
// proxies a prescription: the server reads it with the key it has and streams
// it to a caller the auth middleware has already checked. No CORS, no expiry,
// no public object.
export async function fetchStoredLetter(referralId, db = pool) {
  const url = await storedLetterUrl(referralId, db);
  if (!url || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;

  // Accepts either shape, because rows written before this fix hold the public
  // form: .../object/public/<bucket>/<path> and .../object/<bucket>/<path>.
  const marker = `/storage/v1/object/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const objectPath = url.slice(at + marker.length).replace(/^public\//, "");

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${objectPath}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  // A missing object is not an error the desk can act on — the route renders a
  // fresh letter instead, which is always possible.
  if (!resp.ok) return null;
  return Buffer.from(await resp.arrayBuffer());
}

// The render, on its own, for the inline PDF route (§7.2). No database write —
// serving a letter must work even when storage is down.
export async function renderLetter(referralId, db = pool) {
  const { row, data } = await buildLetterData(referralId, db);
  return { pdf: await generateReferralLetterPdf(data), referral: shape(row) };
}

// Generate + store. Idempotent by `letter_file_url`: Finalize calls this for
// every referral on the visit and a second Finalize must not add a second file.
// NOT wrapped in a transaction — a Puppeteer render holding a row lock for two
// seconds is exactly the failure `finalize.js` warns about.
export async function generateLetter(referralId, { force = false } = {}, db = pool) {
  const { row, data } = await buildLetterData(referralId, db);
  if (row.letter_file_url && !force) {
    return { generated: false, alreadyGenerated: true, letterUrl: row.letter_file_url };
  }

  const pdf = await generateReferralLetterPdf(data);
  const url = await uploadLetter(row.patient_id, pdf);

  // `created` is the only status the letter advances. A referral already at
  // `appointment_booked` or `completed` has moved past the letter, and a
  // regenerate must not walk it backwards.
  await db.query(
    `UPDATE giniflow_referrals
        SET letter_file_url = $2, letter_generated_at = NOW(),
            status = CASE WHEN status = 'created' THEN 'letter_generated' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`,
    [referralId, url],
  );

  return { generated: true, letterUrl: url, bytes: pdf.length };
}

// Sending, modelled directly on sendCardToPatient (pharmacyStation.js:525).
//
// `letter_sent_at` is stamped ONLY when a message actually left the building.
// MSG91 logs instead of sending while the template is unapproved, and because
// that column is also the idempotency guard, stamping it on a no-op would
// permanently mark a patient as having been sent a letter they never got — and
// stop the real send from ever reaching them once the template goes live.
export async function sendLetter(referralId, { to = "patient", force = false } = {}, db = pool) {
  const row = await loadReferral(referralId, db);
  if (!row) throw bad("Referral not found", 404);
  if (!["patient", "doctor"].includes(to)) throw bad("Send to the patient or the doctor", 400);

  if (row.letter_sent_at && !force) {
    return { sent: false, alreadySent: true, sentAt: iso(row.letter_sent_at) };
  }

  const phone = to === "doctor" ? row.to_doctor_phone : row.phone;
  if (!phone) {
    throw bad(
      to === "doctor"
        ? `No phone number for ${row.to_doctor || "the specialist"}`
        : "This patient has no phone number on file",
    );
  }

  // Nothing to link to yet — send the letter, not a promise of one.
  let letterUrl = row.letter_file_url;
  if (!letterUrl) letterUrl = (await generateLetter(referralId, {}, db)).letterUrl;

  const result = await sendReferralLetter(phone, {
    patient_name: row.name || "",
    specialty: specialtyLabel(row.specialty),
    doctor_name: row.to_doctor || specialtyLabel(row.specialty),
    hospital: row.hospital || "Gini Advanced Care Hospital",
    letter_link: letterUrl,
  });

  if (result?.dev) {
    return {
      sent: false,
      dev: true,
      to,
      phone,
      reason: "The WhatsApp referral template is not live yet — the letter was logged, not sent",
    };
  }

  // `sent_to` remembers both when the letter went to the specialist and the
  // patient, so a resend to the other party does not erase the first.
  await db.query(
    `UPDATE giniflow_referrals
        SET letter_sent_at = NOW(),
            sent_to = CASE WHEN sent_to IS NULL OR sent_to = $2 THEN $2 ELSE 'both' END,
            updated_at = NOW()
      WHERE id = $1`,
    [referralId, to],
  );
  return { sent: true, to, phone };
}

// The external clinic gave a slot. Gini books nothing — this records what
// somebody else's diary says, which is why the note is free text.
export async function bookAppointment(referralId, { date, note = null } = {}, db = pool) {
  if (!date) throw bad("An appointment needs a date", 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status FROM giniflow_referrals WHERE id = $1 FOR UPDATE`,
      [referralId],
    );
    if (!rows.length) throw bad("Referral not found", 404);
    if (rows[0].status === "completed") {
      throw bad("This referral is already closed — the specialist has seen the patient");
    }
    await client.query(
      `UPDATE giniflow_referrals
          SET appointment_date = $2::date, appointment_note = $3,
              status = 'appointment_booked', updated_at = NOW()
        WHERE id = $1`,
      [referralId, date, note],
    );
    await client.query("COMMIT");
    return shape(await loadReferral(referralId, db));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Seen, and the loop is closed. The one irreversible action on this screen, so
// the route asks for `{ confirm: true }` the way every other one here does.
// The return leg — brief §4.7, 19 §12.3.
//
// A referral used to be write-only: the letter went out and the row's story
// ended. What the specialist said came back on paper and stayed there, which
// means Gini's own prescriber could not see the medicines the specialist had
// just started. That is the interaction check failing silently, not a filing
// problem.
//
// The medicines do NOT live on the referral. They go to `medications` with
// `external_doctor`, through the same addExternal() the consult screen uses, so
// they reach the medicine card, the pharmacy's dispense list and the referral
// letter's "Current medicines" the same way every other external medicine does.
//
// One transaction: a reply recorded without its medicines would tell the desk
// the loop was closed while the prescriber still could not see the new drugs.
export async function recordResponse(
  referralId,
  { note = null, medicines = [], complete = true, actorName = null },
  db = pool,
) {
  const text = String(note || "").trim();
  if (!text && !medicines.length) {
    throw bad("Write what the specialist said, or add the medicines they started", 400);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, patient_id, to_doctor, specialty, hospital, status
         FROM giniflow_referrals WHERE id = $1 FOR UPDATE`,
      [referralId],
    );
    if (!rows.length) throw bad("Referral not found", 404);
    const referral = rows[0];

    const added = [];
    for (const med of medicines) {
      const name = String(med.medicineName || "").trim();
      if (!name) continue;
      added.push(
        await addExternal(
          referral.patient_id,
          {
            ...med,
            medicineName: name,
            // Attributed to the specialist, not to whoever typed it in. The
            // medicine card prints this line, and "Prescribed by: coordinator"
            // would be false on a clinical document.
            prescriberName: referral.to_doctor || specialtyLabel(referral.specialty),
            prescriberSpecialty: specialtyLabel(referral.specialty),
            prescriberHospital: referral.hospital,
          },
          client,
        ),
      );
    }

    await client.query(
      `UPDATE giniflow_referrals
          SET response_note = COALESCE(NULLIF($2, ''), response_note),
              response_at   = NOW(),
              response_by   = $3,
              status        = CASE WHEN $4 THEN 'completed' ELSE status END,
              updated_at    = NOW()
        WHERE id = $1`,
      [referralId, text, actorName, complete],
    );

    await client.query("COMMIT");
    return { ...shape(await loadReferral(referralId, db)), medicinesAdded: added };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function completeReferral(referralId, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status FROM giniflow_referrals WHERE id = $1 FOR UPDATE`,
      [referralId],
    );
    if (!rows.length) throw bad("Referral not found", 404);
    const already = rows[0].status === "completed";
    if (!already) {
      await client.query(
        `UPDATE giniflow_referrals SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [referralId],
      );
    }
    await client.query("COMMIT");
    const fresh = shape(await loadReferral(referralId, db));
    return already ? { ...fresh, unchanged: true } : fresh;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
