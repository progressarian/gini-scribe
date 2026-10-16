import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  RX_PARAMETER_LABELS,
  rxParameterDefaultsSchema,
  rxParameterRowsSchema,
} from "../schemas/rxParameters.js";
import {
  generateStationVisitSummary,
  getStationRxParameters,
  getStationVisitSummary,
  saveStationRxParameters,
} from "../services/giniflow/rxParameters.js";
import { getRxParameterDefaults, saveRxParameterDefaults } from "../services/rxParameterTable.js";
import { billingRoute as run } from "./billingHttp.js";

const router = Router();
const STATIONS = [
  { station: "doctor", gate: requireCapability(CAP.GINIFLOW_STATION_DOCTOR) },
  { station: "mo", gate: requireCapability(CAP.GINIFLOW_STATION_MO) },
];
const actorOf = (req) => (req.doctor?.short_name || req.doctor?.doctor_name || "").trim() || null;

for (const { station, gate } of STATIONS) {
  const base = `/giniflow/stations/${station}/:visitId`;
  const opts = { station };

  router.get(
    `${base}/rx-parameters`,
    gate,
    run("Rx parameter table", 200, (req) =>
      getStationRxParameters(req.params.visitId, undefined, opts),
    ),
  );

  router.put(
    `${base}/rx-parameters`,
    gate,
    validate(rxParameterRowsSchema, RX_PARAMETER_LABELS),
    run("Rx parameter table save", 200, (req) =>
      saveStationRxParameters(req.params.visitId, req.body.rows, actorOf(req), undefined, opts),
    ),
  );

  router.get(
    `${base}/visit-summary`,
    gate,
    run("Visit summary", 200, (req) => getStationVisitSummary(req.params.visitId, undefined, opts)),
  );

  router.post(
    `${base}/visit-summary`,
    gate,
    run("Visit summary generate", 200, (req) =>
      generateStationVisitSummary(req.params.visitId, undefined, opts),
    ),
  );
}

router.get(
  "/admin/rx-parameters",
  run("Rx parameter defaults", 200, async () => ({ parameters: await getRxParameterDefaults() })),
);

router.put(
  "/admin/rx-parameters",
  validate(rxParameterDefaultsSchema, RX_PARAMETER_LABELS),
  run("Rx parameter defaults save", 200, async (req) => ({
    parameters: await saveRxParameterDefaults(req.body.parameters),
  })),
);

export default router;
