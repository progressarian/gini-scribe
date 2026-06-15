import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { resolveDoctorIdByName, checkBookingAvailability } from "../services/bookingGuard.js";

const router = Router();

// Slot → reporting time mapping (from Slotsday sheet)
const REPORTING_MAP = {
  "9:30 AM to 10 AM": "11:30 AM to 12 PM",
  "10 AM to 11 AM": "12 PM to 1 PM",
  "11 AM to 12 PM": "1 PM to 2 PM",
  "12 PM to 1 PM": "2 PM to 3 PM",
  "1 PM to 2 PM": "3 PM to 4 PM",
  "2 PM to 2:30 PM": "4 PM to 4:30 PM",
  "2:30 PM to 3 PM": "4:30 PM to 5 PM",
  "3 PM to 3:30 PM": "4:30 PM to 5 PM",
  "3:30 PM to 4 PM": "5 PM to 5:30 PM",
};

const FEES = {
  "Dr. Anil Bhansali": 1500,
  "Dr Beant Kaur": 1000,
  "Dr Simran": 1000,
  "Dr Saniya": 1000,
};

function buildWhatsappMessage({
  patient_name,
  doctor_name,
  appointment_date,
  time_slot,
  visit_type,
}) {
  const reporting = REPORTING_MAP[time_slot] || time_slot;
  const dateStr = appointment_date;
  const isNew = !visit_type || visit_type.toLowerCase().includes("new");
  const fee = FEES[doctor_name] || 1500;
  const feeLines = Object.entries(FEES)
    .map(([d, f]) => `${d}: Rs ${f}`)
    .join("; ");

  const base =
    `Hello ${patient_name},\n\n` +
    `Greetings from Gini Health!\n\n` +
    `Your visit to Gini Hospital Mohali has been booked in the department of Endocrinology. ` +
    `Your *reporting time* at the reception is on ${dateStr} between ${reporting}; \n` +
    `*Consultation Fee:* \n${feeLines};\n` +
    `*Follow up within 3 days is free*\n\n` +
    `Please do not have any commitments for the next 2-3 hours from the reporting time.\n\n` +
    `If you cannot visit as per this reporting time due to any reason, kindly revert with *Not coming* to this message so that someone in need can be given this slot.\n\n` +
    `Now you can avail benefit of *SUNDAY OPD* across few specialty available now at Gini Hospital Mohali.\n\n` +
    `For any further queries:\nPlease call 0172 - 4120100/ 9056403020 or visit Gini Health, Sector 69, Mohali.\n` +
    `Find more about us at - www.ginihealth.com`;

  const additional = isNew
    ? null
    : `*Note:* You are advised to report 1 hour after your given reporting time in case:\n` +
      `1) There are no blood test prescribed;\n*OR*\n` +
      `2) You already have got test reports with you\n*OR*\n` +
      `3) Home collection from Ginihealth team has already taken`;

  return { whatsapp_message: base, additional_whatsapp_msg: additional };
}

// ─── Call attempt history ──────────────────────────────────────────────────

