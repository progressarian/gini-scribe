import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { fileUploadSchema } from "../schemas/index.js";
import { registrationFiles, saveRegistrationFile } from "../services/patients/registrationFiles.js";

const router = Router();

const patientIdOf = (req) => {
  const id = Number(req.params.patientId);
  return Number.isInteger(id) && id > 0 ? id : null;
};

router.get("/registration-documents/:patientId", async (req, res) => {
  try {
    const id = patientIdOf(req);
    if (!id) return res.status(400).json({ error: "Invalid patient" });
    res.json(await registrationFiles(id));
  } catch (e) {
    handleError(res, e, "Registration files");
  }
});

router.post(
  "/registration-documents/:patientId/:kind",
  validate(fileUploadSchema),
  async (req, res) => {
    try {
      const id = patientIdOf(req);
      if (!id) return res.status(400).json({ error: "Invalid patient" });
      res.json(await saveRegistrationFile(id, req.params.kind, req.body));
    } catch (e) {
      handleError(res, e, "Registration file");
    }
  },
);

export default router;
