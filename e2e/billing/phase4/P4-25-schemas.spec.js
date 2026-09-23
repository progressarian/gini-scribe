import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const schemas = await import("../../../server/schemas/index.js");
const { validate, validateQuery } = await import("../../../server/middleware/validate.js");

const LABELS = schemas.BILLING_DESK_LABELS;

const VISIT = "11111111-2222-3333-4444-555555555555";

function run(middleware, payload, key) {
  return new Promise((resolve) => {
    const req = { [key]: payload };
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(body) {
        resolve({ status: this.code, body, value: req[key] });
      },
    };
    middleware(req, res, () => resolve({ status: 200, body: null, value: req[key] }));
  });
}

const sent = (schema, body) => run(validate(schema, LABELS), body, "body");
const asked = (schema, query) => run(validateQuery(schema, LABELS), query, "query");

async function refused(schema, body, matcher, label) {
  const result = await sent(schema, body);
  expect(result.status, `${label}: it was allowed — ${JSON.stringify(result.value)}`).toBe(400);
  if (matcher) expect(result.body.error, label).toMatch(matcher);
  return result.body.error;
}

async function accepted(schema, body, label) {
  const result = await sent(schema, body);
  expect(result.status, `${label}: ${result.body?.error}`).toBe(200);
  return result.value;
}

const DESK_SCHEMAS = {
  "open a draft": [schemas.billingDraftOpenSchema, {}],
  "add a line": [schemas.billingLineAddSchema, { item_id: 7 }],
  "change a quantity": [schemas.billingLineQuantitySchema, { quantity: 2 }],
  "remove a line": [schemas.billingLineRemoveSchema, { reason: "Wrong item" }],
  "add a code": [schemas.billingCodeAddSchema, { code: "STAFF10" }],
  "set the category": [schemas.billingCategorySetSchema, { category: "cghs" }],
  finalise: [schemas.billingFinaliseSchema, { version: 3 }],
  cancel: [schemas.billingCancelSchema, { reason: "Billed twice" }],
  "take a payment": [
    schemas.billingPaymentsTakeSchema,
    { version: 2, payments: [{ mode: "cash", amount: 500 }] },
  ],
  "open a shift": [schemas.billingShiftOpenSchema, { opening_cash: 1000 }],
  "close a shift": [schemas.billingShiftCloseSchema, { counted_cash: 1500 }],
};

const PRICE_FIELDS = {
  price: 900,
  rate: 900,
  base_price: 900,
  mrp: 900,
  bill_name: "Dressing (large)",
  bill_code: "DR-L",
  discount: 100,
  discount_amount: 100,
  discount_value: 10,
};

