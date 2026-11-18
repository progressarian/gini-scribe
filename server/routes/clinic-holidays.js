import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";
import { clinicHolidayCreateSchema } from "../schemas/index.js";
import {
  addClinicHolidays,
  clinicHolidayOn,
  listClinicHolidays,
  removeClinicHoliday,
} from "../services/clinicHolidays.js";

const router = Router();
const manage = requireCapability(CAPABILITIES.ADMIN);
const actorOf = (req) => ({
  id: req.doctor?.doctor_id ?? null,
  name: req.doctor?.doctor_name ?? null,
});
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

router.get("/clinic-holidays", async (_req, res) => {
  try {
    res.json(await listClinicHolidays());
  } catch (e) {
    handleError(res, e, "Clinic holidays");
  }
});

router.get("/clinic-holidays/check", async (req, res) => {
  try {
    const date = String(req.query.date ?? "");
    if (!ISO_DAY.test(date)) return res.status(400).json({ error: "Choose a date." });
    const holiday = await clinicHolidayOn(date);
    res.json({ is_holiday: Boolean(holiday), holiday });
  } catch (e) {
    handleError(res, e, "Clinic holiday check");
  }
});

router.post(
  "/clinic-holidays",
  manage,
  validate(clinicHolidayCreateSchema, { from: "First day", to: "Last day", title: "" }),
  async (req, res) => {
    try {
      res.status(201).json(await addClinicHolidays(req.body, actorOf(req)));
    } catch (e) {
      handleError(res, e, "Add clinic holiday");
    }
  },
);

router.delete("/clinic-holidays/:id", manage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(404).json({ error: "Holiday not found." });
    res.json(await removeClinicHoliday(id, actorOf(req)));
  } catch (e) {
    handleError(res, e, "Remove clinic holiday");
  }
});

export default router;