// GET /api/call-attempts?appointment_id=X — full history, newest first
router.get("/call-attempts", async (req, res) => {
  try {
    const { appointment_id } = req.query;
    if (!appointment_id) return res.status(400).json({ error: "appointment_id required" });
    const r = await pool.query(
      `SELECT * FROM call_attempts WHERE appointment_id=$1
       ORDER BY called_at DESC, id DESC`,
      [appointment_id],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Call attempts list");
  }
});

// POST /api/call-attempts/counts — { appointment_ids:[...] } → { id: count }
router.post("/call-attempts/counts", async (req, res) => {
  try {
    const ids = (req.body?.appointment_ids || []).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.json({});
    const r = await pool.query(
      `SELECT appointment_id, COUNT(*)::int AS cnt
       FROM call_attempts WHERE appointment_id = ANY($1::int[])
       GROUP BY appointment_id`,
      [ids],
    );
    const out = {};
    for (const row of r.rows) out[row.appointment_id] = row.cnt;
    res.json(out);
  } catch (e) {
    handleError(res, e, "Call attempt counts");
  }
});

// POST /api/call-attempts — log one attempt + sync appointment summary
router.post("/call-attempts", async (req, res) => {
  const client = await pool.connect();
  try {
    const { appointment_id, outcome, called_by, notes, duration_mins, reschedule_date } = req.body;
    if (!appointment_id) return res.status(400).json({ error: "appointment_id required" });
    if (!outcome) return res.status(400).json({ error: "outcome required" });

    await client.query("BEGIN");

    // patient_id + next attempt number
    const appt = await client.query("SELECT patient_id FROM appointments WHERE id=$1", [
      appointment_id,
    ]);
    if (!appt.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Appointment not found" });
    }
    const patient_id = appt.rows[0].patient_id;
    const cnt = await client.query(
      "SELECT COUNT(*)::int AS c FROM call_attempts WHERE appointment_id=$1",
      [appointment_id],
    );
    const attempt_no = cnt.rows[0].c + 1;

    const ins = await client.query(
      `INSERT INTO call_attempts
       (appointment_id, patient_id, attempt_no, outcome, called_by, notes, duration_mins, reschedule_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        appointment_id,
        patient_id,
        attempt_no,
        outcome,
        called_by || null,
        notes || null,
        duration_mins || null,
        reschedule_date || null,
      ],
    );

    // Mirror latest attempt onto the appointment summary columns
    await client.query(
      `UPDATE appointments
       SET call_status = $1,
           call_made_by = COALESCE($2, call_made_by),
           call_date = CURRENT_DATE,
           call_notes = COALESCE($3, call_notes),
           call_reschedule_date = COALESCE($4, call_reschedule_date)
       WHERE id = $5`,
      [outcome, called_by || null, notes || null, reschedule_date || null, appointment_id],
    );

    await client.query("COMMIT");
    res.status(201).json(ins.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Call attempt create");
  } finally {
    client.release();
  }
});

// DELETE /api/call-attempts/:id — remove an attempt, renumber the rest,
// and re-sync the appointment summary to the new latest attempt.
router.delete("/call-attempts/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query("SELECT appointment_id FROM call_attempts WHERE id=$1", [
      req.params.id,
    ]);
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Call attempt not found" });
    }
    const apptId = found.rows[0].appointment_id;

    await client.query("DELETE FROM call_attempts WHERE id=$1", [req.params.id]);

    // Renumber remaining attempts sequentially by time
    await client.query(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY called_at ASC, id ASC) AS rn
         FROM call_attempts WHERE appointment_id=$1
       )
       UPDATE call_attempts c SET attempt_no = o.rn
       FROM ordered o WHERE c.id = o.id`,
      [apptId],
    );

    // Re-sync appointment summary to the latest remaining attempt (or reset)
    const latest = await client.query(
      `SELECT outcome, called_by, notes, reschedule_date, called_at
       FROM call_attempts WHERE appointment_id=$1
       ORDER BY called_at DESC, id DESC LIMIT 1`,
      [apptId],
    );
    if (latest.rows.length) {
      const l = latest.rows[0];
      await client.query(
        `UPDATE appointments
         SET call_status=$1, call_made_by=$2, call_notes=$3,
             call_reschedule_date=$4, call_date=$5::date
         WHERE id=$6`,
        [l.outcome, l.called_by, l.notes, l.reschedule_date, l.called_at, apptId],
      );
    } else {
      // no attempts left — clear the summary back to "not called"
      await client.query(
        `UPDATE appointments
         SET call_status='pending', call_made_by=NULL, call_notes=NULL,
             call_reschedule_date=NULL, call_date=NULL
         WHERE id=$1`,
        [apptId],
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, appointment_id: apptId });
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Call attempt delete");
  } finally {
    client.release();
  }
});

// GET /api/ghm-appointments/doctors — bookable doctors with appointment counts.
// Every ACTIVE doctor (from the doctors table) is included even with zero
// bookings, so a freshly-added doctor is immediately bookable. Legacy doctor
// names that only exist on past appointments are kept too.
router.get("/ghm-appointments/doctors", async (_req, res) => {
  try {
    const r = await pool.query(
      `WITH appt AS (
         SELECT doctor_name, COUNT(*)::int AS cnt
           FROM appointments
          WHERE doctor_name IS NOT NULL
          GROUP BY doctor_name
       )
       SELECT doctor_name, cnt FROM (
         -- active clinical doctors (consultant/MO), with their count if any.
         -- Non-clinical staff (nurse/lab/reception/etc.) are not bookable.
         SELECT d.name AS doctor_name, COALESCE(a.cnt, 0) AS cnt
           FROM doctors d
           LEFT JOIN appt a ON a.doctor_name = d.name
          WHERE d.is_active AND lower(d.role) IN ('consultant', 'mo')
         UNION
         -- legacy appointment names not matching an active doctor
         SELECT a.doctor_name, a.cnt
           FROM appt a
          WHERE a.doctor_name NOT IN ('N/A','Dr. Hospital Admin')
            AND NOT EXISTS (SELECT 1 FROM doctors d WHERE d.is_active AND d.name = a.doctor_name)
       ) u
       ORDER BY cnt DESC, doctor_name ASC`,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "GHM doctors list");
  }
});

// POST /api/ghm-appointments/biomarkers — latest 2 HbA1c & FBS per patient
// Body: { patient_ids: [1,2,3] } → { "1": { hba1c: [{v,d},..], fbs: [..] }, ... }
router.post("/ghm-appointments/biomarkers", async (req, res) => {
  try {
    const ids = (req.body?.patient_ids || []).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.json({});

    const r = await pool.query(
      `SELECT patient_id, canonical_name, result, result_text, unit, test_date, rn
       FROM (
         SELECT lr.patient_id, lr.canonical_name, lr.result, lr.result_text, lr.unit, lr.test_date,
                ROW_NUMBER() OVER (
                  PARTITION BY lr.patient_id, lr.canonical_name
                  ORDER BY lr.test_date DESC NULLS LAST, lr.created_at DESC
                ) AS rn
         FROM lab_results lr
         WHERE lr.patient_id = ANY($1::int[])
           AND lr.canonical_name IN ('HbA1c','FBS')
       ) t
       WHERE rn <= 2
       ORDER BY patient_id, canonical_name, rn`,
      [ids],
    );

    const out = {};
    for (const row of r.rows) {
      const pid = row.patient_id;
      const key = row.canonical_name === "HbA1c" ? "hba1c" : "fbs";
      out[pid] = out[pid] || { hba1c: [], fbs: [] };
      out[pid][key].push({
        v: row.result ?? row.result_text,
        unit: row.unit || "",
        d: row.test_date,
      });
    }
    res.json(out);
  } catch (e) {
    handleError(res, e, "GHM biomarkers");
  }
});

// GET /api/ghm-appointments — list by date + optional doctor
router.get("/ghm-appointments", async (req, res) => {
  try {
    const { date, doctor, status, mode, page = 1, limit = 50 } = req.query;
    const d = date || new Date().toISOString().split("T")[0];
    const effLimit = Math.min(100, Math.max(1, +limit || 50));
    const offset = (Math.max(1, +page) - 1) * effLimit;

    const params = [d];

    // A visit's OWN effective follow-up date, from whichever source has it, in
    // priority order: the follow_up_date column → the synced HealthRay
    // appointment value (biomarkers.followup) → the date extracted from the
    // prescription (healthray_follow_up.date). The last one is AI-extracted and
    // dirty (can hold "4 weeks", "today", "09/10/2025", "null", …), so it is
    // ONLY cast when it is a clean YYYY-MM-DD — an unguarded ::date would throw
    // and break the whole query.
    const ownFu = (a) => `COALESCE(
      ${a}.follow_up_date,
      NULLIF(${a}.biomarkers->>'followup', '')::date,
      CASE WHEN ${a}.healthray_follow_up->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
           THEN (${a}.healthray_follow_up->>'date')::date END
    )`;

    // Column list shared by every listing query. via_preferred and the per-row
    // follow-up/status date differ per mode, so each query appends its own.
    const baseCols = `a.id, a.appointment_date, a.time_slot, a.reporting_time_slot,
                a.doctor_name, a.patient_name, a.file_no, a.phone,
                a.visit_type, a.appointment_type, a.booking_source,
                a.booked_by_name, a.booking_date, a.condition, a.chief_complaint,
                a.insurance_taken, a.how_did_you_know, a.referred_by_doctor_name,
                a.earlier_slot_given, a.show_no_show, a.status,
                a.requested_by_cc, a.cc_remark_date, a.misc_notes,
                a.reports_uploaded, a.will_get_test_at_gini,
                a.whatsapp_message, a.additional_whatsapp_msg,
                a.notes, a.is_walkin, a.age, a.sex,
                a.call_status, a.call_made_by, a.call_date,
                a.call_notes, a.call_reschedule_date, a.pt_recovery, a.preferred_date, a.preferred_doctor,
                p.id AS patient_id, p.address, p.email,
                COALESCE(a.age, p.age) AS disp_age,
                COALESCE(a.sex, p.sex) AS disp_sex,
                a.healthray_follow_up,
                a.appointment_type AS mode_of_appointment,
                COALESCE(a.assigned_mo, c.mo_name) AS assigned_mo,
                COALESCE(a.prescription_explained_by, st.rx_explained_by) AS prescription_explained_by`;
    const joins = `FROM appointments a
         LEFT JOIN patients p ON p.file_no = a.file_no
         LEFT JOIN consultations c ON c.id = a.consultation_id
         LEFT JOIN station_tracking st ON st.appointment_id = a.id`;

    // lookup: a date-INDEPENDENT patient search. Type a name / file no / phone and
    // every matching patient shows up (one row each — their latest visit) with their
    // current follow-up/booking status, regardless of which date is selected. This is
    // how a patient who forgot to book a follow-up is found: they appear here even
    // though they are on no date's calling list. follow_up_date here = the patient's
    // soonest upcoming booking or advised follow-up; NULL = nothing booked.
    if (mode === "lookup") {
      const q = (req.query.q || "").trim();
      if (q.length < 2) {
        return res.json({ data: [], total: 0, page: +page, limit: effLimit, totalPages: 0 });
      }
      // Tokenise on whitespace and require EVERY word to match (in name, file no,
      // or phone). A single `ILIKE '%surinder jit%'` fails on real data where the
      // name is stored as "Surinder  jit" (double space) or in another word order;
      // matching each word independently is robust to spacing and ordering.
      const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
      const tokenConds = tokens
        .map(
          (_, i) =>
            `(a.patient_name ILIKE $${i + 1} OR a.file_no ILIKE $${i + 1} OR a.phone ILIKE $${i + 1})`,
        )
        .join(" AND ");
      const searchWhere = `WHERE (${tokenConds})`;
      const likeParams = tokens.map((t) => `%${t}%`);
      // Param slots after the token params: date (for "upcoming" status), limit, offset.
      const dIdx = tokens.length + 1;
      const statusExpr = `(
        SELECT MIN(x) FROM (
          SELECT up.appointment_date AS x FROM appointments up
            WHERE up.file_no = a.file_no AND a.file_no IS NOT NULL AND up.appointment_date >= $${dIdx}
          UNION ALL
          SELECT ${ownFu("fu")} AS x FROM appointments fu
            WHERE fu.file_no = a.file_no AND a.file_no IS NOT NULL AND ${ownFu("fu")} >= $${dIdx}
        ) s
      )`;
      const [countR, dataR] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total FROM (
             SELECT DISTINCT COALESCE(a.file_no, a.id::text) FROM appointments a ${searchWhere}
           ) z`,
          likeParams,
        ),
        pool.query(
          `SELECT * FROM (
             SELECT DISTINCT ON (COALESCE(a.file_no, a.id::text))
                    ${baseCols},
                    FALSE AS via_preferred,
                    ${statusExpr} AS follow_up_date
             ${joins}
             ${searchWhere}
             ORDER BY COALESCE(a.file_no, a.id::text), a.appointment_date DESC, a.created_at DESC
           ) t
           -- file_no + id tiebreakers give a TOTAL order so OFFSET paging is
           -- stable — many patients share an identical name, and ordering by name
           -- alone lets rows repeat or be skipped across pages.
           ORDER BY t.patient_name ASC, t.file_no ASC NULLS LAST, t.id ASC
           LIMIT $${dIdx + 1} OFFSET $${dIdx + 2}`,
          [...likeParams, d, effLimit, offset],
        ),
      ]);
      const total = countR.rows[0]?.total || 0;
      return res.json({
        data: dataR.rows,
        total,
        page: +page,
        limit: effLimit,
        totalPages: Math.ceil(total / effLimit),
      });
    }

    // Two date-based listing modes:
    //  - followup: patients whose CURRENT advised follow-up date is this date
    //    (the follow-up calling list), matched on the visit's effective follow-up
    //    date (any source). Only the patient's LATEST follow-up-bearing visit
    //    counts, so a stale follow-up from an earlier visit can't drag the
    //    patient onto a date a more recent visit has already superseded.
    //    PLUS any visit whose preferred_date is this date — if the patient asked
    //    to come on the 13th while their advised follow-up is the 18th, they need
    //    to show on the 13th's calling list too.
    //  - default: appointments booked on this date OR patients whose preferred
    //    date is this date.
    let where;
    // a.id tiebreaker keeps OFFSET paging stable when time_slot/created_at tie.
    const orderBy = `ORDER BY a.time_slot ASC NULLS LAST, a.created_at ASC, a.id ASC`;
    if (mode === "followup") {
      // Logically: (follow-up due on $1 AND it's the latest follow-up visit)
      //            OR (preferred_date is $1).
      // Written as two ANDed OR-groups so the planner filters to the small set of
      // rows matching $1 FIRST (both predicates are cheap, non-subquery), and only
      // then evaluates the correlated "latest visit" subquery for that handful —
      // an `(… OR preferred_date)` at the top level made it scan the whole table.
      where = `WHERE (${ownFu("a")} = $1 OR a.preferred_date = $1)
             AND (
               a.preferred_date = $1
               OR a.file_no IS NULL
               OR a.appointment_date = (
                 SELECT MAX(prev.appointment_date)
                 FROM appointments prev
                 WHERE prev.file_no = a.file_no
                   AND ${ownFu("prev")} IS NOT NULL
               )
             )`;
    } else {
      where = `WHERE (a.appointment_date = $1 OR a.preferred_date = $1)`;
    }
    if (doctor) {
      // Filter by doctor matches EITHER the appointment's doctor OR the patient's
      // preferred doctor — so re-assigning a preferred doctor surfaces the patient
      // under that doctor's filter.
      params.push(`%${doctor}%`);
      where += ` AND (a.doctor_name ILIKE $${params.length} OR a.preferred_doctor ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }
    // Free-text search across name / file no / phone / condition. Tokenised on
    // whitespace with every word required (same robust matching as lookup mode),
    // so it survives odd spacing and word order. Filtering server-side means the
    // search spans the WHOLE date — not just the rows already paged into the UI.
    const q = (req.query.q || "").trim();
    if (q.length >= 2) {
      for (const t of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
        params.push(`%${t}%`);
        where += ` AND (a.patient_name ILIKE $${params.length} OR a.file_no ILIKE $${params.length} OR a.phone ILIKE $${params.length} OR a.condition ILIKE $${params.length})`;
      }
    }

    const [countR, dataR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM appointments a ${where}`, params),
      pool.query(
        `SELECT ${baseCols},
                (a.preferred_date = $1 AND a.appointment_date <> $1) AS via_preferred,
                -- Follow-up date shown for THIS visit:
                --   1. the visit's OWN effective follow-up date (column, synced
                --      HealthRay appointment value, or prescription-extracted date —
                --      see ownFu above). This covers freshly-seen patients whose
                --      column hasn't been backfilled yet.
                --   2. else the latest PRIOR visit's effective follow-up — but only
                --      if it is still pending (>= this visit's date). A prior
                --      follow-up that already passed before this appointment is
                --      stale (e.g. an upcoming/unseen visit would otherwise show a
                --      months-old follow-up date).
                COALESCE(
                  ${ownFu("a")},
                  (SELECT prev.follow_up_date
                   FROM appointments prev
                   WHERE prev.file_no = a.file_no
                     AND prev.file_no IS NOT NULL
                     AND prev.follow_up_date IS NOT NULL
                     AND prev.appointment_date <= a.appointment_date
                     AND prev.follow_up_date >= a.appointment_date
                   ORDER BY prev.appointment_date DESC
                   LIMIT 1)
                ) AS follow_up_date
         ${joins}
         ${where}
         ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, effLimit, offset],
      ),
    ]);

    const total = countR.rows[0]?.total || 0;
    res.json({
      data: dataR.rows,
      total,
      page: +page,
      limit: effLimit,
      totalPages: Math.ceil(total / effLimit),
    });
  } catch (e) {
    handleError(res, e, "GHM appointments list");
  }
});

