import { test, expect } from "@playwright/test";
import { anonymousApi, apiAs, tokensFor } from "../../helpers/auth.mjs";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  discountCode,
  extraVisit,
  newTag,
  payRule,
  setUp,
  subCategory,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const API = "/api/billing";
const tag = newTag();
const CODE = `P4R${tag.toUpperCase()}`;
const contexts = new Map();
const ids = {};
let fixture;

async function api(role) {
  if (!contexts.has(role)) contexts.set(role, await apiAs(role));
  return contexts.get(role);
}

async function call(role, method, url, options = {}) {
  const context = await api(role);
  const response = await context[method](url, options);
  const type = response.headers()["content-type"] ?? "";
  const body = type.includes("application/json")
    ? await response.json()
    : type.includes("application/pdf")
      ? await response.body()
      : await response.text();
  return { status: response.status(), body, headers: response.headers() };
}

const desk = (method, url, options) => call("reception", method, url, options);
const master = (method, url, options) => call("reception_admin", method, url, options);

function ok(response, status = 200) {
  expect(
    response.status,
    typeof response.body === "string" ? response.body : JSON.stringify(response.body),
  ).toBe(status);
  return response.body;
}

async function shiftFor(role) {
  const current = ok(await call(role, "get", `${API}/shifts/current`));
  if (current) return current;
  return ok(await call(role, "post", `${API}/shifts/open`, { data: { opening_cash: 0 } }), 201);
}

const DESK_CALLS = () => [
  ["get", `${API}/visits/${fixture.visit}/bills`, undefined],
  ["post", `${API}/visits/${fixture.visit}/bills`, {}],
  ["get", `${API}/visits/${fixture.visit}/not-priced`, undefined],
  ["get", `${API}/bills/${ids.bill}`, undefined],
  ["post", `${API}/bills/${ids.bill}/lines`, { item_id: fixture.brace }],
  ["patch", `${API}/bills/${ids.bill}/lines/${ids.line}`, { quantity: 2 }],
  ["post", `${API}/bills/${ids.bill}/lines/${ids.line}/remove`, { reason: "Not needed" }],
  ["post", `${API}/bills/${ids.bill}/codes`, { code: CODE }],
  ["delete", `${API}/bills/${ids.bill}/codes/${CODE}`, undefined],
  ["patch", `${API}/bills/${ids.bill}/category`, { category: fixture.paid }],
  ["post", `${API}/bills/${ids.bill}/finalise`, { version: 0 }],
  ["post", `${API}/bills/${ids.bill}/cancel`, { reason: "Billed twice" }],
  ["post", `${API}/bills/${ids.bill}/payments`, { version: 0, payments: [] }],
  ["get", `${API}/bills/${ids.bill}/payments`, undefined],
  ["get", `${API}/bills/${ids.bill}/bill.pdf`, undefined],
  ["get", `${API}/bills/${ids.bill}/receipt.pdf`, undefined],
  ["get", `${API}/dues`, undefined],
  ["get", `${API}/shifts/current`, undefined],
  ["get", `${API}/shifts/mine`, undefined],
  ["post", `${API}/shifts/open`, {}],
  ["post", `${API}/shifts/close`, { counted_cash: 0 }],
  ["post", `${API}/requests/new-item`, { proposed_name: "Splint", reason: "A patient needs one" }],
  [
    "post",
    `${API}/requests/repeat`,
    { service_item_id: fixture.dressing, visit_id: fixture.visit, reason: "Second dressing" },
  ],
  ["get", `${API}/requests/mine`, undefined],
];

const MASTER_CALLS = () => [
  ["get", `${API}/master/requests`, undefined],
  ["post", `${API}/master/requests/${ids.request}/approve`, {}],
  ["post", `${API}/master/requests/${ids.request}/reject`, { note: "No" }],
  ["get", `${API}/master/shifts`, undefined],
  ["post", `${API}/master/shifts/${ids.shift}/close`, { counted_cash: 0 }],
];

