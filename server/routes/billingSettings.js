import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_FIELD_LABELS,
  billingActiveSchema,
  billingListQuerySchema,
  billingSeriesSaveSchema,
  billingSettingsUpdateSchema,
  billingTaxCodeCreateSchema,
  billingTaxCodeUpdateSchema,
} from "../schemas/index.js";
import { billingRoute as run } from "./billingHttp.js";
import { auditContext } from "../services/billing/audit.js";
import { wholeNumber } from "../services/billing/common.js";
import { httpError } from "../services/billing/transaction.js";
import { getSettings, updateSettings } from "../services/billing/billingSettings.js";
import { listSeries, saveSeries } from "../services/billing/billSeries.js";
import * as taxes from "../services/billing/taxCodes.js";

const router = Router();
const BASE = "/billing/settings";
const settings = requireCapability(CAP.BILLING_SETTINGS);
const ctx = (req) => auditContext(req);

const idParam = (req) => {
  const id = wholeNumber(req.params.id, "Id", { min: 1 });
  if (id === undefined) throw httpError(400, "Id is required");
  return id;
};

router.get(
  `${BASE}`,
  settings,
  run("Billing settings read", 200, () => getSettings()),
);
router.patch(
  `${BASE}`,
  settings,
  validate(billingSettingsUpdateSchema, BILLING_FIELD_LABELS),
  run("Billing settings update", 200, (req) => updateSettings(req.body, ctx(req))),
);

router.get(
  `${BASE}/series`,
  settings,
  run("Bill series list", 200, () => listSeries()),
);
router.put(
  `${BASE}/series`,
  settings,
  validate(billingSeriesSaveSchema, BILLING_FIELD_LABELS),
  run("Bill series save", 200, (req) => saveSeries(req.body, ctx(req))),
);

router.get(
  `${BASE}/tax-codes`,
  settings,
  validateQuery(billingListQuerySchema, BILLING_FIELD_LABELS),
  run("Tax codes list", 200, (req) =>
    taxes.listTaxCodes({ activeOnly: req.query.activeOnly === true }),
  ),
);
router.post(
  `${BASE}/tax-codes`,
  settings,
  validate(billingTaxCodeCreateSchema, BILLING_FIELD_LABELS),
  run("Tax code create", 201, (req) => taxes.createTaxCode(req.body, ctx(req))),
);
router.patch(
  `${BASE}/tax-codes/:id`,
  settings,
  validate(billingTaxCodeUpdateSchema, BILLING_FIELD_LABELS),
  run("Tax code update", 200, (req) => taxes.updateTaxCode(idParam(req), req.body, ctx(req))),
);
router.put(
  `${BASE}/tax-codes/:id/active`,
  settings,
  validate(billingActiveSchema, BILLING_FIELD_LABELS),
  run("Tax code active", 200, (req) =>
    taxes.setTaxCodeActive(idParam(req), req.body.is_active, ctx(req)),
  ),
);
router.delete(
  `${BASE}/tax-codes/:id`,
  settings,
  run("Tax code delete", 200, (req) => taxes.deleteTaxCode(idParam(req), ctx(req))),
);

export default router;
