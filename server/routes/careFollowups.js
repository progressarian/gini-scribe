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
} from "../schemas/index.js";
import { listFollowups, readFollowup } from "../services/careFollowups/list.js";
import { closeWith, logCall, markBooked, reopen } from "../services/careFollowups/actions.js";
import { collectDay, collectFollowups } from "../services/careFollowups/collect.js";

const router = express.Router();
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
