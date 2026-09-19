import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { billingRoute } from "./billingHttp.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  billingActiveSchema,
  billingCategoryCreateSchema,
  billingCategoryRateDeleteQuerySchema,
  billingCategoryRateSaveSchema,
  billingCategoryRuleCreateSchema,
  billingCategoryRuleUpdateSchema,
  billingCategoryUpdateSchema,
  billingGroupCreateSchema,
  billingGroupUpdateSchema,
  billingItemCreateSchema,
  billingItemListQuerySchema,
  billingItemUpdateSchema,
  billingListQuerySchema,
  billingRateGridQuerySchema,
  billingSubgroupCreateSchema,
  billingSubgroupUpdateSchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import { wholeNumber } from "../services/billing/common.js";
import { httpError } from "../services/billing/transaction.js";
import { USAGE_KINDS, whereUsed } from "../services/billing/usage.js";
import * as groups from "../services/billing/serviceGroups.js";
import * as items from "../services/billing/serviceItems.js";
import * as rules from "../services/billing/categoryRules.js";
import * as rates from "../services/billing/categoryRates.js";
import { listTaxCodes } from "../services/billing/taxCodes.js";
import {
  createScheme,
  deleteScheme,
  listSchemeTree,
  updateScheme,
} from "../services/patientSchemes.js";

const router = Router();
const BASE = "/billing/master";
const master = requireCapability(CAP.BILLING_MASTER);

const run = billingRoute;

const idParam = (req, name = "id") => {
  const id = wholeNumber(req.params[name], "Id", { min: 1 });
  if (id === undefined) throw httpError(400, "Id is required");
  return id;
};

const codeParam = (req) => {
  const code = String(req.params.code || "").trim();
  if (!/^[a-z0-9_]{2,32}$/.test(code)) throw httpError(400, "That isn't a valid category code");
  return code;
};

const ctx = (req) => auditContext(req);
const activeOnly = (req) => req.query.activeOnly === true;

router.get(
  `${BASE}/groups`,
  master,
  validateQuery(billingListQuerySchema),
  run("Billing groups list", 200, (req) => groups.listGroups({ activeOnly: activeOnly(req) })),
);
router.post(
  `${BASE}/groups`,
  master,
  validate(billingGroupCreateSchema),
  run("Billing group create", 201, (req) => groups.createGroup(req.body, ctx(req))),
);
router.patch(
  `${BASE}/groups/:id`,
  master,
  validate(billingGroupUpdateSchema),
  run("Billing group update", 200, (req) => groups.updateGroup(idParam(req), req.body, ctx(req))),
);
router.put(
  `${BASE}/groups/:id/active`,
  master,
  validate(billingActiveSchema),
  run("Billing group active", 200, (req) =>
    groups.setGroupActive(idParam(req), req.body.is_active, ctx(req)),
  ),
);
router.delete(
  `${BASE}/groups/:id`,
  master,
  run("Billing group delete", 200, (req) => groups.deleteGroup(idParam(req), ctx(req))),
);

router.post(
  `${BASE}/subgroups`,
  master,
  validate(billingSubgroupCreateSchema),
  run("Billing subgroup create", 201, (req) => groups.createSubgroup(req.body, ctx(req))),
);
router.patch(
  `${BASE}/subgroups/:id`,
  master,
  validate(billingSubgroupUpdateSchema),
  run("Billing subgroup update", 200, (req) =>
    groups.updateSubgroup(idParam(req), req.body, ctx(req)),
  ),
);
router.put(
  `${BASE}/subgroups/:id/active`,
  master,
  validate(billingActiveSchema),
  run("Billing subgroup active", 200, (req) =>
    groups.setSubgroupActive(idParam(req), req.body.is_active, ctx(req)),
  ),
);
router.delete(
  `${BASE}/subgroups/:id`,
  master,
  run("Billing subgroup delete", 200, (req) => groups.deleteSubgroup(idParam(req), ctx(req))),
);

router.get(
  `${BASE}/tax-codes`,
  master,
  validateQuery(billingListQuerySchema),
  run("Billing tax codes list", 200, (req) => listTaxCodes({ activeOnly: activeOnly(req) })),
);

