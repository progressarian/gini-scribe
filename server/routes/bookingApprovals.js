import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { approvalsReady } from "../services/slots/approvalStore.js";
import { slotOfAppointment } from "../services/slots/capacityGuard.js";
import {
  approvalCounts,
  approveBooking,
  listApprovals,
  myDecidedRequests,
  rejectBooking,
} from "../services/slots/approvalDecisions.js";
import { actorOf } from "../services/appointmentHistory.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";

const router = Router();
const approver = requireCapability(CAPABILITIES.BOOKING_APPROVE);

router.get("/booking-approvals/latest", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((v) => parseInt(v, 10))
      .filter(Number.isInteger)
      .slice(0, 500);
    if (!ids.length || !(await approvalsReady())) return res.json([]);
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (appointment_id) appointment_id, status, patient_type, slot_label,
              limit_at_request AS limit, reason, doctor_id, appointment_date::text AS date,
              to_jsonb(booking_approvals)->>'request_reason' AS request_reason
         FROM booking_approvals
        WHERE appointment_id = ANY($1::int[]) AND status <> 'withdrawn'
        ORDER BY appointment_id, id DESC`,
      [ids],
    );
    const stillHolds = async (a) =>
      a.status === "rejected" ||
      (await slotOfAppointment(a.appointment_id, a.doctor_id, a.date)) === a.slot_label;
    const held = await Promise.all(rows.map(stillHolds));
    res.json(rows.filter((_, i) => held[i]).map(({ doctor_id: _doctor, date: _date, ...a }) => a));
  } catch (e) {
    handleError(res, e, "Booking approvals");
  }
});

router.get("/booking-approvals/mine", async (req, res) => {
  try {
    res.json(await myDecidedRequests(req.doctor?.doctor_id));
  } catch (e) {
    handleError(res, e, "My booking requests");
  }
});

router.get("/booking-approvals/count", approver, async (_req, res) => {
  try {
    res.json(await approvalCounts());
  } catch (e) {
    handleError(res, e, "Booking approvals count");
  }
});

router.get("/booking-approvals", approver, async (req, res) => {
  try {
    res.json(await listApprovals(req.query.status === "decided" ? "decided" : "pending"));
  } catch (e) {
    handleError(res, e, "Booking approvals list");
  }
});

router.post("/booking-approvals/:id/approve", approver, async (req, res) => {
  try {
    res.json(await approveBooking(parseInt(req.params.id, 10), actorOf(req)));
  } catch (e) {
    handleError(res, e, "Approve booking");
  }
});

router.post("/booking-approvals/:id/reject", approver, async (req, res) => {
  try {
    res.json(await rejectBooking(parseInt(req.params.id, 10), actorOf(req), req.body?.reason));
  } catch (e) {
    handleError(res, e, "Reject booking");
  }
});

export default router;
