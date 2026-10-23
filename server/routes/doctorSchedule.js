// ============================================================================
// Doctor Management & Availability routes (per-date availability model).
//
// A doctor's availability is an explicit set of (date, slot) entries they mark.
// Leave / emergency / clinic holiday / capacity layer on top. Booking is gated
// by the resolver in services/availability.js.
//
// Write endpoints are guarded by CAPABILITIES.ADMIN (manage doctors). While
// GRANT_ALL_CAPABILITIES is true (shared/permissions.js) the guard is
// permissive — it activates when the role matrix is enabled.
// ============================================================================
import { Router } from "express";
import pool from "../config/db.js";
import {
  holdIfOverLimit,
  overLimitFor,
  patientTypeFor,
  slotOfAppointment,
} from "../services/slots/capacityGuard.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";
import {
  breakCreateSchema,
  unavailabilityCreateSchema,
  unavailabilityUpdateSchema,
  emergencyLeaveSchema,
  reassignBulkSchema,
  reassignSingleSchema,
  slotTemplateSchema,
  slotTemplateApplySchema,
  slotTemplateClearSchema,
  slotDateCapsSchema,
} from "../schemas/index.js";
import { clearDateCap, saveDateCaps } from "../services/slots/dateCaps.js";
import {
  isSlotAvailable,
  getDoctorDayView,
  findAvailableDoctors,
  getAffectedAssignments,
  resolveDoctor,
} from "../services/availability.js";
import {
  clearScheduleFrom,
  clearsReady,
  insertTemplateVersion,
  laterVersions,
  withdrawLaterVersions,
  istToday,
  templateErrors,
  withdrawFutureVersion,
} from "../services/slots/templateWrites.js";
import { templateVersions } from "../services/slots/templateStore.js";
import { bookingsOutsideTemplate } from "../services/slots/bookingImpact.js";
import {
  APPLY_BATCH,
  applyBatch,
  previewApply,
  scheduledDoctors,
} from "../services/slots/applyTemplate.js";
import { SCHEDULED_ROLES } from "../../shared/staffRoles.js";
import { actorOf, logFieldChanges } from "../services/appointmentHistory.js";

const router = Router();
const admin = requireCapability(CAPABILITIES.ADMIN);

const publicDay = (day) => ({
  slots: day.slots,
  warnings: day.warnings || [],
  unreadable: day.unreadable || 0,
  orphan_overrides: day.orphanOverrides || [],
  from_template: !!day.fromTemplate,
});

// A doctor can't have two overlapping time-off entries (leave/holiday/emergency
// can't coexist on the same dates). Returns the clashing row, or null.
async function findOverlappingTimeOff(doctorId, startDate, endDate, client = pool) {
  const r = await client.query(
    `SELECT type FROM doctor_unavailability
      WHERE doctor_id=$1 AND status='active'
        AND type IN ('leave','holiday','emergency')
        AND start_date <= $3 AND end_date >= $2
      ORDER BY start_date LIMIT 1`,
    [doctorId, startDate, endDate],
  );
  return r.rows[0] || null;
}

// ───────────────────────── Slot catalog ─────────────────────────
router.get("/slot-catalog", async (_req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, label, start_time, end_time, sort_order, is_active FROM slot_catalog WHERE is_active ORDER BY sort_order",
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Slot catalog list");
  }
});

// ───────────────────────── Working profile ──────────────────────
// A doctor is available by default; the profile customizes the recurring
// picture (days off, working slots, lunch break). Returns defaults if unset.
router.get("/doctors/:id/profile", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT off_weekdays, work_start, work_end, lunch_start, lunch_end FROM doctor_profile WHERE doctor_id=$1",
      [req.params.id],
    );
    res.json(
      r.rows[0] || {
        off_weekdays: [0],
        work_start: null,
        work_end: null,
        lunch_start: null,
        lunch_end: null,
      },
    );
  } catch (e) {
    handleError(res, e, "Profile get");
  }
});

// ───────────────────────── Slot templates ───────────────────────
router.get("/doctors/:id/slot-templates", async (req, res) => {
  try {
    const versions = await templateVersions(parseInt(req.params.id, 10));
    const today = istToday();
    const current = versions.find((v) => v.status === "active" && v.effectiveFrom <= today);
    res.json({
      today,
      current_id: current && !current.clears ? current.id : null,
      cleared_from: current?.clears ? current.effectiveFrom : null,
      versions,
    });
  } catch (e) {
    handleError(res, e, "Slot templates list");
  }
});

