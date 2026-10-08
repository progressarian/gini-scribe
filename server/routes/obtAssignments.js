import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import {
  obtTeam,
  assignmentsFor,
  teamCounts,
  assignCalls,
  divideCalls,
  canAssignCalls,
} from "../services/obtAssignments.js";

const router = Router();

const actorOf = (req) => ({
  id: req.doctor?.doctor_id || null,
  name: (req.doctor?.short_name || req.doctor?.doctor_name || "").trim() || null,
});

router.get("/obt-assignments/team", async (_req, res) => {
  try {
    res.json(await obtTeam());
  } catch (e) {
    handleError(res, e, "OBT team");
  }
});

router.post("/obt-assignments/lookup", async (req, res) => {
  try {
    res.json(await assignmentsFor(req.body?.patient_ids));
  } catch (e) {
    handleError(res, e, "OBT assignments");
  }
});

router.post("/obt-assignments/counts", async (req, res) => {
  try {
    res.json(await teamCounts(req.body?.patient_ids));
  } catch (e) {
    handleError(res, e, "OBT assignment counts");
  }
});

router.post("/obt-assignments/assign", requireCallAssigner, async (req, res) => {
  try {
    res.json(await assignCalls(req.body?.patient_ids, req.body?.assigned_to_id, actorOf(req)));
  } catch (e) {
    handleError(res, e, "OBT assign");
  }
});

router.post("/obt-assignments/divide", requireCallAssigner, async (req, res) => {
  try {
    res.json(await divideCalls(req.body?.patient_ids, req.body?.member_ids, actorOf(req)));
  } catch (e) {
    handleError(res, e, "OBT divide");
  }
});

async function requireCallAssigner(req, res, next) {
  try {
    if (await canAssignCalls(req.doctor)) return next();
    res.status(403).json({ error: "You don't have access to assign calls." });
  } catch (e) {
    handleError(res, e, "OBT assign access");
  }
}

export default router;