// POST /api/ghm-appointments — create with full GHM fields + auto WhatsApp
router.post("/ghm-appointments", async (req, res) => {
  try {
    const {
      patient_name,
      file_no,
      phone,
      doctor_name,
      appointment_date,
      time_slot,
      visit_type = "New",
      appointment_type = "Physical",
      booking_source = "OBT",
      booked_by_name,
      booking_date,
      insurance_taken,
      how_did_you_know,
      referred_by_doctor_name,
      earlier_slot_given = false,
      condition,
      chief_complaint,
      misc_notes,
      reports_uploaded = false,
      will_get_test_at_gini,
      requested_by_cc,
      cc_remark_date,
      notes,
      is_walkin = false,
    } = req.body;

    if (!patient_name || !appointment_date || !doctor_name)
      return res
        .status(400)
        .json({ error: "patient_name, appointment_date, doctor_name required" });

    // Resolve patient_id — by file_no, then phone. If still none, register a
    // brand-new patient (auto-generates a GNI-xxxxx file_no).
    let patient_id = null;
    let resolved_file_no = file_no || null;

    if (file_no) {
      const pr = await pool.query("SELECT id FROM patients WHERE file_no=$1 LIMIT 1", [file_no]);
      patient_id = pr.rows[0]?.id || null;
    }
    if (!patient_id && phone) {
      const pr = await pool.query("SELECT id, file_no FROM patients WHERE phone=$1 LIMIT 1", [
        phone,
      ]);
      if (pr.rows[0]) {
        patient_id = pr.rows[0].id;
        resolved_file_no = resolved_file_no || pr.rows[0].file_no;
      }
    }
    // New patient — create a master record so they're tracked permanently
    if (!patient_id) {
      let newFileNo = file_no;
      if (!newFileNo) {
        const seq = await pool.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(file_no FROM 'GNI-([0-9]+)') AS INTEGER)), 0) + 1 AS next
           FROM patients WHERE file_no ~ '^GNI-[0-9]+$'`,
        );
        newFileNo = `GNI-${String(seq.rows[0].next).padStart(5, "0")}`;
      }
      const created = await pool.query(
        `INSERT INTO patients (name, phone, file_no)
         VALUES ($1, $2, $3) RETURNING id, file_no`,
        [patient_name, phone || null, newFileNo],
      );
      patient_id = created.rows[0].id;
      resolved_file_no = created.rows[0].file_no;
    }

    // Availability gate (no-op unless SCHEDULE_ENFORCEMENT=warn|strict). Only
    // catalog slots are enforced; unknown doctor/slot passes through.
    const gateDoctorId = await resolveDoctorIdByName(doctor_name);
    const avail = await checkBookingAvailability({
      doctorId: gateDoctorId,
      date: appointment_date,
      slot: time_slot,
      force: req.body.force,
      role: req.doctor?.role,
    });
    if (avail?.blocked) {
      return res.status(409).json({
        error: "doctor_unavailable",
        reason: avail.reason,
        detail: avail.detail || null,
      });
    }

    // Auto-generate reporting slot and WhatsApp message
    const reporting_time_slot = REPORTING_MAP[time_slot] || time_slot;
    const { whatsapp_message, additional_whatsapp_msg } = buildWhatsappMessage({
      patient_name,
      doctor_name,
      appointment_date,
      time_slot,
      visit_type,
    });

    const r = await pool.query(
      `INSERT INTO appointments (
        patient_id, patient_name, file_no, phone, doctor_name,
        appointment_date, time_slot, reporting_time_slot,
        visit_type, appointment_type, booking_source,
        booked_by_name, booking_date, insurance_taken,
        how_did_you_know, referred_by_doctor_name,
        earlier_slot_given, condition, chief_complaint,
        misc_notes, reports_uploaded, will_get_test_at_gini,
        requested_by_cc, cc_remark_date, notes, is_walkin,
        whatsapp_message, additional_whatsapp_msg, status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,'scheduled'
      ) RETURNING *`,
      [
        patient_id,
        patient_name,
        resolved_file_no,
        phone,
        doctor_name,
        appointment_date,
        time_slot,
        reporting_time_slot,
        visit_type,
        appointment_type,
        booking_source,
        booked_by_name,
        booking_date || appointment_date,
        insurance_taken,
        how_did_you_know,
        referred_by_doctor_name,
        earlier_slot_given,
        condition,
        chief_complaint,
        misc_notes,
        reports_uploaded,
        will_get_test_at_gini,
        requested_by_cc,
        cc_remark_date,
        notes,
        is_walkin,
        whatsapp_message,
        additional_whatsapp_msg,
      ],
    );

    // Increment slot booked_count
    if (time_slot && doctor_name) {
      await pool.query(
        `UPDATE appointment_slots
         SET booked_count = booked_count + 1
         WHERE doctor_name=$1 AND slot_date=$2 AND time_slot=$3`,
        [doctor_name, appointment_date, time_slot],
      );
    }

    if (avail?.warn && r.rows[0]) {
      r.rows[0]._availability_warning = { reason: avail.reason, detail: avail.detail || null };
      console.warn(
        `[GHM] availability WARN: ${doctor_name} ${appointment_date} ${time_slot} -> ${avail.reason}`,
      );
    }
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "GHM appointment create");
  }
});

// PATCH /api/ghm-appointments/:id — update GHM fields
router.patch("/ghm-appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      "time_slot",
      "reporting_time_slot",
      "doctor_name",
      "appointment_date",
      "visit_type",
      "appointment_type",
      "booking_source",
      "booked_by_name",
      "booking_date",
      "insurance_taken",
      "how_did_you_know",
      "referred_by_doctor_name",
      "earlier_slot_given",
      "condition",
      "chief_complaint",
      "misc_notes",
      "reports_uploaded",
      "will_get_test_at_gini",
      "requested_by_cc",
      "cc_remark_date",
      "show_no_show",
      "status",
      "notes",
      "call_status",
      "call_made_by",
      "call_date",
      "call_notes",
      "call_reschedule_date",
      "pt_recovery",
      "preferred_date",
      "preferred_doctor",
      "assigned_mo",
      "prescription_explained_by",
    ];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (key in req.body) {
        // Empty string → NULL so DATE/numeric columns can be cleared
        const v = req.body[key] === "" ? null : req.body[key];
        vals.push(v);
        sets.push(`${key}=$${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

    // If a doctor field is being changed, record the old value first (for audit log)
    const TRACK = {
      doctor_name: "Assigned Doctor",
      preferred_doctor: "Preferred Doctor",
      preferred_date: "Preferred Date",
      call_made_by: "Called By",
    };
    const trackingNow = Object.keys(TRACK).filter((k) => k in req.body);
    let before = {};
    if (trackingNow.length) {
      const prev = await pool.query(
        `SELECT ${trackingNow.join(",")} FROM appointments WHERE id=$1`,
        [id],
      );
      before = prev.rows[0] || {};
    }

    vals.push(id);
    const r = await pool.query(
      `UPDATE appointments SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    // Log doctor changes
    for (const k of trackingNow) {
      const oldV = before[k] || "";
      const newV = req.body[k] || "";
      if (oldV !== newV) {
        await pool.query(
          `INSERT INTO appointment_change_log (appointment_id, field, field_label, old_value, new_value)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, k, TRACK[k], oldV || null, newV || null],
        );
      }
    }

    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "GHM appointment update");
  }
});