const scheduledDoctor = async (req, res) => {
  const doctor = await resolveDoctor(parseInt(req.params.id, 10));
  if (!doctor) {
    res.status(404).json({ error: "Doctor not found" });
    return null;
  }
  if (!SCHEDULED_ROLES.includes(doctor.role)) {
    res
      .status(400)
      .json({ error: "Schedules are kept for consultants and medical officers only." });
    return null;
  }
  return doctor;
};

const refuseTemplate = (req, res) => {
  if (req.body.effective_from < istToday()) {
    res.status(400).json({
      error: "A schedule can't start in the past. Pick today or a later date.",
      errors: [{ field: "effective_from", message: "Pick today or a later date." }],
    });
    return true;
  }
  const invalid = templateErrors(req.body.template);
  if (invalid) {
    res.status(400).json({ error: invalid.message, errors: invalid.errors });
    return true;
  }
  return false;
};

const replacedVersion = (v) => ({ effectiveFrom: v.effective_from, clears: v.clears });

router.post(
  "/doctors/:id/slot-templates/check",
  admin,
  validate(slotTemplateSchema),
  async (req, res) => {
    try {
      const doctor = await scheduledDoctor(req, res);
      if (!doctor || refuseTemplate(req, res)) return;
      const [impact, replaces] = await Promise.all([
        bookingsOutsideTemplate(doctor.id, req.body.template, req.body.effective_from),
        laterVersions([doctor.id], req.body.effective_from, null, { client: pool }),
      ]);
      res.json({ ...impact, replaces: replaces.map(replacedVersion) });
    } catch (e) {
      handleError(res, e, "Slot template check");
    }
  },
);

router.post(
  "/doctors/:id/slot-templates",
  admin,
  validate(slotTemplateSchema),
  async (req, res) => {
    const doctor = await scheduledDoctor(req, res).catch((e) =>
      handleError(res, e, "Slot template save"),
    );
    if (!doctor || refuseTemplate(req, res)) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const replaced = await withdrawLaterVersions(
        client,
        doctor.id,
        req.body.effective_from,
        null,
        req.doctor?.doctor_id ?? null,
      );
      const id = await insertTemplateVersion(client, doctor.id, req.body.template, {
        effectiveFrom: req.body.effective_from,
        note: req.body.note?.trim() || null,
        actorId: req.doctor?.doctor_id ?? null,
      });
      const impact = await bookingsOutsideTemplate(
        doctor.id,
        req.body.template,
        req.body.effective_from,
        { client },
      );
      await client.query("COMMIT");
      res.status(201).json({ id, replaced, ...impact });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Slot template save");
    } finally {
      client.release();
    }
  },
);

router.post(
  "/doctors/:id/slot-templates/clear",
  admin,
  validate(slotTemplateClearSchema),
  async (req, res) => {
    const doctor = await scheduledDoctor(req, res).catch((e) =>
      handleError(res, e, "Slot template clear"),
    );
    if (!doctor) return;
    if (req.body.effective_from < istToday())
      return res.status(400).json({
        error: "A schedule can't be cleared in the past. Pick today or a later date.",
      });
    if (!(await clearsReady()))
      return res.status(503).json({
        error:
          "Clear schedule isn't switched on yet: its one-time database update hasn't been run. Run it and try again.",
      });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await clearScheduleFrom(client, doctor.id, {
        effectiveFrom: req.body.effective_from,
        actorId: req.doctor?.doctor_id ?? null,
      });
      await client.query("COMMIT");
      res.json(result);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Slot template clear");
    } finally {
      client.release();
    }
  },
);

router.post("/doctors/:id/slot-templates/:templateId/withdraw", admin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await withdrawFutureVersion(
      client,
      parseInt(req.params.id, 10),
      parseInt(req.params.templateId, 10),
      req.doctor?.doctor_id ?? null,
    );
    await client.query("COMMIT");
    res.json({ withdrawn: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Slot template withdraw");
  } finally {
    client.release();
  }
});