test.describe("P4-25 phase 4 request schemas", () => {
  test("every desk request is refused when it carries a price or a bill name", async () => {
    for (const [what, [schema, body]] of Object.entries(DESK_SCHEMAS)) {
      for (const [field, value] of Object.entries(PRICE_FIELDS)) {
        const error = await refused(
          schema,
          { ...body, [field]: value },
          /billing desk/i,
          `${what} with ${field}`,
        );
        expect(error, `${what} with ${field}`).toMatch(/admin sets prices/i);
      }
    }
  });

  test("a price hidden inside one payment of a batch is refused too", async () => {
    await refused(
      schemas.billingPaymentsTakeSchema,
      { version: 1, payments: [{ mode: "cash", amount: 100, price: 100 }] },
      /billing desk/i,
      "payment carrying a price",
    );
  });

  test("a request for a new item can't name its own price", async () => {
    for (const field of ["price", "base_price", "rate", "amount", "discount"]) {
      await refused(
        schemas.billingNewItemRequestSchema,
        { proposed_name: "Ankle brace", reason: "A patient needs it", [field]: 800 },
        /billing desk/i,
        `new item request with ${field}`,
      );
    }
    await refused(
      schemas.billingRepeatRequestSchema,
      { service_item_id: 4, visit_id: VISIT, reason: "Second dressing", price: 500 },
      /billing desk/i,
      "repeat request with a price",
    );
  });

  test("unknown fields are refused, not quietly dropped", async () => {
    await refused(
      schemas.billingLineAddSchema,
      { item_id: 7, patient_payable: 100 },
      /Unknown field/i,
      "line with an unknown field",
    );
  });

  test("the amount taken is rupees with at most 2 decimals, and more than zero", async () => {
    const payment = (entry) => ({ version: 1, payments: [entry] });
    await refused(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "cash", amount: 100.555 }),
      /2 decimals/i,
      "three decimals",
    );
    await refused(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "cash", amount: 0 }),
      /more than zero/i,
      "zero",
    );
    await refused(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "cash", amount: -100 }),
      /more than zero/i,
      "a negative amount",
    );
    await accepted(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "cash", amount: "1200.50" }),
      "an amount as text",
    );
    await accepted(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "cash", amount: 1200.5 }),
      "an amount in rupees and paise",
    );
  });

  test("card and UPI payments need a reference, and it is capped at 60 letters", async () => {
    const payment = (entry) => ({ version: 1, payments: [entry] });
    for (const mode of ["card", "upi"]) {
      await refused(
        schemas.billingPaymentsTakeSchema,
        payment({ mode, amount: 500 }),
        /reference/i,
        `${mode} with no reference`,
      );
      await accepted(
        schemas.billingPaymentsTakeSchema,
        payment({ mode, amount: 500, reference: "0148" }),
        `${mode} with a reference`,
      );
    }
    await refused(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "card", amount: 500, reference: "9".repeat(61) }),
      /at most 60 characters/i,
      "a reference of 61 letters",
    );
    await accepted(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "card", amount: 500, reference: "9".repeat(60) }),
      "a reference of 60 letters",
    );
    await accepted(
      schemas.billingPaymentsTakeSchema,
      payment({ mode: "cash", amount: 500 }),
      "cash with no reference",
    );
  });

  test("at most ten payments are taken at once, and never none", async () => {
    const many = (count) => ({
      version: 1,
      payments: Array.from({ length: count }, () => ({ mode: "cash", amount: 10 })),
    });
    await accepted(schemas.billingPaymentsTakeSchema, many(10), "ten payments");
    await refused(schemas.billingPaymentsTakeSchema, many(11), /at most 10/i, "eleven payments");
    await refused(schemas.billingPaymentsTakeSchema, many(0), /list is empty/i, "no payment");
  });

  test("finalising and taking a payment both carry the bill's version", async () => {
    await refused(
      schemas.billingFinaliseSchema,
      { pay_later: true },
      /version/i,
      "finalise with no version",
    );
    await refused(
      schemas.billingPaymentsTakeSchema,
      { payments: [{ mode: "cash", amount: 100 }] },
      /version/i,
      "payment with no version",
    );
    expect(await accepted(schemas.billingFinaliseSchema, { version: 0 }, "version 0")).toEqual({
      version: 0,
    });
  });

  test("a line asks for a whole quantity of 1 or more", async () => {
    await accepted(schemas.billingLineAddSchema, { item_id: 7, quantity: 3 }, "three of an item");
    await refused(schemas.billingLineAddSchema, { item_id: 7, quantity: 0 }, /1 or more/i, "zero");
    await refused(
      schemas.billingLineQuantitySchema,
      { quantity: 1.5 },
      /whole number/i,
      "half an item",
    );
    await refused(schemas.billingLineAddSchema, {}, /item/i, "a line with no item");
  });

  test("a reason is asked for when a line or a bill is taken back", async () => {
    await refused(schemas.billingLineRemoveSchema, { reason: "  " }, /blank/i, "a blank reason");
    await refused(schemas.billingCancelSchema, {}, /reason/i, "cancelling with no reason");
    await refused(
      schemas.billingCancelSchema,
      { reason: "x".repeat(1001) },
      /at most 1000 characters/i,
      "a reason of 1001 letters",
    );
  });

  test("the category request carries only the category, card, referral and scan", async () => {
    await accepted(
      schemas.billingCategorySetSchema,
      { category: "cghs_pensioner", scheme_ref: "12345678", referral_no: "R/2026/44" },
      "a category with a card and a referral",
    );
    await accepted(
      schemas.billingCategorySetSchema,
      { category: null, scheme_ref: null },
      "clearing the category",
    );
    await refused(
      schemas.billingCategorySetSchema,
      {},
      /send the category/i,
      "an empty category change",
    );
    await refused(
      schemas.billingCategorySetSchema,
      { referral_doc_id: 0 },
      /Referral scan/i,
      "a referral scan of 0",
    );
  });

  test("a discount code is a code, not a sentence", async () => {
    await accepted(schemas.billingCodeAddSchema, { code: "STAFF10" }, "a code");
    await refused(
      schemas.billingCodeAddSchema,
      { code: "STAFF 10" },
      /spaces/i,
      "a code with a space",
    );
    await refused(schemas.billingCodeAddSchema, {}, /Code/i, "no code at all");
  });

  test("shift and request bodies are checked", async () => {
    await accepted(schemas.billingShiftOpenSchema, {}, "opening with no float");
    await accepted(
      schemas.billingShiftOpenSchema,
      { opening_cash: "2000" },
      "opening with a float",
    );
    await refused(
      schemas.billingShiftCloseSchema,
      { note: "n".repeat(501) },
      /at most 500 characters/i,
      "a note of 501 letters",
    );
    await refused(
      schemas.billingShiftCloseSchema,
      {},
      /Counted cash/i,
      "closing without counting the drawer",
    );
    await accepted(
      schemas.billingNewItemRequestSchema,
      { proposed_name: "Ankle brace", reason: "A patient needs one today", visit_id: VISIT },
      "a new item request",
    );
    await refused(
      schemas.billingNewItemRequestSchema,
      { proposed_name: "Ankle brace" },
      /Reason/i,
      "a request with no reason",
    );
    await refused(
      schemas.billingRepeatRequestSchema,
      { service_item_id: 4, visit_id: "not-a-visit", reason: "Second dressing" },
      /Visit/i,
      "a repeat request with no real visit",
    );
    await refused(
      schemas.billingRequestRejectSchema,
      {},
      /Note/i,
      "a rejection with no note for the desk",
    );
    await accepted(
      schemas.billingRequestApproveSchema,
      {
        note: "Priced at the list rate",
        item: { code: "BR-1", subgroup_id: 3, base_price: 800, kind: "procedure" },
      },
      "an approval that creates the item",
    );
  });

  test("list filters are checked before they reach the database", async () => {
    expect((await asked(schemas.billingDuesQuerySchema, { limit: "50" })).status).toBe(200);
    expect((await asked(schemas.billingDuesQuerySchema, { limit: "0" })).status).toBe(400);
    expect((await asked(schemas.billingDuesQuerySchema, { from: "2026-13-01" })).status).toBe(400);
    expect((await asked(schemas.billingDuesQuerySchema, { patient_id: "7" })).status).toBe(200);
    expect((await asked(schemas.billingShiftListQuerySchema, { status: "open" })).status).toBe(200);
    expect((await asked(schemas.billingShiftListQuerySchema, { status: "half" })).status).toBe(400);
    expect((await asked(schemas.billingMyShiftsQuerySchema, { user_id: "9003" })).status).toBe(400);
    expect((await asked(schemas.billingRequestListQuerySchema, { status: "pending" })).status).toBe(
      200,
    );
    expect((await asked(schemas.billingRequestListQuerySchema, { status: "later" })).status).toBe(
      400,
    );
    expect(
      (await asked(schemas.billingRequestListQuerySchema, { kind: "repeat_item" })).status,
    ).toBe(200);
  });

  test("the receipt printout asks for one payment, and lets the URL carry its own token", async () => {
    expect((await asked(schemas.billingReceiptQuerySchema, {})).status).toBe(200);
    expect((await asked(schemas.billingReceiptQuerySchema, { payment_id: VISIT })).status).toBe(
      200,
    );
    expect((await asked(schemas.billingReceiptQuerySchema, { token: "jwt.here" })).status).toBe(
      200,
    );
    expect((await asked(schemas.billingReceiptQuerySchema, { payment_id: "7" })).status).toBe(400);
    expect((await asked(schemas.billingReceiptQuerySchema, { receipt_no: "" })).status).toBe(400);
  });
});
