import express from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  careFollowupCallSchema,
  careFollowupBookedSchema,
  careFollowupCloseSchema,
  careFollowupDaySchema,
  careFollowupListSchema,
  careFollowupReopenSchema,
  careHoldDoneSchema,
  careHoldSkipSchema,
} from "../schemas/index.js";
import { listFollowups, readFollowup } from "../services/careFollowups/list.js";
import { closeWith, logCall, markBooked, reopen } from "../services/careFollowups/actions.js";
import { collectDay, collectFollowups } from "../services/careFollowups/collect.js";
import { completeHold, listOnFloor, skipHold } from "../services/giniflow/coordinatorHold.js";

const router = express.Router();
const istToday = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const gate = requireCapability(CAP.CARE_FOLLOWUPS);
const ctx = (req) => ({ actorId: req.doctor?.doctor_id ?? null });

const route = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, label);
  }
};

router.get(
  "/care-followups",
  gate,
  validateQuery(careFollowupListSchema),
  route("Follow-ups list", (req) => listFollowups(req.query)),
);

router.post(
  "/care-followups/refresh",
  gate,
  route("Follow-ups refresh", () => collectFollowups()),
);

router.post(
  "/care-followups/day",
  gate,
  validate(careFollowupDaySchema),
  route("Follow-ups for a day", (req) => collectDay({ day: req.body.day })),
);

router.get(
  "/care-followups/on-floor",
  gate,
  route("Patients waiting for the Care Coordinator", () => listOnFloor(istToday())),
);

router.post(
  "/care-followups/on-floor/:visitId/done",
  gate,
  validate(careHoldDoneSchema),
  route("Care Coordinator done", (req) => completeHold(req.params.visitId, req.body, ctx(req))),
);

router.post(
  "/care-followups/on-floor/:visitId/skip",
  requireCapability(CAP.CARE_HOLD_SKIP),
  validate(careHoldSkipSchema),
  route("Send on without the Care Coordinator", (req) =>
    skipHold(req.params.visitId, req.body, ctx(req)),
  ),
);

router.get(
  "/care-followups/:id",
  gate,
  route("Follow-up", (req) => readFollowup(req.params.id)),
);

router.post(
  "/care-followups/:id/call",
  gate,
  validate(careFollowupCallSchema),
  route("Follow-up call", (req) => logCall(req.params.id, req.body, ctx(req))),
);

router.post(
  "/care-followups/:id/outcome",
  gate,
  validate(careFollowupCloseSchema),
  route("Follow-up outcome", (req) => closeWith(req.params.id, req.body, ctx(req))),
);

router.post(
  "/care-followups/:id/booked",
  gate,
  validate(careFollowupBookedSchema),
  route("Follow-up booked", (req) => markBooked(req.params.id, req.body, ctx(req))),
);

router.post(
  "/care-followups/:id/reopen",
  gate,
  validate(careFollowupReopenSchema),
  route("Follow-up reopen", (req) => reopen(req.params.id, req.body, ctx(req))),
);

export default router;