// GET /api/appointment-changes?appointment_id=X — doctor change history
router.get("/appointment-changes", async (req, res) => {
  try {
    const { appointment_id } = req.query;
    if (!appointment_id) return res.status(400).json({ error: "appointment_id required" });
    const r = await pool.query(
      `SELECT * FROM appointment_change_log WHERE appointment_id=$1
       ORDER BY changed_at DESC, id DESC`,
      [appointment_id],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Appointment changes list");
  }
});

// DELETE /api/appointment-changes/:id — remove a doctor-change log entry
// Columns that may be reverted when their change log is deleted
const REVERTIBLE_FIELDS = new Set([
  "doctor_name",
  "preferred_doctor",
  "preferred_date",
  "call_made_by",
]);

router.delete("/appointment-changes/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT appointment_id, field, old_value, changed_at FROM appointment_change_log WHERE id=$1",
      [req.params.id],
    );
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Change log not found" });
    }
    const { appointment_id, field, old_value, changed_at } = found.rows[0];

    await client.query("DELETE FROM appointment_change_log WHERE id=$1", [req.params.id]);

    // Undo the change: if this was the LATEST change for that field, revert the
    // appointment's value back to what it was before (old_value).
    if (REVERTIBLE_FIELDS.has(field)) {
      const newer = await client.query(
        `SELECT 1 FROM appointment_change_log
         WHERE appointment_id=$1 AND field=$2 AND changed_at > $3
         LIMIT 1`,
        [appointment_id, field, changed_at],
      );
      if (!newer.rows.length) {
        await client.query(`UPDATE appointments SET ${field} = $1 WHERE id = $2`, [
          old_value || null,
          appointment_id,
        ]);
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, reverted_field: field, appointment_id });
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Appointment change delete");
  } finally {
    client.release();
  }
});

// GET /api/ghm-appointments/whatsapp-preview — preview generated message
router.get("/ghm-appointments/whatsapp-preview", (req, res) => {
  const { patient_name, doctor_name, appointment_date, time_slot, visit_type } = req.query;
  if (!patient_name || !doctor_name || !appointment_date || !time_slot)
    return res
      .status(400)
      .json({ error: "patient_name, doctor_name, appointment_date, time_slot required" });
  const msgs = buildWhatsappMessage({
    patient_name,
    doctor_name,
    appointment_date,
    time_slot,
    visit_type,
  });
  res.json({ ...msgs, reporting_time_slot: REPORTING_MAP[time_slot] || time_slot });
});

export default router;