router.post(
  "/doctor-slot-templates/apply",
  admin,
  validate(slotTemplateApplySchema),
  async (req, res) => {
    try {
      if (refuseTemplate(req, res)) return;
      const { doctor_ids, all, dry_run, template, effective_from, note } = req.body;
      const until = req.body.effective_until || null;
      if (until && until < effective_from)
        return res.status(400).json({
          error: "The end date must be on or after the start date.",
          errors: [
            { field: "effective_until", message: "Pick a date on or after the start date." },
          ],
        });
      if (!all && !doctor_ids?.length)
        return res.status(400).json({ error: "Choose at least one doctor." });
      const doctors = await scheduledDoctors(all ? null : doctor_ids);
      if (!doctors.length)
        return res.status(400).json({ error: "None of the chosen staff are consultants or MOs." });
      if (dry_run)
        return res.json({
          doctors: await previewApply(doctors, template, effective_from, until),
        });
      if (all || doctors.length > APPLY_BATCH)
        return res.status(400).json({
          error: `Save at most ${APPLY_BATCH} doctors at a time.`,
        });
      res.json(
        await applyBatch(doctors, template, effective_from, {
          note: note?.trim() || null,
          actorId: req.doctor?.doctor_id ?? null,
          until,
        }),
      );
    } catch (e) {
      handleError(res, e, "Slot template apply");
    }
  },
);

// ───────────────────── Leave / unavailability ───────────────────
router.get("/doctors/time-off-today", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (doctor_id) doctor_id, type, reason
         FROM doctor_unavailability
        WHERE status = 'active' AND type IN ('leave','holiday','emergency')
          AND slot_labels IS NULL AND start_time IS NULL
          AND start_date <= $1::date AND end_date >= $1::date
        ORDER BY doctor_id, (type = 'emergency') DESC`,
      [istToday()],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Time off today");
  }
});

router.get("/doctors/:id/unavailability", async (req, res) => {
  try {
    const { from, to, scope } = req.query;
    const params = [req.params.id];
    let where = scope === "all" ? "WHERE doctor_id=$1" : "WHERE doctor_id=$1 AND status='active'";
    if (from && to) {
      params.push(from, to);
      where += ` AND end_date >= $2 AND start_date <= $3`;
    }
    const r = await pool.query(
      `SELECT * FROM doctor_unavailability ${where} ORDER BY start_date`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Unavailability list");
  }
});

// Create planned leave / per-doctor holiday. If patients are already booked in
// the window, return them so the UI can offer reassignment.
router.post(
  "/doctors/:id/unavailability",
  admin,
  validate(unavailabilityCreateSchema),
  async (req, res) => {
    try {
      const doctorId = parseInt(req.params.id, 10);
      const doctor = await resolveDoctor(doctorId);
      if (!doctor) return res.status(404).json({ error: "Doctor not found" });
      const { type, start_date, end_date, slot_labels, reason } = req.body;

      const clash = await findOverlappingTimeOff(doctorId, start_date, end_date);
      if (clash)
        return res.status(409).json({
          error: "overlap",
          message: `Doctor already has "${clash.type}" time off overlapping these dates. Cancel it first.`,
        });

      const ins = await pool.query(
        `INSERT INTO doctor_unavailability
           (doctor_id, doctor_name, type, start_date, end_date, slot_labels, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          doctorId,
          doctor.name,
          type,
          start_date,
          end_date,
          slot_labels || null,
          reason || null,
          req.doctor?.doctor_name || null,
        ],
      );

      const affected = await getAffectedAssignments(doctorId, {
        startDate: start_date,
        endDate: end_date,
        slotLabels: slot_labels || null,
      });

      res.status(201).json({
        unavailability: ins.rows[0],
        affected,
        requires_reassignment: affected.length > 0,
      });
    } catch (e) {
      handleError(res, e, "Unavailability create");
    }
  },
);