router.get(
  `${BASE}/items`,
  master,
  validateQuery(billingItemListQuerySchema),
  run("Billing items list", 200, (req) => items.listItems(req.query)),
);
router.get(
  `${BASE}/items/choices`,
  master,
  run("Billing item choices", 200, () => items.itemChoices()),
);
router.get(
  `${BASE}/items/not-priced`,
  master,
  run("Billing not priced", 200, () => items.notPricedList()),
);
router.get(
  `${BASE}/items/:id/price-history`,
  master,
  run("Billing price history", 200, (req) => items.priceHistory(idParam(req))),
);
router.post(
  `${BASE}/items`,
  master,
  validate(billingItemCreateSchema),
  run("Billing item create", 201, (req) => items.createItem(req.body, ctx(req))),
);
router.patch(
  `${BASE}/items/:id`,
  master,
  validate(billingItemUpdateSchema),
  run("Billing item update", 200, (req) => items.updateItem(idParam(req), req.body, ctx(req))),
);
router.put(
  `${BASE}/items/:id/active`,
  master,
  validate(billingActiveSchema),
  run("Billing item active", 200, (req) =>
    items.setItemActive(idParam(req), req.body.is_active, ctx(req)),
  ),
);
router.delete(
  `${BASE}/items/:id`,
  master,
  run("Billing item delete", 200, (req) => items.deleteItem(idParam(req), ctx(req))),
);

router.get(
  `${BASE}/categories`,
  master,
  validateQuery(billingListQuerySchema),
  run("Billing categories list", 200, (req) => listSchemeTree({ all: !activeOnly(req) })),
);
router.post(
  `${BASE}/categories`,
  master,
  validate(billingCategoryCreateSchema),
  run("Billing category create", 201, (req) => createScheme(req.body, undefined, ctx(req))),
);
router.patch(
  `${BASE}/categories/:code`,
  master,
  validate(billingCategoryUpdateSchema),
  run("Billing category update", 200, (req) =>
    updateScheme(codeParam(req), req.body, undefined, ctx(req)),
  ),
);
router.delete(
  `${BASE}/categories/:code`,
  master,
  run("Billing category delete", 200, (req) => deleteScheme(codeParam(req), undefined, ctx(req))),
);

router.get(
  `${BASE}/category-rules`,
  master,
  validateQuery(billingListQuerySchema),
  run("Billing category rules list", 200, (req) =>
    rules.listRules({ schemeCode: req.query.schemeCode, activeOnly: activeOnly(req) }),
  ),
);
router.post(
  `${BASE}/category-rules`,
  master,
  validate(billingCategoryRuleCreateSchema),
  run("Billing category rule create", 201, (req) => rules.createRule(req.body, ctx(req))),
);
router.patch(
  `${BASE}/category-rules/:id`,
  master,
  validate(billingCategoryRuleUpdateSchema),
  run("Billing category rule update", 200, (req) =>
    rules.updateRule(idParam(req), req.body, ctx(req)),
  ),
);
router.put(
  `${BASE}/category-rules/:id/active`,
  master,
  validate(billingActiveSchema),
  run("Billing category rule active", 200, (req) =>
    rules.setRuleActive(idParam(req), req.body.is_active, ctx(req)),
  ),
);
router.delete(
  `${BASE}/category-rules/:id`,
  master,
  run("Billing category rule delete", 200, (req) => rules.deleteRule(idParam(req), ctx(req))),
);

router.get(
  `${BASE}/category-rates/:code`,
  master,
  validateQuery(billingRateGridQuerySchema),
  run("Billing category rates grid", 200, (req) => rates.rateGrid(codeParam(req), req.query)),
);
router.get(
  `${BASE}/category-rates/:code/items/:itemId`,
  master,
  run("Billing category rate history", 200, (req) =>
    rates.rateHistory({ schemeCode: codeParam(req), itemId: idParam(req, "itemId") }),
  ),
);
router.put(
  `${BASE}/category-rates`,
  master,
  validate(billingCategoryRateSaveSchema),
  run("Billing category rate save", 200, (req) => rates.saveRate(req.body, ctx(req))),
);
router.delete(
  `${BASE}/category-rates/:code/items/:itemId/:validFrom`,
  master,
  validateQuery(billingCategoryRateDeleteQuerySchema),
  run("Billing category rate delete", 200, (req) =>
    rates.deleteRate(
      {
        scheme_code: codeParam(req),
        service_item_id: idParam(req, "itemId"),
        valid_from: req.params.validFrom,
        ...(req.query.reopen_previous === undefined
          ? {}
          : { reopen_previous: req.query.reopen_previous }),
      },
      ctx(req),
    ),
  ),
);

router.get(
  `${BASE}/usage/:kind/:key`,
  master,
  run("Billing where used", 200, (req) => {
    if (!Object.hasOwn(USAGE_KINDS, req.params.kind)) {
      throw httpError(400, "Unknown kind");
    }
    const key =
      req.params.kind === "category"
        ? codeParam({ params: { code: req.params.key } })
        : idParam(req, "key");
    return whereUsed(req.params.kind, key);
  }),
);

export default router;
