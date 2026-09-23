import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase, TEST_DATABASE_URL } from "../../setup/guard.mjs";

process.env.DATABASE_URL = process.env.DATABASE_URL || TEST_DATABASE_URL;
assertTestDatabase(process.env.DATABASE_URL);

process.env.SUPABASE_URL = "p421-unreachable-bus";
process.env.SUPABASE_SERVICE_KEY = "p421-service-key";
process.env.SUPABASE_JWT_SECRET = "p421-jwt-secret";
process.env.SUPABASE_ANON_KEY = "p421-anon-key";

const svc = await import("../../../server/services/billing/billingRequests.js");
const bus = await import("../../../server/services/giniflow/realtimeBus.js");

const db = getPool();
const tag = crypto.randomBytes(3).toString("hex");
const desk = { actorId: USERS.reception.id, ip: "10.9.21.1" };
const admin = { actorId: USERS.reception_admin.id, ip: "10.9.21.2" };
const ids = {};
let lineNo = 0;

const failure = (promise) => promise.then(() => null).catch((e) => e);
const refused = async (promise, status, label) => {
  const error = await failure(promise);
  expect(error?.status, `${label}: ${error?.message ?? "no refusal"}`).toBe(status);
  return error;
};

const PUBLISH_PREFIX = "[giniflow realtime] publish failed:";
const ANNOUNCE_PREFIX = "[billing requests] live update not sent:";

const sent = [];
const probes = [];
const unhandled = [];
let atPublish = null;
const realWarn = console.warn;

console.warn = (...args) => {
  if (args[0] === PUBLISH_PREFIX) {
    sent.push(args[1]);
    if (atPublish) probes.push(atPublish(args[1]));
    return;
  }
  if (args[0] === ANNOUNCE_PREFIX) return;
  realWarn(...args);
};

const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
process.on("unhandledRejection", onUnhandled);

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const watch = async (work, onPublish = null) => {
  await settle();
  const before = sent.length;
  const probesBefore = probes.length;
  atPublish = onPublish;
  const result = await work();
  await settle();
  atPublish = null;
  return {
    result,
    topics: sent.slice(before),
    probed: await Promise.all(probes.slice(probesBefore)),
  };
};

const topicsFor = (date) => [
  "giniflow:station:billing-requests",
  ...(date ? [`giniflow:day:${date}`] : []),
];

const committedAndUnlocked = (id) =>
  query(`SELECT status, decided_by FROM billing_requests WHERE id = $1 FOR UPDATE NOWAIT`, [id])
    .then((r) => r.rows[0] ?? "no row")
    .catch((e) => `locked (${e.code})`);

const pendingOnVisit = () =>
  query(
    `SELECT id FROM billing_requests WHERE visit_id = $1 AND status = 'pending' FOR UPDATE NOWAIT`,
    [ids.visit],
  )
    .then((r) => r.rows.map((row) => row.id))
    .catch((e) => `locked (${e.code})`);

const firstProbe = (probed) => probed.find(Boolean) ?? null;

const COMMIT_DELAY_MS = 400;

const slowCommitPool = {
  query: (...args) => db.query(...args),
  connect: async () => {
    const client = await db.connect();
    return {
      query: async (text, params) => {
        if (text === "COMMIT") await new Promise((resolve) => setTimeout(resolve, COMMIT_DELAY_MS));
        return client.query(text, params);
      },
      release: (...args) => client.release(...args),
    };
  },
};

const addLine = (item, visit = ids.visit, bill = ids.bill) =>
  one(
    `INSERT INTO bill_lines
       (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
        listed_actual, actual_amount, taxable, patient_payable)
     VALUES ($1, $2, $3, $4, $5, 1, 400, 400, 400, 400, 400) RETURNING id`,
    [bill, visit, ++lineNo, item, `RT21 line ${lineNo}`],
  ).then((r) => r.id);

