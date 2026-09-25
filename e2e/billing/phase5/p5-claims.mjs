import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, payRule, setUp, subCategory } from "../phase4/p4-bills-fixture.mjs";

const bills = await import("../../../server/services/billing/bills.js");

export const db = getPool();

export const deskAdmin = {
  actorId: USERS.reception_admin.id,
  ip: "10.9.50.2",
  role: USERS.reception_admin.role,
};

export const admin = { actorId: USERS.admin.id, ip: "10.9.50.1", role: USERS.admin.role };

const item = async (ids, code, name, price) =>
  (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $2, $3, $4, 'procedure') RETURNING id`,
      [`P4-${code}-${ids.tag}`, `${name} ${ids.tag}`, ids.subgroup, price],
    )
  ).id;

export async function setUpClaims(tag) {
  const ids = await setUp(tag);
  ids.fee700 = await item(ids, "P5B", "P5 Consult Banshali", 700);
  ids.fee350 = await item(ids, "P5R", "P5 Consult Rahul", 350);
  await query(
    `INSERT INTO category_item_rates (scheme_code, service_item_id, bill_code, valid_from)
     VALUES ($1, $2, 'CC02', $4::date - 1), ($1, $3, 'CC01', $4::date - 1)`,
    [ids.parent, ids.fee700, ids.fee350, ids.day],
  );
  await payRule(ids, ids.pensioner, { name: "pensioner claims all", patient_pays: "nothing" });
  await payRule(ids, ids.referral, { name: "referral claims all", patient_pays: "nothing" });
  await payRule(ids, ids.paid, {
    name: "paid pays part",
    patient_pays: "amount",
    patient_value: 100,
  });
  ids.other = await subCategory(ids, "Echs", { payer_name: `ECHS ${tag}` });
  await payRule(ids, ids.other, { name: "echs claims all", patient_pays: "nothing" });
  return ids;
}

export async function claimBill(
  ids,
  label,
  { category, itemId, doctor = CONSULTANTS.banshali, pay = null } = {},
) {
  const { patient, visit } = await extraVisit(ids, label, { doctorId: doctor.id });
  const draft = await bills.openDraft(visit, desk, db);
  for (const id of [itemId].flat()) {
    await bills.addLine(draft.id, { item_id: id, doctor_id: doctor.id }, desk, db);
  }
  const choice = { category };
  if (category === ids.referral) {
    const scan = await one(
      `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'CGHS form')
       RETURNING id`,
      [patient],
    );
    Object.assign(choice, { referral_no: "CGHS/REF/12345678", referral_doc_id: scan.id });
  }
  const ready = await bills.setCategory(draft.id, choice, desk, db);
  if (pay) await pay(ready);
  const fresh = await bills.readBill(draft.id, db);
  const final = await bills.finaliseBill(
    draft.id,
    { version: fresh.version, pay_later: fresh.totals.payable > fresh.totals.paid },
    desk,
    db,
  );
  return { patient, visit, bill: final };
}

export const pensionerBill = (ids, label = "Pens") =>
  claimBill(ids, label, { category: ids.pensioner, itemId: ids.fee700 });

export const referralBill = (ids, label = "Refr") =>
  claimBill(ids, label, {
    category: ids.referral,
    itemId: ids.fee350,
    doctor: CONSULTANTS.rahul,
  });

export const mine = (list, ids) => {
  const rows = list.rows.filter((row) => row.payer_name?.endsWith(ids.tag));
  return { rows, amount: rows.reduce((sum, row) => sum + row.claim, 0) };
};

export const scoped = (ids, extra = {}) => ({ payer: `CGHS ${ids.tag}`, ...extra });

export const auditOf = (entity, id) =>
  query(
    `SELECT action, before, after, actor_id FROM billing_audit
      WHERE entity = $1 AND entity_id = $2 ORDER BY id`,
    [entity, String(id)],
  ).then((r) => r.rows);

export const billClaim = (id) =>
  one(`SELECT claim_status, claim_settlement_id, version FROM bills WHERE id = $1`, [id]);

export async function mountClaims() {
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const { repoRoot } = await import("../../setup/testEnv.mjs");
  const express = createRequire(path.join(repoRoot, "server", "package.json"))("express");
  const { default: router } = await import("../../../server/routes/billingClaims.js");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const user = Object.values(USERS).find((u) => String(u.id) === req.headers["x-test-user"]);
    if (user) req.doctor = { doctor_id: user.id, role: user.role };
    next();
  });
  app.use("/api", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { as = "reception_admin", body } = {}) => {
    const headers = { "x-test-user": String(USERS[as].id) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${url}/api/billing/claims${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const kind = res.headers.get("content-type") ?? "";
    return {
      status: res.status,
      headers: res.headers,
      body: kind.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
    };
  };
  return { url, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

export const queryString = (params) =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