test.describe.serial("P4-26 billing routes", () => {
  test.beforeAll(async () => {
    fixture = await setUp(tag);
    fixture.later = await subCategory(fixture, "Later", { allow_pay_later: true });
    await payRule(fixture, fixture.later, { name: "later pays", patient_pays: "full" });
    await payRule(fixture, fixture.paid, { name: "paid pays", patient_pays: "full" });
    await discountCode(fixture, CODE, { kind: "percent", value: 10 });
  });

  test.afterAll(async () => {
    for (const context of contexts.values()) await context.dispose();
    contexts.clear();
    await tearDown(fixture);
    await query(`DELETE FROM cash_shifts WHERE user_id = ANY($1::int[])`, [
      [USERS.reception.id, USERS.reception_admin.id, USERS.admin.id],
    ]);
  });

  test("1. the desk opens a draft on a visit and sees it listed", async () => {
    const draft = ok(await desk("post", `${API}/visits/${fixture.visit}/bills`, { data: {} }));
    expect(draft.status).toBe("draft");
    ids.bill = draft.id;
    const again = ok(await desk("post", `${API}/visits/${fixture.visit}/bills`, { data: {} }));
    expect(again.id).toBe(ids.bill);
    const listed = ok(await desk("get", `${API}/visits/${fixture.visit}/bills`));
    expect(listed.map((bill) => bill.id)).toContain(ids.bill);
    expect(ok(await desk("get", `${API}/bills/${ids.bill}`)).id).toBe(ids.bill);
    expect(Array.isArray(ok(await desk("get", `${API}/visits/${fixture.visit}/not-priced`)))).toBe(
      true,
    );
  });

  test("2. lines are added, changed and taken off over HTTP", async () => {
    const added = ok(
      await desk("post", `${API}/bills/${ids.bill}/lines`, {
        data: { item_id: fixture.dressing, quantity: 2 },
      }),
    );
    const line = added.lines.find((entry) => entry.service_item_id === fixture.dressing);
    expect(line.quantity).toBe(2);
    ids.line = line.id;
    const changed = ok(
      await desk("patch", `${API}/bills/${ids.bill}/lines/${line.id}`, { data: { quantity: 1 } }),
    );
    expect(changed.lines.find((entry) => entry.id === line.id).quantity).toBe(1);

    const brace = ok(
      await desk("post", `${API}/bills/${ids.bill}/lines`, { data: { item_id: fixture.brace } }),
    );
    const spare = brace.lines.find((entry) => entry.service_item_id === fixture.brace);
    const after = ok(
      await desk("post", `${API}/bills/${ids.bill}/lines/${spare.id}/remove`, {
        data: { reason: "Asked for by mistake" },
      }),
    );
    expect(after.lines.map((entry) => entry.id)).not.toContain(spare.id);

    const refused = await desk("post", `${API}/bills/${ids.bill}/lines`, {
      data: { item_id: fixture.brace, price: 900 },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/admin sets prices/i);
  });

  test("3. a discount code goes on and comes off", async () => {
    const withCode = ok(
      await desk("post", `${API}/bills/${ids.bill}/codes`, { data: { code: CODE } }),
    );
    expect(withCode.codes).toEqual([CODE]);
    expect(withCode.totals.discount).toBeGreaterThan(0);
    const without = ok(await desk("delete", `${API}/bills/${ids.bill}/codes/${CODE}`));
    expect(without.codes).toEqual([]);
    const again = ok(
      await desk("post", `${API}/bills/${ids.bill}/codes`, { data: { code: CODE } }),
    );
    expect(again.codes).toEqual([CODE]);
  });

  test("4. the category, card number and referral are set from one request", async () => {
    const set = ok(
      await desk("patch", `${API}/bills/${ids.bill}/category`, {
        data: { category: fixture.later, scheme_ref: "CARD-4471", referral_no: "R/2026/9" },
      }),
    );
    expect(set.category).toBe(fixture.later);
    expect(set.scheme_ref).toMatch(/4471$/);
    const empty = await desk("patch", `${API}/bills/${ids.bill}/category`, { data: {} });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/send the category/i);
  });

  test("5. the desk's shift opens, shows as current and is listed", async () => {
    const open = await shiftFor("reception");
    ids.shift = open.id;
    expect(ok(await desk("get", `${API}/shifts/current`)).id).toBe(open.id);
    const mine = ok(await desk("get", `${API}/shifts/mine`, { params: { status: "open" } }));
    expect(mine.map((shift) => shift.id)).toContain(open.id);
    const twice = await desk("post", `${API}/shifts/open`, { data: {} });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatch(/already open/i);
  });

  test("6. the bill is finalised, paid and then stands on the dues list", async () => {
    const before = ok(await desk("get", `${API}/bills/${ids.bill}`));
    const bill = ok(
      await desk("post", `${API}/bills/${ids.bill}/finalise`, {
        data: { version: before.version, pay_later: true },
      }),
    );
    expect(bill.status).toBe("final");
    expect(bill.bill_no).toBeTruthy();
    ids.billNo = bill.bill_no;

    const stale = await desk("post", `${API}/bills/${ids.bill}/finalise`, {
      data: { version: before.version },
    });
    expect(stale.status).toBe(409);

    const taken = ok(
      await desk("post", `${API}/bills/${ids.bill}/payments`, {
        data: { version: bill.version, payments: [{ mode: "cash", amount: 100 }] },
      }),
      201,
    );
    expect(taken.payments).toHaveLength(1);
    expect(taken.payments[0].receipt_no).toBeTruthy();
    expect(taken.totals.outstanding).toBeGreaterThan(0);
    ids.payment = taken.payments[0].id;

    const listed = ok(await desk("get", `${API}/bills/${ids.bill}/payments`));
    expect(listed.map((payment) => payment.id)).toContain(ids.payment);

    const dues = ok(
      await desk("get", `${API}/dues`, { params: { patient_id: String(fixture.patient) } }),
    );
    const due = dues.find((row) => row.bill_id === ids.bill);
    expect(due.outstanding).toBe(taken.totals.outstanding);
    expect(due.patient.id).toBe(fixture.patient);
  });

  test("7. the bill and receipt print as PDFs", async () => {
    const bill = await desk("get", `${API}/bills/${ids.bill}/bill.pdf`);
    expect(bill.status, String(bill.body)).toBe(200);
    expect(bill.headers["content-type"]).toContain("application/pdf");
    expect(bill.headers["content-disposition"]).toMatch(/filename="Bill_.*\.pdf"/);
    expect(bill.body.subarray(0, 4).toString()).toBe("%PDF");

    const receipt = await desk("get", `${API}/bills/${ids.bill}/receipt.pdf`, {
      params: { payment_id: ids.payment },
    });
    expect(receipt.status, String(receipt.body)).toBe(200);
    expect(receipt.headers["content-type"]).toContain("application/pdf");
    expect(receipt.headers["content-disposition"]).toMatch(/filename="Receipt_.*\.pdf"/);
    expect(receipt.body.subarray(0, 4).toString()).toBe("%PDF");

    const odd = await desk("get", `${API}/bills/${ids.bill}/receipt.pdf`, {
      params: { nonsense: "1" },
    });
    expect(odd.status).toBe(400);
  });

  test("8. a printout URL carries its own token, and is still refused without one", async () => {
    const { access } = await tokensFor("reception");
    const guest = await anonymousApi();
    try {
      const signed = await guest.get(`${API}/bills/${ids.bill}/bill.pdf?token=${access}`);
      expect(signed.status()).toBe(200);
      expect(signed.headers()["content-type"]).toContain("application/pdf");
      const bare = await guest.get(`${API}/bills/${ids.bill}/bill.pdf`);
      expect(bare.status()).toBe(403);
    } finally {
      await guest.dispose();
    }
  });

  test("9. the desk asks for an item, and the master desk answers", async () => {
    const asked = ok(
      await desk("post", `${API}/requests/new-item`, {
        data: {
          proposed_name: `P4 Splint ${tag}`,
          reason: "A patient needs one today",
          visit_id: fixture.visit,
        },
      }),
      201,
    );
    ids.request = asked.id;
    expect(asked.status).toBe("pending");

    const repeat = ok(
      await desk("post", `${API}/requests/repeat`, {
        data: {
          service_item_id: fixture.dressing,
          visit_id: fixture.visit,
          reason: "A second dressing was done",
        },
      }),
      201,
    );
    ids.repeat = repeat.id;

    const mine = ok(await desk("get", `${API}/requests/mine`, { params: { status: "pending" } }));
    expect(mine.map((row) => row.id)).toEqual(expect.arrayContaining([ids.request, ids.repeat]));

    const inbox = ok(
      await master("get", `${API}/master/requests`, { params: { status: "pending" } }),
    );
    expect(inbox.map((row) => row.id)).toContain(ids.request);

    const approved = ok(
      await master("post", `${API}/master/requests/${ids.repeat}/approve`, {
        data: { note: "One more dressing is fair" },
      }),
    );
    expect(approved.status).toBe("approved");

    const rejected = ok(
      await master("post", `${API}/master/requests/${ids.request}/reject`, {
        data: { note: "Bill it as a dressing for now" },
      }),
    );
    expect(rejected.status).toBe("rejected");

    const noNote = await master("post", `${API}/master/requests/${ids.repeat}/reject`, {
      data: {},
    });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error).toMatch(/note/i);
  });

  test("10. the master desk sees every shift and can close another desk's", async () => {
    const all = ok(await master("get", `${API}/master/shifts`, { params: { status: "open" } }));
    expect(all.map((shift) => shift.id)).toContain(ids.shift);
    const mine = ok(
      await master("get", `${API}/master/shifts`, {
        params: { user_id: String(USERS.reception.id) },
      }),
    );
    expect(mine.every((shift) => shift.user.id === USERS.reception.id)).toBe(true);
    const closed = ok(
      await master("post", `${API}/master/shifts/${ids.shift}/close`, {
        data: { counted_cash: 100, note: "Counted by the manager" },
      }),
    );
    expect(closed.is_open).toBe(false);
    expect(closed.closed_at).not.toBe(null);
    expect(closed.counted_cash).toBe(100);
    expect(closed.difference).toBe(closed.counted_cash - closed.expected_cash);
    expect(ok(await desk("get", `${API}/shifts/current`))).toBe(null);
  });

  test("11. the desk's own shift closes from its own request", async () => {
    const open = await shiftFor("reception");
    ids.shift = open.id;
    const closed = ok(await desk("post", `${API}/shifts/close`, { data: { counted_cash: 0 } }));
    expect(closed.id).toBe(open.id);
    expect(closed.is_open).toBe(false);
    expect(closed.closed_at).not.toBe(null);
    const none = await desk("post", `${API}/shifts/close`, { data: { counted_cash: 0 } });
    expect(none.status).toBe(409);
  });

  test("12. every desk endpoint is refused without BILLING_DESK", async () => {
    for (const [method, url, data] of DESK_CALLS()) {
      const response = await call("coordinator", method, url, data === undefined ? {} : { data });
      expect(response.status, `${method.toUpperCase()} ${url}`).toBe(403);
      expect(response.body.error, `${method.toUpperCase()} ${url}`).toMatch(/permission|account/i);
    }
  });

  test("13. every master endpoint is refused without BILLING_MASTER", async () => {
    for (const [method, url, data] of MASTER_CALLS()) {
      const response = await call("reception", method, url, data === undefined ? {} : { data });
      expect(response.status, `${method.toUpperCase()} ${url}`).toBe(403);
      expect(response.body.error, `${method.toUpperCase()} ${url}`).toMatch(/permission|account/i);
    }
    for (const [method, url, data] of MASTER_CALLS()) {
      const response = await call("admin", method, url, data === undefined ? {} : { data });
      expect(response.status, `${method.toUpperCase()} ${url}`).not.toBe(403);
      expect(response.status, `${method.toUpperCase()} ${url}`).toBeLessThan(500);
    }
  });

  test("14. an id that isn't an id is refused in words, never a 500", async () => {
    const BAD = "not-a-uuid";
    const deskUrls = [
      ["get", `${API}/bills/${BAD}`, undefined],
      ["get", `${API}/visits/${BAD}/bills`, undefined],
      ["post", `${API}/visits/${BAD}/bills`, {}],
      ["get", `${API}/visits/${BAD}/not-priced`, undefined],
      ["post", `${API}/bills/${BAD}/lines`, { item_id: fixture.brace }],
      ["patch", `${API}/bills/${BAD}/lines/${BAD}`, { quantity: 2 }],
      ["post", `${API}/bills/${BAD}/lines/${BAD}/remove`, { reason: "Not needed" }],
      ["post", `${API}/bills/${BAD}/codes`, { code: CODE }],
      ["delete", `${API}/bills/${BAD}/codes/${CODE}`, undefined],
      ["patch", `${API}/bills/${BAD}/category`, { category: fixture.paid }],
      ["post", `${API}/bills/${BAD}/finalise`, { version: 0 }],
      ["post", `${API}/bills/${BAD}/cancel`, { reason: "Billed twice" }],
      [
        "post",
        `${API}/bills/${BAD}/payments`,
        { version: 0, payments: [{ mode: "cash", amount: 5 }] },
      ],
      ["get", `${API}/bills/${BAD}/payments`, undefined],
      ["get", `${API}/bills/${BAD}/bill.pdf`, undefined],
      ["get", `${API}/bills/${BAD}/receipt.pdf`, undefined],
      ["get", `${API}/dues?patient_id=${BAD}`, undefined],
      ["get", `${API}/items/search?limit=${BAD}`, undefined],
      [
        "post",
        `${API}/requests/repeat`,
        { service_item_id: fixture.dressing, visit_id: BAD, reason: "x" },
      ],
    ];
    for (const [method, url, data] of deskUrls) {
      const response = await desk(method, url, data === undefined ? {} : { data });
      expect(response.status, `${method.toUpperCase()} ${url}`).toBe(400);
      expect(String(response.body.error), `${method.toUpperCase()} ${url}`).toMatch(/\w/);
    }
    const masterUrls = [
      ["post", `${API}/master/requests/${BAD}/approve`, {}],
      ["post", `${API}/master/requests/${BAD}/reject`, { note: "No" }],
      ["post", `${API}/master/shifts/${BAD}/close`, { counted_cash: 0 }],
      ["get", `${API}/master/shifts?user_id=${BAD}`, undefined],
    ];
    for (const [method, url, data] of masterUrls) {
      const response = await master(method, url, data === undefined ? {} : { data });
      expect(response.status, `${method.toUpperCase()} ${url}`).toBe(400);
    }
  });

  test("15. a printout URL is refused for a token without the capability, and for a bad one", async () => {
    const guest = await anonymousApi();
    try {
      const coordinator = (await tokensFor("coordinator")).access;
      const refused = await guest.get(`${API}/bills/${ids.bill}/bill.pdf?token=${coordinator}`);
      expect(refused.status()).toBe(403);
      expect((await refused.json()).error).toMatch(/permission/i);

      for (const token of ["garbage", ""]) {
        const bad = await guest.get(`${API}/bills/${ids.bill}/bill.pdf?token=${token}`);
        expect(bad.status(), `token "${token}"`).toBe(403);
      }

      const { access } = await tokensFor("reception");
      const signed = await guest.get(`${API}/bills/${ids.bill}/bill.pdf?token=${access}`);
      expect(signed.status()).toBe(200);
      const body = await signed.body();
      expect(signed.headers()["content-length"]).toBe(String(body.length));
      expect(signed.headers()["content-disposition"]).toMatch(
        /^inline; filename="[A-Za-z0-9_.-]+"$/,
      );
    } finally {
      await guest.dispose();
    }
  });

  test("16. a draft with no items still prints, and a receipt for another bill's payment does not", async () => {
    const other = await extraVisit(fixture, "Pdf");
    const draft = ok(await desk("post", `${API}/visits/${other.visit}/bills`, { data: {} }));
    const printed = await desk("get", `${API}/bills/${draft.id}/bill.pdf`);
    expect(printed.status, String(printed.body)).toBe(200);
    expect(printed.body.subarray(0, 4).toString()).toBe("%PDF");
    expect(printed.headers["content-disposition"]).toMatch(/filename="Bill_draft_/);

    const none = await desk("get", `${API}/bills/${draft.id}/receipt.pdf`);
    expect(none.status).toBe(404);
    expect(none.body.error).toMatch(/No payment has been taken/i);

    const elsewhere = await desk("get", `${API}/bills/${ids.bill}/receipt.pdf`, {
      params: { payment_id: "11111111-2222-3333-4444-555555555555" },
    });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body.error).toMatch(/isn't on this bill/i);
  });
});
