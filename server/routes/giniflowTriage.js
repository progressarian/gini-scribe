import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import {
  giniflowTriageQuerySchema,
  giniflowTriagePatchSchema,
  giniflowDateQuerySchema,
} from "../schemas/index.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  getTriageDay,
  categorise,
  assign,
  autoCategoriseDay,
  getAssignableStaff,
} from "../services/giniflow/triage.js";

// The coordinator's pre-OPD board (docs/gini-flow/18-TRIAGE-BOARD-PLAN.md §9).
//
// Behind its own capability, held by the coordinator and admin only. Not
// reception — their job is the desk and the payment queue, and the
// categorisation here is a clinical judgement. Not OBT: they work the
// confirmation calls this board DISPLAYS, but they work them on /ghm, and two
// screens writing the same call outcome is how three copies of that vocabulary
// appeared before `shared/callStatuses.js` unified them.
const router = Router();

const gate = requireCapability(CAP.GINIFLOW_TRIAGE);

// "Today" is the IST day. The server runs UTC, so CURRENT_DATE would show
// yesterday's list to anyone opening the board before 05:30 IST.
const istToday = async () =>
  (await pool.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;

const resolveDate = async (raw) => (/^\d{4}-\d{2}-\d{2}$/.test(raw || "") ? raw : await istToday());

const triageError = (res, e, label) =>
  e.status && e.status < 500
    ? res.status(e.status).json({ error: e.message })
    : handleError(res, e, label);

router.get("/giniflow/triage", gate, validateQuery(giniflowTriageQuerySchema), async (req, res) => {
  try {
    const date = await resolveDate(req.query.date);
    const day = await getTriageDay(date, {
      doctorId: req.query.doctorId ?? null,
      filter: req.query.filter ?? null,
      q: req.query.q ?? null,
    });
    res.json({ ...day, serverTime: new Date().toISOString() });
  } catch (e) {
    triageError(res, e, "Gini Flow triage board");
  }
});

router.get(
  "/giniflow/triage/staff",
  gate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      res.json({ date, staff: await getAssignableStaff(date) });
    } catch (e) {
      triageError(res, e, "Gini Flow triage staff");
    }
  },
);

// Re-run the engine for a date by hand. It normally runs on the worker after
// the appointment sync and after a lab result lands, so this is the "a report
// arrived and I do not want to wait" button, not the usual path.
router.post(
  "/giniflow/triage/auto",
  gate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date || req.body?.date);
      res.json(await autoCategoriseDay(date));
    } catch (e) {
      triageError(res, e, "Gini Flow triage auto-categorise");
    }
  },
);

// One PATCH for both writes: the coordinator's Assign menu sets a category and
// an SD in the same gesture, and two round trips would let one land without the
// other.
router.patch(
  "/giniflow/triage/:visitId",
  gate,
  validate(giniflowTriagePatchSchema),
  async (req, res) => {
    try {
      const actorId = req.doctor?.doctor_id ?? null;
      const result = { visitId: req.params.visitId };

      if ("category" in req.body) {
        Object.assign(result, await categorise(req.params.visitId, req.body.category, actorId));
      }
      if ("assignedSdId" in req.body || "assignedDoctorId" in req.body) {
        const assigned = await assign(
          req.params.visitId,
          {
            ...("assignedSdId" in req.body ? { sdId: req.body.assignedSdId } : {}),
            ...("assignedDoctorId" in req.body ? { doctorId: req.body.assignedDoctorId } : {}),
          },
          actorId,
        );
        result.assignment = assigned;
      }

      res.json(result);
    } catch (e) {
      triageError(res, e, "Gini Flow triage update");
    }
  },
);

export default router;