router.patch(
  "/doctors/:id/unavailability/:uid",
  admin,
  validate(unavailabilityUpdateSchema),
  async (req, res) => {
    try {
      const { start_date, end_date, slot_labels, reason, status } = req.body;
      const r = await pool.query(
        `UPDATE doctor_unavailability
            SET start_date=COALESCE($1,start_date),
                end_date=COALESCE($2,end_date),
                slot_labels=CASE WHEN $8 THEN $3 ELSE slot_labels END,
                reason=COALESCE($4,reason),
                status=COALESCE($5,status)
          WHERE id=$6 AND doctor_id=$7 RETURNING *`,
        [
          start_date || null,
          end_date || null,
          slot_labels === undefined ? null : slot_labels,
          reason || null,
          status || null,
          req.params.uid,
          req.params.id,
          slot_labels !== undefined,
        ],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not found" });
      res.json(r.rows[0]);
    } catch (e) {
      handleError(res, e, "Unavailability update");
    }
  },
);

// ───────────────────────── Break ────────────────────────────────
// A break is a slot-scoped unavailability (lunch, admin time). Slots required.
// If patients are already booked in those slots, they're returned for reassign.
router.post("/doctors/:id/break", admin, validate(breakCreateSchema), async (req, res) => {
  try {
    const doctorId = parseInt(req.params.id, 10);
    const doctor = await resolveDoctor(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });
    const { start_date, end_date, slot_labels, reason } = req.body;

    // A full-day leave/holiday on any overlapping day already covers the whole
    // day — a break would be meaningless, so reject it.
    const fd = await pool.query(
      `SELECT type, start_date FROM doctor_unavailability
        WHERE doctor_id=$1 AND status='active' AND slot_labels IS NULL
          AND start_date <= $3 AND end_date >= $2
        LIMIT 1`,
      [doctorId, start_date, end_date],
    );
    if (fd.rows.length) {
      return res.status(409).json({
        error: "on_leave",
        message: `Doctor already has full-day ${fd.rows[0].type} in this range — cannot add a break.`,
      });
    }

    const ins = await pool.query(
      `INSERT INTO doctor_unavailability
         (doctor_id, doctor_name, type, start_date, end_date, slot_labels, reason, created_by)
       VALUES ($1,$2,'break',$3,$4,$5,$6,$7) RETURNING *`,
      [
        doctorId,
        doctor.name,
        start_date,
        end_date,
        slot_labels,
        reason || "Break",
        req.doctor?.doctor_name || null,
      ],
    );

    const affected = await getAffectedAssignments(doctorId, {
      startDate: start_date,
      endDate: end_date,
      slotLabels: slot_labels,
    });

    res.status(201).json({
      unavailability: ins.rows[0],
      affected,
      requires_reassignment: affected.length > 0,
    });
  } catch (e) {
    handleError(res, e, "Break create");
  }
});

// ───────────────────────── Emergency leave ──────────────────────
// Creates an emergency unavailability and returns affected patients, each with
// ranked reassignment suggestions.
router.post(
  "/doctors/:id/emergency-leave",
  admin,
  validate(emergencyLeaveSchema),
  async (req, res) => {
    try {
      const doctorId = parseInt(req.params.id, 10);
      const doctor = await resolveDoctor(doctorId);
      if (!doctor) return res.status(404).json({ error: "Doctor not found" });
      const { start_date, end_date, slot_labels, from_now, reason } = req.body;

      const clash = await findOverlappingTimeOff(doctorId, start_date, end_date);
      if (clash)
        return res.status(409).json({
          error: "overlap",
          message: `Doctor already has "${clash.type}" time off overlapping these dates. Cancel it first.`,
        });

      let effectiveSlots = slot_labels || null;
      if (from_now && !effectiveSlots) {
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        if (start_date !== today || end_date !== today)
          return res.status(400).json({
            error: "from_now_today_only",
            message:
              "“Only the rest of today” works for today's leave only. Untick it to block the whole date range.",
          });
        const now = new Date().toLocaleTimeString("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
        const day = await getDoctorDayView(doctorId, today);
        effectiveSlots = day.slots
          .filter((s) => s.blocked_by !== "break" && s.start_time.slice(0, 5) >= now)
          .map((s) => s.slot_label);
      }

      const ins = await pool.query(
        `INSERT INTO doctor_unavailability
           (doctor_id, doctor_name, type, start_date, end_date, slot_labels, reason, created_by)
         VALUES ($1,$2,'emergency',$3,$4,$5,$6,$7) RETURNING *`,
        [
          doctorId,
          doctor.name,
          start_date,
          end_date,
          effectiveSlots,
          reason || null,
          req.doctor?.doctor_name || null,
        ],
      );

      const affectedRaw = await getAffectedAssignments(doctorId, {
        startDate: start_date,
        endDate: end_date,
        slotLabels: effectiveSlots,
      });

      // Attach ranked suggestions per affected (skip in-progress — not movable).
      const affected = [];
      for (const a of affectedRaw) {
        const suggested = a.in_progress
          ? []
          : await findAvailableDoctors(a.appointment_date, a.time_slot, {
              excludeDoctorId: doctorId,
              role: doctor.role,
              specialty: doctor.specialty,
            });
        affected.push({ ...a, suggested_doctors: suggested });
      }

      res.status(201).json({
        unavailability_id: ins.rows[0].id,
        doctor: { id: doctor.id, name: doctor.name },
        affected,
        requires_reassignment: affected.some((a) => !a.in_progress),
      });
    } catch (e) {
      handleError(res, e, "Emergency leave");
    }
  },
);

// ───────────────────────── Availability (reads) ─────────────────
// Resolved day view for a doctor (booking UI + day verify). Annotated slots.
router.get("/doctors/:id/availability", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });
    const day = await getDoctorDayView(parseInt(req.params.id, 10), date);
    res.json({ date, ...publicDay(day) });
  } catch (e) {
    handleError(res, e, "Doctor availability");
  }
});

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

