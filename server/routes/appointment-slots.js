import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// Standard time slots
export const TIME_SLOTS = [
  "9:30 AM to 10 AM",
  "10 AM to 11 AM",
  "11 AM to 12 PM",
  "12 PM to 1 PM",
  "1 PM to 2 PM",
  "2 PM to 2:30 PM",
  "2:30 PM to 3 PM",
  "3 PM to 3:30 PM",
  "3:30 PM to 4 PM",
];

// GET /api/appointment-slots?date=2026-06-02&doctor=Dr.+Anil+Bhansali
router.get("/appointment-slots", async (req, res) => {
  try {
    const { date, doctor } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });

    const params = [date];
    let where = "WHERE slot_date=$1";
    if (doctor) {
      params.push(doctor);
      where += ` AND doctor_name=$${params.length}`;
    }

    // Get configured slots + live booked count from appointments
    const [slotsR, bookedR] = await Promise.all([
      pool.query(`SELECT * FROM appointment_slots ${where} ORDER BY time_slot`, params),
      pool.query(
        `SELECT doctor_name, time_slot, COUNT(*)::int AS booked
         FROM appointments
         WHERE appointment_date=$1 AND status NOT IN ('cancelled','no_show')
         ${doctor ? `AND doctor_name=$2` : ""}
         GROUP BY doctor_name, time_slot`,
        doctor ? [date, doctor] : [date],
      ),
    ]);

    // Merge live counts into slot configs
    const bookedMap = {};
    for (const row of bookedR.rows) {
      bookedMap[`${row.doctor_name}||${row.time_slot}`] = row.booked;
    }
    const slots = slotsR.rows.map((s) => ({
      ...s,
      live_booked: bookedMap[`${s.doctor_name}||${s.time_slot}`] || 0,
    }));

    res.json(slots);
  } catch (e) {
    handleError(res, e, "Slots list");
  }
});

// GET /api/appointment-slots/availability?date=...&doctor=...
router.get("/appointment-slots/availability", async (req, res) => {
  try {
    const { date, doctor } = req.query;
    if (!date || !doctor) return res.status(400).json({ error: "date and doctor required" });

    // Check holiday
    const holR = await pool.query("SELECT remarks FROM clinic_holidays WHERE holiday_date=$1", [
      date,
    ]);
    if (holR.rows.length) {
      return res.json({
        available: false,
        reason: holR.rows[0].remarks || "Clinic holiday",
        slots: [],
      });
    }

    // Get booked counts per slot
    const bookedR = await pool.query(
      `SELECT time_slot, COUNT(*)::int AS booked
       FROM appointments
       WHERE appointment_date=$1 AND doctor_name=$2 AND status NOT IN ('cancelled','no_show')
       GROUP BY time_slot`,
      [date, doctor],
    );
    const bookedMap = {};
    for (const row of bookedR.rows) bookedMap[row.time_slot] = row.booked;

    // Get configured slots (or generate defaults)
    const slotsR = await pool.query(
      "SELECT * FROM appointment_slots WHERE slot_date=$1 AND doctor_name=$2 ORDER BY time_slot",
      [date, doctor],
    );

    const configs = slotsR.rows.length
      ? slotsR.rows
      : TIME_SLOTS.map((ts) => ({ time_slot: ts, total_capacity: 5, is_blocked: false }));

    const slots = configs.map((s) => ({
      time_slot: s.time_slot,
      total: s.total_capacity || 5,
      booked: bookedMap[s.time_slot] || 0,
      available: !s.is_blocked && (bookedMap[s.time_slot] || 0) < (s.total_capacity || 5),
      is_blocked: s.is_blocked || false,
      block_reason: s.block_reason || null,
    }));

    res.json({ available: true, slots });
  } catch (e) {
    handleError(res, e, "Slot availability");
  }
});

// POST /api/appointment-slots — configure a slot
router.post("/appointment-slots", async (req, res) => {
  try {
    const {
      doctor_name,
      slot_date,
      time_slot,
      slot_type,
      total_capacity,
      is_blocked,
      block_reason,
    } = req.body;
    if (!doctor_name || !slot_date || !time_slot)
      return res.status(400).json({ error: "doctor_name, slot_date, time_slot required" });

    const r = await pool.query(
      `INSERT INTO appointment_slots (doctor_name, slot_date, time_slot, slot_type, total_capacity, is_blocked, block_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (doctor_name, slot_date, time_slot)
       DO UPDATE SET slot_type=EXCLUDED.slot_type,
                     total_capacity=EXCLUDED.total_capacity,
                     is_blocked=EXCLUDED.is_blocked,
                     block_reason=EXCLUDED.block_reason
       RETURNING *`,
      [
        doctor_name,
        slot_date,
        time_slot,
        slot_type || "regular",
        total_capacity || 5,
        is_blocked || false,
        block_reason,
      ],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Slot create");
  }
});

// PATCH /api/appointment-slots/:id — block/unblock or update capacity
router.patch("/appointment-slots/:id", async (req, res) => {
  try {
    const { total_capacity, is_blocked, block_reason, slot_type } = req.body;
    const r = await pool.query(
      `UPDATE appointment_slots
       SET total_capacity=COALESCE($1,total_capacity),
           is_blocked=COALESCE($2,is_blocked),
           block_reason=COALESCE($3,block_reason),
           slot_type=COALESCE($4,slot_type)
       WHERE id=$5 RETURNING *`,
      [total_capacity, is_blocked, block_reason, slot_type, req.params.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Slot update");
  }
});

// GET /api/appointment-slots/time-slots — list of standard time slot values
router.get("/appointment-slots/time-slots", (_req, res) => {
  res.json(TIME_SLOTS);
});

export default router;