const newItemRequest = (name, extra = {}, into = db) =>
  svc.createNewItemRequest(
    {
      proposed_name: name,
      proposed_group: "Consumables",
      reason: "The doctor asked for it",
      ...extra,
    },
    desk,
    into,
  );

const repeatRequest = (item, visit = ids.visit, into = db) =>
  svc.createRepeatRequest(
    { service_item_id: item, visit_id: visit, reason: "Other knee, per Dr Rahul" },
    desk,
    into,
  );

const approveAndUse = async (item) => {
  const request = await repeatRequest(item);
  await svc.approveRequest(request.id, { note: "Fine" }, admin, db);
  return request.id;
};

test.describe.serial("P4-21 live updates for desk requests", () => {
  test.beforeAll(async () => {
    ids.group = (
      await one(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
        `RT21G-${tag}`,
        `RT21 Live ${tag}`,
      ])
    ).id;
    ids.subgroup = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Procedures') RETURNING id`,
        [ids.group, `RT21S-${tag}`],
      )
    ).id;
    const item = async (code, name) =>
      (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
           VALUES ($1, $2, $3, 400, 'procedure') RETURNING id`,
          [`${code}-${tag}`, name, ids.subgroup],
        )
      ).id;
    ids.xray = await item("RT21-XR", `RT21 X-ray knee ${tag}`);
    ids.dressing = await item("RT21-DR", `RT21 Dressing ${tag}`);
    ids.spare = await item("RT21-SP", `RT21 Spare ${tag}`);
    ids.again = await item("RT21-AG", `RT21 Again ${tag}`);
    ids.patient = (
      await one(`INSERT INTO patients (name, file_no, age) VALUES ($1, $2, 44) RETURNING id`, [
        `RT21 Patient ${tag}`,
        `FRT21-${tag}`,
      ])
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.bill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.visit,
      ])
    ).id;
    ids.visitDate = (
      await one(`SELECT visit_date::text AS date FROM giniflow_visits WHERE id = $1`, [ids.visit])
    ).date;
    await addLine(ids.xray);
    await addLine(ids.dressing);
    await addLine(ids.spare);
    await addLine(ids.again);
  });

  test("1. a created request really reaches both topics, after it commits", async () => {
    const {
      result: request,
      topics,
      probed,
    } = await watch(
      () => repeatRequest(ids.xray, ids.visit, slowCommitPool),
      (topic) => (topic.startsWith("giniflow:station:") ? pendingOnVisit() : null),
    );
    ids.created = request.id;

    expect(topics).toEqual(topicsFor(ids.visitDate));
    expect(request.visit_date).toBe(ids.visitDate);
    expect(svc.requestEvent("created", request)).toEqual({
      kind: "billing_request",
      action: "created",
      date: ids.visitDate,
      requestId: request.id,
      requestKind: "repeat_item",
      status: "pending",
      visitId: ids.visit,
      billId: ids.bill,
      itemId: ids.xray,
      createdItemId: null,
    });
    expect(firstProbe(probed)).toContain(request.id);
  });

  test("2. an approval is published only once the decision is committed and unlocked", async () => {
    const {
      result: approved,
      topics,
      probed,
    } = await watch(
      () => svc.approveRequest(ids.created, { note: "Fine" }, admin, slowCommitPool),
      (topic) => (topic.startsWith("giniflow:station:") ? committedAndUnlocked(ids.created) : null),
    );

    expect(topics).toEqual(topicsFor(ids.visitDate));
    expect(firstProbe(probed)).toEqual({
      status: "approved",
      decided_by: USERS.reception_admin.id,
    });
    expect(svc.requestEvent("approved", approved)).toMatchObject({
      kind: "billing_request",
      action: "approved",
      status: "approved",
      requestId: ids.created,
      requestKind: "repeat_item",
      visitId: ids.visit,
      itemId: ids.xray,
      date: ids.visitDate,
    });
  });

  test("3. a rejection is published, and a new item's approval names the item it created", async () => {
    const toReject = await repeatRequest(ids.dressing);
    ids.rejected = toReject.id;
    const {
      result: rejected,
      topics,
      probed,
    } = await watch(
      () => svc.rejectRequest(toReject.id, { note: "Already billed today" }, admin, db),
      (topic) => (topic.startsWith("giniflow:station:") ? committedAndUnlocked(toReject.id) : null),
    );

    expect(topics).toEqual(topicsFor(ids.visitDate));
    expect(firstProbe(probed)).toMatchObject({ status: "rejected" });
    expect(svc.requestEvent("rejected", rejected)).toMatchObject({
      action: "rejected",
      status: "rejected",
      requestId: toReject.id,
    });

    const newItem = await newItemRequest(`RT21 Ankle brace ${tag}`, { visit_id: ids.visit });
    ids.newItem = newItem.id;
    const { result: approved, topics: onApproval } = await watch(() =>
      svc.approveRequest(
        newItem.id,
        {
          note: "Under consumables",
          item: {
            code: `RT21-AB-${tag}`,
            subgroup_id: ids.subgroup,
            base_price: 600,
            kind: "other",
          },
        },
        admin,
        db,
      ),
    );
    ids.createdItem = approved.created_item.id;
    expect(onApproval).toEqual(topicsFor(ids.visitDate));
    expect(svc.requestEvent("approved", approved)).toMatchObject({
      action: "approved",
      requestKind: "new_item",
      status: "approved",
      itemId: null,
      createdItemId: ids.createdItem,
    });
  });

  test("4. the envelope names no patient, no staff member and nothing readable", async () => {
    const request = await svc.getRequest(ids.created, db);
    expect(request.patient.name).toBe(`RT21 Patient ${tag}`);
    expect(request.requested_by.id).toBe(USERS.reception.id);
    const event = svc.requestEvent("approved", request);
    expect(Object.keys(event).sort()).toEqual(
      [
        "action",
        "billId",
        "createdItemId",
        "date",
        "itemId",
        "kind",
        "requestId",
        "requestKind",
        "status",
        "visitId",
      ].sort(),
    );
    const wire = JSON.stringify(event);
    expect(wire).not.toContain(`RT21 Patient ${tag}`);
    expect(wire).not.toContain(`FRT21-${tag}`);
    expect(wire).not.toContain(String(request.patient.id));
    expect(wire).not.toContain("RT21 X-ray knee");
    expect(wire).not.toContain(String(USERS.reception.id));
    expect(wire).not.toContain(String(USERS.reception_admin.id));
  });

  test("5. the bus sends each envelope to the admin inbox and to the visit's day", async () => {
    const request = await svc.getRequest(ids.created, db);
    const withVisit = await bus.publishBillingRequest(svc.requestEvent("approved", request));
    expect(withVisit.topics).toEqual(topicsFor(ids.visitDate));
    expect(bus.billingRequestsTopic()).toBe("giniflow:station:billing-requests");
    expect(bus.BILLING_REQUESTS_STATION).toBe("billing-requests");

    const noVisit = await bus.publishBillingRequest({
      ...svc.requestEvent("created", request),
      date: null,
    });
    expect(noVisit.topics).toEqual(topicsFor(null));
    expect(noVisit.published).toBe(false);
    expect(noVisit.results.every((r) => r.published === false)).toBe(true);
  });

  test("6. every publish failing never fails or rolls back the decision", async () => {
    const request = await repeatRequest(ids.spare);
    const { result: approved, topics } = await watch(() =>
      svc.approveRequest(request.id, { note: "Bus down, decision stands" }, admin, db),
    );

    expect(topics).toEqual(topicsFor(ids.visitDate));
    expect(approved.status).toBe("approved");
    const stored = await one(`SELECT status, decided_by FROM billing_requests WHERE id = $1`, [
      request.id,
    ]);
    expect(stored).toMatchObject({ status: "approved", decided_by: USERS.reception_admin.id });
    const audits = await query(
      `SELECT action FROM billing_audit WHERE entity = 'billing_requests' AND entity_id = $1 ORDER BY id`,
      [String(request.id)],
    );
    expect(audits.rows.map((r) => r.action)).toEqual(["create", "approve"]);
    ids.busDown = request.id;
  });

  test("7. a refused decision publishes nothing", async () => {
    const { topics: onSecondApproval } = await watch(() =>
      refused(
        svc.approveRequest(ids.created, { note: "Again" }, admin, db),
        409,
        "already approved",
      ),
    );
    expect(onSecondApproval).toEqual([]);

    const { topics: onRejectingDecided } = await watch(() =>
      refused(
        svc.rejectRequest(ids.rejected, { note: "Again" }, admin, db),
        409,
        "already rejected",
      ),
    );
    expect(onRejectingDecided).toEqual([]);

    const { topics: onRefusedCreate } = await watch(() =>
      refused(repeatRequest(ids.xray), 409, "approval already waiting"),
    );
    expect(onRefusedCreate).toEqual([]);
  });

  test("8. joined to a caller's open transaction, nothing is published before that commit", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { result: request, topics } = await watch(() =>
        newItemRequest(`RT21 Splint ${tag}`, { visit_id: ids.visit }, client),
      );
      expect(topics).toEqual([]);
      expect(request.status).toBe("pending");
      await client.query("ROLLBACK");
      expect(await one(`SELECT id FROM billing_requests WHERE id = $1`, [request.id])).toBeNull();
    } finally {
      client.release();
    }

    const poolWithRelease = { query: (...args) => db.query(...args), release: () => {} };
    const { topics: onPoolLike } = await watch(() =>
      failure(newItemRequest(`RT21 Sling ${tag}`, { visit_id: ids.visit }, poolWithRelease)),
    );
    expect(onPoolLike).toEqual([]);
  });

  test("9. spending an approval is published, and stays silent inside the bills service", async () => {
    const approvalId = await approveAndUse(ids.again);
    const { result: used, topics } = await watch(() =>
      svc.useRepeatApproval(approvalId, { visitId: ids.visit, serviceItemId: ids.again }, desk, db),
    );
    expect(used.status).toBe("used");
    expect(topics).toEqual(topicsFor(ids.visitDate));
    expect(svc.requestEvent("used", used)).toMatchObject({
      action: "used",
      status: "used",
      requestId: approvalId,
      itemId: ids.again,
      date: ids.visitDate,
    });

    const nextApproval = await approveAndUse(ids.again);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { topics: joined } = await watch(() =>
        svc.useRepeatApproval(
          nextApproval,
          { visitId: ids.visit, serviceItemId: ids.again },
          desk,
          client,
        ),
      );
      expect(joined).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await one(`SELECT status FROM billing_requests WHERE id = $1`, [nextApproval])).status,
    ).toBe("approved");
  });

  test("10. no publish ever escaped as an unhandled rejection", async () => {
    await settle();
    expect(unhandled).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    atPublish = null;
    console.warn = realWarn;
    process.off("unhandledRejection", onUnhandled);
    const wipe = async (sql, params) => {
      await query(sql, params).catch(() => {});
    };
    await wipe(`DELETE FROM bill_lines WHERE visit_id = $1`, [ids.visit]);
    await wipe(`DELETE FROM billing_requests WHERE visit_id = $1`, [ids.visit]);
    await wipe(`DELETE FROM bills WHERE visit_id = $1`, [ids.visit]);
    await wipe(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit]);
    await wipe(`DELETE FROM patients WHERE id = $1`, [ids.patient]);
    await wipe(`DELETE FROM service_items WHERE subgroup_id = $1`, [ids.subgroup]);
    await wipe(`DELETE FROM service_subgroups WHERE id = $1`, [ids.subgroup]);
    await wipe(`DELETE FROM service_groups WHERE id = $1`, [ids.group]);
  });
});