router.put(
  "/doctors/:id/slot-caps/:date",
  admin,
  validate(slotDateCapsSchema),
  async (req, res) => {
    try {
      const doctorId = parseInt(req.params.id, 10);
      const { date } = req.params;
      if (!isoDate.test(date)) return res.status(400).json({ error: "Pick a valid date." });
      const day = await getDoctorDayView(doctorId, date);
      if (!day.fromTemplate)
        return res
          .status(409)
          .json({ error: "Save a weekly schedule for this doctor before changing one date." });
      const starts = new Set(
        day.slots.filter((s) => s.caps).map((s) => String(s.start_time).slice(0, 5)),
      );
      const missing = req.body.slots.find((s) => !starts.has(s.start));
      if (missing)
        return res
          .status(400)
          .json({ error: `${missing.start} is not a slot on ${date}. Reload and try again.` });
      const saved = await saveDateCaps(doctorId, date, req.body, req.doctor?.doctor_id ?? null);
      res.json({ saved, ...publicDay(await getDoctorDayView(doctorId, date)) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      handleError(res, e, "Slot limits for one date");
    }
  },
);

router.delete("/doctors/:id/slot-caps/:date/:start", admin, async (req, res) => {
  try {
    const doctorId = parseInt(req.params.id, 10);
    const { date, start } = req.params;
    if (!isoDate.test(date) || !/^\d{2}:\d{2}$/.test(start))
      return res.status(400).json({ error: "Pick a valid date and slot." });
    await clearDateCap(doctorId, date, start);
    res.json(publicDay(await getDoctorDayView(doctorId, date)));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    handleError(res, e, "Slot limits for one date");
  }
});

// Same, but addressed by doctor NAME (booking modals work with names).
// resolved:false ⇒ the name isn't a known doctor → caller shows all slots.
router.get("/availability/day", async (req, res) => {
  try {
    const { doctor, date } = req.query;
    if (!doctor || !date) return res.status(400).json({ error: "doctor and date required" });
    const idR = await pool.query("SELECT resolve_doctor_id($1) AS id", [doctor]);
    const doctorId = idR.rows[0]?.id || null;
    if (!doctorId) return res.json({ resolved: false, date, slots: [] });
    const day = await getDoctorDayView(doctorId, date);
    const { patient_id, file_no, walkin, visit_type, exclude } = req.query;
    const known = patient_id || file_no || walkin === "1" || visit_type;
    const patient_type = known
      ? await patientTypeFor({
          patientId: patient_id,
          fileNo: file_no,
          date,
          walkin: walkin === "1",
          visitType: visit_type,
        })
      : null;
    const ownSlot = exclude ? await slotOfAppointment(parseInt(exclude, 10), doctorId, date) : null;
    const out = publicDay(day);
    if (patient_type)
      out.slots = out.slots.map((s) => ({
        ...s,
        patient_type,
        over_limit: overLimitFor(s, patient_type, s.slot_label === ownSlot ? 1 : 0),
      }));
    res.json({ resolved: true, date, patient_type, ...out });
  } catch (e) {
    handleError(res, e, "Availability by name");
  }
});

router.get("/availability/days", async (req, res) => {
  try {
    const pairs = String(req.query.pairs || "")
      .split(",")
      .map((p) => p.split("|"))
      .filter(([doctor, date]) => doctor && /^\d{4}-\d{2}-\d{2}$/.test(date || ""))
      .slice(0, 60);
    const out = {};
    for (const [doctor, date] of pairs) {
      const idR = await pool.query("SELECT resolve_doctor_id($1) AS id", [doctor]);
      const doctorId = idR.rows[0]?.id || null;
      const day = doctorId ? await getDoctorDayView(doctorId, date) : null;
      out[`${doctor}|${date}`] = day?.fromTemplate ? publicDay(day).slots : null;
    }
    res.json(out);
  } catch (e) {
    handleError(res, e, "Availability for several days");
  }
});

// Ranked doctors available for a date+slot (reassignment / booking picker).
router.get("/availability/doctors-for-slot", async (req, res) => {
  try {
    const { date, slot, exclude, role, specialty, appointment } = req.query;
    if (!date || !slot) return res.status(400).json({ error: "date and slot required" });
    const patientType = appointment
      ? await patientTypeFor({ appointmentId: parseInt(appointment, 10), date })
      : null;
    const list = await findAvailableDoctors(date, slot, {
      excludeDoctorId: exclude ? parseInt(exclude, 10) : null,
      role: role || null,
      specialty: specialty || null,
      patientType,
    });
    res.json(list);
  } catch (e) {
    handleError(res, e, "Doctors for slot");
  }
});

// ───────────────────────── Reassignment ─────────────────────────
async function applyMove(client, move, ctx) {
  const { appointment_id, to_doctor_id, to_doctor_name } = move;
  const apptR = await client.query("SELECT * FROM appointments WHERE id=$1", [appointment_id]);
  const appt = apptR.rows[0];
  if (!appt) return { appointment_id, error: "not_found" };

  // Re-check the target is still free (it may have filled meanwhile).
  const avail = await isSlotAvailable(to_doctor_id, appt.appointment_date, appt.time_slot, {
    client,
  });
  if (!avail.available)
    return { appointment_id, error: avail.reason === "full" ? "target_full" : avail.reason };

  const fromDoctorId = appt.doctor_id || null;
  const toSlot = !appt.healthray_id && avail.slot_label ? avail.slot_label : appt.time_slot;
  await client.query(
    "UPDATE appointments SET doctor_name=$1, doctor_id=$2, time_slot=$3 WHERE id=$4",
    [to_doctor_name, to_doctor_id, toSlot, appointment_id],
  );
  // Mirror to the live OPD queue card if the patient is already checked in.
  const approval = await holdIfOverLimit(appointment_id, {
    actor: ctx.actor,
    client,
    reason: move.over_limit_reason,
  });
  await client.query(
    "UPDATE active_visits SET doctor_name=$1, doctor_id=$2 WHERE appointment_id=$3",
    [to_doctor_name, to_doctor_id, appointment_id],
  );
  await client.query(
    `INSERT INTO appointment_reassignments
       (appointment_id, patient_id, file_no, appointment_date, time_slot,
        from_doctor_name, from_doctor_id, to_doctor_name, to_doctor_id,
        trigger, unavailability_id, reason, reassigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      appointment_id,
      appt.patient_id,
      appt.file_no,
      appt.appointment_date,
      appt.time_slot,
      appt.doctor_name,
      fromDoctorId,
      to_doctor_name,
      to_doctor_id,
      ctx.trigger || "manual",
      ctx.unavailability_id || null,
      ctx.reason || null,
      ctx.reassigned_by || null,
    ],
  );
  return {
    appointment_id,
    to_doctor_id,
    to_doctor_name,
    time_slot: toSlot,
    approval,
    moved: true,
  };
}

async function movePreferredPlan(client, move, ctx) {
  const { appointment_id, to_doctor_id, to_doctor_name } = move;
  const appt = (
    await client.query("SELECT * FROM appointments WHERE id=$1 FOR UPDATE", [appointment_id])
  ).rows[0];
  if (!appt) return { appointment_id, error: "not_found" };
  const date = String(appt.preferred_date || "").slice(0, 10);
  if (!date || !appt.preferred_time_slot) return { appointment_id, error: "no_preferred_plan" };
  const avail = await isSlotAvailable(to_doctor_id, date, appt.preferred_time_slot, { client });
  if (!avail.available)
    return { appointment_id, error: avail.reason === "full" ? "target_full" : avail.reason };
  const fromDoctor = appt.preferred_doctor?.trim() || appt.doctor_name;
  const after = {
    preferred_doctor: to_doctor_name,
    preferred_time_slot: avail.slot_label || appt.preferred_time_slot,
  };
  await client.query(
    "UPDATE appointments SET preferred_doctor=$1, preferred_time_slot=$2 WHERE id=$3",
    [after.preferred_doctor, after.preferred_time_slot, appointment_id],
  );
  await logFieldChanges(
    client,
    appointment_id,
    appt,
    after,
    { preferred_doctor: "Preferred Doctor", preferred_time_slot: "Time Slot" },
    ctx.editor,
  );
  await client.query(
    `INSERT INTO appointment_reassignments
       (appointment_id, patient_id, file_no, appointment_date, time_slot,
        from_doctor_name, from_doctor_id, to_doctor_name, to_doctor_id,
        trigger, unavailability_id, reason, reassigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,resolve_doctor_id($6),$7,$8,$9,$10,$11,$12)`,
    [
      appointment_id,
      appt.patient_id,
      appt.file_no,
      date,
      appt.preferred_time_slot,
      fromDoctor,
      to_doctor_name,
      to_doctor_id,
      ctx.trigger || "manual",
      ctx.unavailability_id || null,
      ctx.reason || null,
      ctx.reassigned_by || null,
    ],
  );
  return {
    appointment_id,
    to_doctor_id,
    to_doctor_name,
    time_slot: after.preferred_time_slot,
    plan: "preferred",
    moved: true,
  };
}

// Bulk reassign (emergency / planned).
router.post("/appointments/reassign", admin, validate(reassignBulkSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { moves, trigger, unavailability_id, reason } = req.body;
    const ctx = {
      trigger,
      unavailability_id,
      reason,
      reassigned_by: req.doctor?.doctor_name || null,
      actor: req.doctor,
    };
    const moved = [];
    const failed = [];
    for (const m of moves) {
      await client.query("BEGIN");
      try {
        const r = await applyMove(client, m, ctx);
        if (r.moved) {
          await client.query("COMMIT");
          moved.push(r);
        } else {
          await client.query("ROLLBACK");
          failed.push(r);
        }
      } catch (inner) {
        await client.query("ROLLBACK").catch(() => {});
        failed.push({ appointment_id: m.appointment_id, error: inner.message });
      }
    }

    // Mark the window cleared only if nothing failed.
    if (unavailability_id && failed.length === 0) {
      await client.query("UPDATE doctor_unavailability SET reassignment_done=true WHERE id=$1", [
        unavailability_id,
      ]);
    }
    res.json({ moved, failed });
  } catch (e) {
    handleError(res, e, "Bulk reassign");
  } finally {
    client.release();
  }
});

// Single manual reassign.
router.put(
  "/appointments/:id/reassign",
  admin,
  validate(reassignSingleSchema),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await (req.body.plan === "preferred" ? movePreferredPlan : applyMove)(
        client,
        {
          appointment_id: parseInt(req.params.id, 10),
          to_doctor_id: req.body.to_doctor_id,
          to_doctor_name: req.body.to_doctor_name,
          over_limit_reason: req.body.over_limit_reason,
        },
        {
          trigger: req.body.trigger || "manual",
          reason: req.body.reason,
          reassigned_by: req.doctor?.doctor_name || null,
          actor: req.doctor,
          editor: actorOf(req),
        },
      );
      if (r.moved) {
        await client.query("COMMIT");
        res.json(r);
      } else {
        await client.query("ROLLBACK");
        res.status(409).json(r);
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Single reassign");
    } finally {
      client.release();
    }
  },
);

export default router;
