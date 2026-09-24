import "../loadEnv.js";
import crypto from "node:crypto";

const target = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL || "");
    return { host: `${url.hostname}:${url.port || 5432}`, name: url.pathname.slice(1) };
  } catch {
    return { host: "unknown", name: "" };
  }
})();
console.log(`Billing bills smoke — ${target.host}/${target.name} — everything is rolled back\n`);
if (!/test/i.test(target.name) && process.env.SMOKE_ANY_DATABASE !== "1") {
  console.log(
    `Refused: ${target.name || "this database"} is not a test database. Point DATABASE_URL at one, or set SMOKE_ANY_DATABASE=1 if you really mean to run it here.`,
  );
  process.exit(2);
}

const { default: pool } = await import("../config/db.js");
const { indiaToday } = await import("../services/billing/categoryResolver.js");
const { financialYear } = await import("../services/billing/billSeries.js");
const bills = await import("../services/billing/bills.js");
const payments = await import("../services/billing/payments.js");
const requests = await import("../services/billing/billingRequests.js");
const visitLines = await import("../services/billing/visitLines.js");
const reception = await import("../services/giniflow/receptionStation.js");
const { opensLabGate } = await import("../../shared/labPayment.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const coded = (name) => `SMKB-${name}-${T}`;
const named = (name) => `Smoke ${name} ${tag}`;
const schemeCode = (name) => `smkb_${name}_${tag}`;
const DAY = indiaToday();
const FY = financialYear(DAY);
const FAR_DAY = "2091-06-01";
const FAR_FY = financialYear(FAR_DAY);
const FAR_PREFIX = "SMKB/";
const CARD = "CGHS-40981234";
const REFERRAL = "REF-2026-5566";

const results = [];
const notes = [];
const world = {};
let client = null;
let desk = null;
let admin = null;

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name, work) {
  await client.query("SAVEPOINT smoke_check");
  try {
    await work();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT smoke_check");
    await client.query("RELEASE SAVEPOINT smoke_check");
  }
}

async function refused(work, status, pattern, label) {
  try {
    await work();
  } catch (error) {
    expect(
      error.status === status,
      `${label}: expected ${status}, got ${error.status} ${error.message}`,
    );
    expect(pattern.test(error.message), `${label}: unexpected message "${error.message}"`);
    return error;
  }
  throw new Error(`${label}: it was accepted`);
}

const joined = (db) => ({
  query: (text, params) => db.query(text, params),
  connect: async () => ({
    query: (text, params) => {
      const verb = typeof text === "string" ? text.trim().toUpperCase() : "";
      if (verb === "BEGIN") return db.query("SAVEPOINT smoke_joined");
      if (verb === "COMMIT") return db.query("RELEASE SAVEPOINT smoke_joined");
      if (verb === "ROLLBACK") return db.query("ROLLBACK TO SAVEPOINT smoke_joined");
      return db.query(text, params);
    },
    release: () => {},
  }),
});

async function insert(db, table, columns, returning = "id") {
  const keys = Object.keys(columns);
  const { rows } = await db.query(
    `INSERT INTO ${table} (${keys.join(", ")})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${returning}`,
    keys.map((key) => columns[key]),
  );
  return rows[0][returning];
}

async function catalogue(db, suffix) {
  const group = await insert(db, "service_groups", {
    code: coded(`G${suffix}`),
    name: named(`Group ${suffix}`),
  });
  const subgroup = await insert(db, "service_subgroups", {
    group_id: group,
    code: coded(`S${suffix}`),
    name: named(`Subgroup ${suffix}`),
  });
  const item = (code, name, price, extra = {}) =>
    insert(db, "service_items", {
      code: coded(`${code}${suffix}`),
      name: named(`${name}${suffix}`),
      subgroup_id: subgroup,
      base_price: price,
      kind: "procedure",
      ...extra,
    });
  return { group, subgroup, item };
}

async function patientVisit(db, label, { date = DAY, scheme = null, doctorId = null } = {}) {
  const name = named(`Patient ${label}`);
  const fileNo = coded(`F${label}`);
  const patient = await insert(db, "patients", {
    name,
    file_no: fileNo,
    age: 66,
    sex: "Male",
    scheme_code: scheme,
  });
  const appointment = await insert(db, "appointments", {
    patient_id: patient,
    patient_name: name,
    file_no: fileNo,
    appointment_date: date,
    visit_type: "New Patient",
    doctor_id: doctorId,
  });
  const visit = await insert(db, "giniflow_visits", {
    patient_id: patient,
    visit_date: date,
    appointment_id: appointment,
    assigned_doctor_id: doctorId,
  });
  return { patient, appointment, visit };
}

async function seed() {
  desk = {
    actorId: await insert(client, "doctors", { name: named("Desk"), role: "reception" }),
    ip: "10.9.37.1",
    role: "reception",
  };
  admin = {
    actorId: await insert(client, "doctors", {
      name: named("Desk Admin"),
      role: "reception_admin",
    }),
    ip: "10.9.37.2",
    role: "reception_admin",
  };
  const found = await client.query(
    `SELECT id, name FROM doctors WHERE name ILIKE '%banshali%' AND is_active ORDER BY id LIMIT 1`,
  );
  world.banshali =
    found.rows[0]?.id ??
    (await insert(client, "doctors", { name: named("Dr Banshali"), role: "consultant" }));
  if (!found.rows.length) notes.push("No Dr Banshali on this database — a stand-in was used.");

  for (const [series, prefix] of [
    ["MAIN", `SB${T}/`],
    ["RCPT", `SR${T}/`],
  ]) {
    await client.query(
      `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
       VALUES ($1, $2, $3, 6, 1) ON CONFLICT (series, fy) DO NOTHING`,
      [series, FY, prefix],
    );
  }

  world.cghs = schemeCode("cghs");
  await insert(
    client,
    "patient_schemes",
    { code: world.cghs, label: named("CGHS"), payer_name: named("CGHS payer") },
    "code",
  );
  const sub = (key, label, extra = {}) =>
    insert(
      client,
      "patient_schemes",
      { code: schemeCode(key), label, parent_code: world.cghs, ...extra },
      "code",
    );
  world.paid = await sub("paid", "Paid");
  world.referral = await sub("ref", "Referral", {
    requires_referral: true,
    requires_referral_doc: true,
  });
  world.pensioner = await sub("pens", "Pensioner");
  for (const scheme of [world.referral, world.pensioner]) {
    await insert(client, "category_payment_rules", {
      scheme_code: scheme,
      name: named(`${scheme} claims all`),
      patient_pays: "nothing",
      remainder: "claim",
    });
  }

  const { subgroup, item } = await catalogue(client, "");
  world.subgroup = subgroup;
  world.dressing = await item("DR", "Dressing", 500);
  world.brace = await item("BR", "Ankle brace", 800);
  world.item = item;
  world.hba1cName = named("HbA1c");
  const test = await insert(client, "giniflow_test_catalog", {
    test_name: world.hba1cName,
    price: 250,
    category: "lab",
  });
  world.hba1c = await item("HB", "HbA1c item", 250, { kind: "test", test_catalog_id: test });
  world.coupon = `SMKB${T}`;
  world.couponId = await insert(client, "discount_rules", {
    code: world.coupon,
    name: named("Coupon"),
    method: "code",
    kind: "percent",
    value: 10,
    applies_per: "line",
  });
}

const visit = (label, options) => patientVisit(client, label, options);

async function draftWith(label, itemIds, options) {
  const v = await visit(label, options);
  let bill = await bills.openDraft(v.visit, desk, client);
  for (const id of itemIds) bill = await bills.addLine(bill.id, { item_id: id }, desk, client);
  return { ...v, bill };
}

async function pay(bill, amount) {
  const fresh = await bills.readBill(bill.id, client);
  return payments.takePayments(
    fresh.id,
    { version: fresh.version, mode: "upi", amount, reference: `UPI${T}${amount}` },
    desk,
    client,
  );
}

async function finalise(billId, extra = {}) {
  const fresh = await bills.readBill(billId, client);
  return bills.finaliseBill(billId, { version: fresh.version, ...extra }, desk, client);
}

async function labOrder(visitId) {
  const order = await insert(client, "giniflow_lab_orders", {
    visit_id: visitId,
    urgency: "today",
    payment_status: "pending",
    amount_total: 250,
    sample_status: "payment_pending",
    kind: "lab",
  });
  await insert(client, "giniflow_lab_order_tests", {
    lab_order_id: order,
    test_name: world.hba1cName,
    price: 250,
  });
  return order;
}

async function testOnBill(visitId) {
  const order = await labOrder(visitId);
  const raised = await visitLines.linesForOrder(
    visitId,
    { labOrderId: order, testNames: [world.hba1cName] },
    desk,
    client,
  );
  expect(raised.ok && raised.added.length === 1, `the test was not billed: ${raised.error}`);
  return { order, billId: raised.bill_id };
}

const orderRow = async (id) =>
  (
    await client.query(
      `SELECT payment_status, sample_status, amount_paid, amount_claimed, version
         FROM giniflow_lab_orders WHERE id = $1`,
      [id],
    )
  ).rows[0];

const paymentCount = async (billId) =>
  (await client.query(`SELECT count(*)::int AS n FROM payments WHERE bill_id = $1`, [billId]))
    .rows[0].n;

async function run() {
  await check("1. finalise and pay: twice is refused, overpaying is refused", async () => {
    const { bill } = await draftWith("Fin", [world.dressing]);
    await refused(() => pay(bill, 600), 409, /₹500.00 is left to collect/, "paying ₹600 on ₹500");
    await pay(bill, 500);
    const final = await finalise(bill.id);
    expect(final.status === "final" && final.bill_no, "the bill was not made final");
    expect(final.totals.paid === 50000, `paid ${final.totals.paid}`);
    await refused(() => finalise(bill.id), 409, /already final/, "finalising twice");
    await refused(() => pay(final, 1), 409, /Nothing is left to collect/, "paying a paid bill");
  });

  await check("2. never twice: refused on a second bill, one repeat per approval", async () => {
    const first = await draftWith("Twice", [world.brace]);
    await pay(first.bill, 800);
    await finalise(first.bill.id);
    const second = await bills.openDraft(first.visit, desk, client);
    expect(second.id !== first.bill.id, "no second bill was opened");
    await refused(
      () => bills.addLine(second.id, { item_id: world.brace }, desk, client),
      409,
      /Already billed on bill/,
      "the same item on a second bill",
    );
    const asked = await requests.createRepeatRequest(
      { service_item_id: world.brace, visit_id: first.visit, reason: "Second brace fitted" },
      desk,
      client,
    );
    await requests.approveRequest(asked.id, { note: "Fine" }, admin, client);
    const repeated = await bills.addLine(second.id, { item_id: world.brace }, desk, client);
    const line = repeated.lines.find((l) => l.service_item_id === world.brace);
    expect(line?.repeat_request_id === asked.id, "the repeat line does not carry its approval");
    const used = await requests.getRequest(asked.id, client);
    expect(used.status === "used", `the approval is ${used.status}, not used`);
    await refused(
      () => bills.addLine(second.id, { item_id: world.brace }, desk, client),
      409,
      /Already billed/,
      "a third brace with the approval spent",
    );
    await refused(
      () =>
        requests.useRepeatApproval(
          asked.id,
          { visitId: first.visit, serviceItemId: world.brace },
          desk,
          client,
        ),
      409,
      /already been used/,
      "using the approval twice",
    );
  });

  await check("3. a new-item request creates the item, then it can be billed", async () => {
    const { visit: visitId, bill } = await draftWith("New", [world.dressing]);
    const wanted = named("Walking stick");
    const asked = await requests.createNewItemRequest(
      { proposed_name: wanted, reason: "Patient needs one", visit_id: visitId, bill_id: bill.id },
      desk,
      client,
    );
    expect(asked.status === "pending", `the request is ${asked.status}`);
    const approved = await requests.approveRequest(
      asked.id,
      {
        item: {
          code: coded("NEW"),
          subgroup_id: world.subgroup,
          base_price: 350,
          kind: "procedure",
        },
      },
      admin,
      client,
    );
    const created = approved.created_item?.id;
    expect(created, "no item was created");
    const added = await bills.addLine(bill.id, { item_id: created }, desk, client);
    const line = added.lines.find((l) => l.service_item_id === created);
    expect(line?.bill_name === wanted, "the new item is not on the bill");
    expect(added.totals.payable === 85000, `payable ${added.totals.payable}, expected 85000`);
  });

  await check(
    "4. zero payable: CGHS Referral and Pensioner finalise at ₹0 and open the gate",
    async () => {
      const ref = await visit("Ref");
      const refTest = await testOnBill(ref.visit);
      await bills.setCategory(
        refTest.billId,
        { category: world.referral, referral_no: REFERRAL },
        desk,
        client,
      );
      await refused(() => finalise(refTest.billId), 409, /referral letter/, "no referral scan");
      const scan = await insert(client, "documents", {
        patient_id: ref.patient,
        doc_type: "referral",
        title: named("Referral"),
      });
      await bills.setCategory(refTest.billId, { referral_doc_id: scan }, desk, client);
      const refBill = await finalise(refTest.billId);
      expect(refBill.status === "final", "the referral bill is not final");
      expect(refBill.totals.payable === 0, `referral payable ${refBill.totals.payable}`);
      expect(refBill.claim_status === "pending", `referral claim is ${refBill.claim_status}`);
      expect((await paymentCount(refTest.billId)) === 0, "a payment was taken on a ₹0 bill");
      const refOrder = await orderRow(refTest.order);
      expect(opensLabGate(refOrder.payment_status), `referral order is ${refOrder.payment_status}`);

      const pen = await visit("Pens", { doctorId: world.banshali });
      const penTest = await testOnBill(pen.visit);
      await bills.setCategory(penTest.billId, { category: world.pensioner }, desk, client);
      const penBill = await finalise(penTest.billId);
      expect(penBill.totals.payable === 0, `pensioner payable ${penBill.totals.payable}`);
      expect((await paymentCount(penTest.billId)) === 0, "a payment was taken on a ₹0 bill");
      const penOrder = await orderRow(penTest.order);
      expect(
        opensLabGate(penOrder.payment_status),
        `pensioner order is ${penOrder.payment_status}`,
      );
      expect(penOrder.sample_status === "paid", `the sample is ${penOrder.sample_status}`);
    },
  );

  await check(
    "4a. a Pensioner bill for Dr Banshali: ₹700, no payment, claim pending, cancellable",
    async () => {
      await client.query(
        `UPDATE service_items SET is_active = FALSE
          WHERE kind = 'consultation' AND is_active AND visit_type = 'New' AND doctor_id = $1`,
        [world.banshali],
      );
      const consult = await world.item("CN", "Consultation Dr Banshali New", 700, {
        kind: "consultation",
        visit_type: "New",
        doctor_id: world.banshali,
      });
      const { bill } = await draftWith("Banshali", [consult], { doctorId: world.banshali });
      await bills.setCategory(bill.id, { category: world.pensioner }, desk, client);
      const final = await finalise(bill.id);
      expect(final.totals.actual === 70000, `actual ${final.totals.actual}, expected 70000`);
      expect(final.totals.claim === 70000, `claim ${final.totals.claim}, expected 70000`);
      expect(final.totals.payable === 0, `payable ${final.totals.payable}`);
      expect(final.claim_status === "pending", `claim status ${final.claim_status}`);
      const receipts = await client.query(
        `SELECT count(*)::int AS n FROM payments WHERE bill_id = $1 AND receipt_no IS NOT NULL`,
        [bill.id],
      );
      expect(receipts.rows[0].n === 0 && (await paymentCount(bill.id)) === 0, "money was taken");
      const cancelled = await bills.cancelBill(bill.id, { reason: "Wrong doctor" }, desk, client);
      expect(cancelled.status === "cancelled", `the bill is ${cancelled.status}`);
      expect(cancelled.claim_status === "none", `claim status ${cancelled.claim_status}`);
    },
  );

  await check("4b. a coupon at its daily limit is refused at finalise", async () => {
    const first = await draftWith("Cap1", [world.dressing]);
    const coded1 = await bills.addCode(first.bill.id, { code: world.coupon }, desk, client);
    await pay(coded1, coded1.totals.payable / 100);
    await finalise(first.bill.id);
    const second = await draftWith("Cap2", [world.dressing]);
    const coded2 = await bills.addCode(second.bill.id, { code: world.coupon }, desk, client);
    await pay(coded2, coded2.totals.payable / 100);
    await client.query(`UPDATE discount_rules SET max_uses_per_day = 1 WHERE id = $1`, [
      world.couponId,
    ]);
    const refusal = await refused(
      () => finalise(second.bill.id),
      409,
      /Daily limit reached/,
      "a coupon over its daily limit",
    );
    expect(refusal.reason === "daily_limit", `reason ${refusal.reason}`);
    const after = await bills.readBill(second.bill.id, client);
    expect(after.status === "draft" && !after.bill_no, "the refused bill moved on");
  });

  await check("5. bare CGHS with no sub-category is refused", async () => {
    const { bill } = await draftWith("Bare", [world.dressing]);
    await refused(
      () => bills.setCategory(bill.id, { category: world.cghs }, desk, client),
      409,
      /has sub-categories/,
      "choosing bare CGHS",
    );
    const onCard = await draftWith("BareCard", [world.dressing], { scheme: world.cghs });
    const refusal = await refused(
      () => finalise(onCard.bill.id, { pay_later: true }),
      409,
      /choose one before this bill can be made final/,
      "finalising a bare-CGHS patient",
    );
    expect(refusal.needs_sub_category === true, "the refusal does not ask for a sub-category");
  });

  await check(
    "6. pay later: off refuses an unpaid finalise, on allows it and lists it",
    async () => {
      await client.query(`UPDATE billing_settings SET allow_pay_later = FALSE`);
      const { patient, bill } = await draftWith("Later", [world.dressing]);
      await refused(
        () => finalise(bill.id, { pay_later: true }),
        409,
        /Pay later isn't allowed/,
        "pay later while it is off",
      );
      await refused(() => finalise(bill.id), 409, /still to be collected/, "an unpaid finalise");
      await client.query(`UPDATE billing_settings SET allow_pay_later = TRUE`);
      const final = await finalise(bill.id, { pay_later: true });
      expect(final.status === "final" && final.pay_later === true, "not final on pay later");
      const dues = await payments.listDues({ patientId: patient }, client);
      const due = dues.find((row) => row.bill_id === bill.id);
      expect(due?.outstanding === 50000, `due ${JSON.stringify(due)}`);
    },
  );

  await check(
    "7. cancel: an unpaid bill cancels and frees its items, a paid one is refused",
    async () => {
      await client.query(`UPDATE billing_settings SET allow_pay_later = TRUE`);
      const unpaid = await draftWith("Cancel", [world.brace]);
      await finalise(unpaid.bill.id, { pay_later: true });
      await refused(
        () => bills.cancelBill(unpaid.bill.id, {}, desk, client),
        400,
        /Say why/,
        "cancelling with no reason",
      );
      const cancelled = await bills.cancelBill(
        unpaid.bill.id,
        { reason: "Patient left" },
        desk,
        client,
      );
      expect(cancelled.status === "cancelled", `the bill is ${cancelled.status}`);
      const again = await bills.openDraft(unpaid.visit, desk, client);
      const rebilled = await bills.addLine(again.id, { item_id: world.brace }, desk, client);
      expect(
        rebilled.lines.some((l) => l.service_item_id === world.brace && !l.repeat_request_id),
        "the cancelled bill's item was not freed",
      );
      const paid = await draftWith("Paid", [world.dressing]);
      await pay(paid.bill, 500);
      await finalise(paid.bill.id);
      await refused(
        () => bills.cancelBill(paid.bill.id, { reason: "Changed mind" }, desk, client),
        409,
        /Refunds are not available yet/,
        "cancelling a paid bill",
      );
    },
  );

  await check(
    "8. test gate: paying the line opens it, Clear payment works, no double collection",
    async () => {
      const billed = await visit("Gate");
      const onBill = await testOnBill(billed.visit);
      const before = await orderRow(onBill.order);
      expect(!opensLabGate(before.payment_status), `the order started ${before.payment_status}`);
      const paid = await pay({ id: onBill.billId }, 250);
      expect(paid.orders.length === 1, `${paid.orders.length} orders were written through`);
      const settled = await orderRow(onBill.order);
      expect(settled.payment_status === "paid", `the order is ${settled.payment_status}`);
      expect(settled.sample_status === "paid", `the sample is ${settled.sample_status}`);
      expect(Number(settled.amount_paid) === 250, `amount_paid ${settled.amount_paid}`);

      const shim = joined(client);
      const clearAgain = (orderId) =>
        reception.clearPayment(
          orderId,
          { method: "paid", actorId: desk.actorId, confirmNotOnBill: true },
          shim,
        );
      let collected = null;
      try {
        collected = await clearAgain(onBill.order);
      } catch (error) {
        expect(error.status === 409, `reception's clear failed: ${error.status} ${error.message}`);
      }
      if (collected) expect(collected.alreadySettled === true, "reception collected it again");
      const after = await orderRow(onBill.order);
      expect(Number(after.amount_paid) === 250, `amount_paid became ${after.amount_paid}`);
      expect(after.version === settled.version, "the order was written again");

      const desked = await visit("Desk");
      const loose = await labOrder(desked.visit);
      const cleared = await clearAgain(loose);
      expect(cleared.alreadySettled === false, "reception's clear did nothing");
      const deskOrder = await orderRow(loose);
      expect(opensLabGate(deskOrder.payment_status), `desk order is ${deskOrder.payment_status}`);
      expect(Number(deskOrder.amount_paid) === 250, `desk amount_paid ${deskOrder.amount_paid}`);
    },
  );

  await check("9. no prices from the desk: a request carrying a price is refused", async () => {
    const { visit: visitId } = await visit("Price");
    for (const field of ["base_price", "price", "rate", "amount"]) {
      await refused(
        () =>
          requests.createNewItemRequest(
            { proposed_name: named("Splint"), reason: "Needed", [field]: 800 },
            desk,
            client,
          ),
        400,
        /can't carry a price/,
        `a new-item request with ${field}`,
      );
    }
    await refused(
      () =>
        requests.createRepeatRequest(
          { service_item_id: world.brace, visit_id: visitId, reason: "Again", price: 800 },
          desk,
          client,
        ),
      400,
      /can't carry a price/,
      "a repeat request with a price",
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM billing_requests WHERE proposed_name = $1`,
      [named("Splint")],
    );
    expect(rows[0].n === 0, "a priced request was stored");
  });

  await check("10. privacy: card and referral numbers are encrypted and masked", async () => {
    const { bill } = await draftWith("Private", [world.dressing]);
    const set = await bills.setCategory(
      bill.id,
      { category: world.referral, scheme_ref: CARD, referral_no: REFERRAL },
      desk,
      client,
    );
    expect(set.scheme_ref === "XXXX1234", `card shown as ${set.scheme_ref}`);
    expect(set.referral_no === "XXXX5566", `referral shown as ${set.referral_no}`);
    const stored = (
      await client.query(`SELECT scheme_ref_enc, referral_no_enc FROM bills WHERE id = $1`, [
        bill.id,
      ])
    ).rows[0];
    for (const [column, plain] of [
      ["scheme_ref_enc", CARD],
      ["referral_no_enc", REFERRAL],
    ]) {
      const value = String(stored[column] ?? "");
      expect(value && value !== plain, `${column} is not stored`);
      expect(!value.includes(plain.slice(-8)), `${column} holds the number in the clear`);
    }
    const read = await bills.readBill(bill.id, client);
    expect(read.scheme_ref === "XXXX1234", `readBill shows the card as ${read.scheme_ref}`);
    const leaked = await client.query(
      `SELECT count(*)::int AS n FROM billing_audit
        WHERE entity_id = $1 AND (coalesce(before::text, '') LIKE '%' || $2 || '%'
           OR coalesce(after::text, '') LIKE '%' || $2 || '%'
           OR coalesce(before::text, '') LIKE '%' || $3 || '%'
           OR coalesce(after::text, '') LIKE '%' || $3 || '%')`,
      [bill.id, CARD.slice(-8), REFERRAL.slice(-8)],
    );
    expect(leaked.rows[0].n === 0, "the audit log holds a number in the clear");
  });
}

async function concurrent() {
  const name = "1a. two concurrent finalises get gap-free numbers";
  let created = false;
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    const inserted = await pool.query(
      `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
       VALUES ('MAIN', $1, $2, 6, 1) ON CONFLICT (series, fy) DO NOTHING RETURNING prefix`,
      [FAR_FY, FAR_PREFIX],
    );
    created = inserted.rowCount === 1;
    const series = await pool.query(
      `SELECT prefix, next_no FROM bill_series WHERE series = 'MAIN' AND fy = $1`,
      [FAR_FY],
    );
    expect(
      series.rows[0].prefix === FAR_PREFIX,
      `a real MAIN series already exists for ${FAR_FY}; not touching it`,
    );
    const start = Number(series.rows[0].next_no);
    const zeroBill = async (db, label) => {
      const { item } = await catalogue(db, label);
      const free = await item("Z", "Free", 0);
      const v = await patientVisit(db, label, { date: FAR_DAY });
      const draft = await bills.openDraft(v.visit, null, db);
      const withLine = await bills.addLine(draft.id, { item_id: free }, null, db);
      return withLine;
    };
    await a.query("BEGIN");
    await b.query("BEGIN");
    const billA = await zeroBill(a, "CA");
    const billB = await zeroBill(b, "CB");
    const billB2 = await zeroBill(b, "CC");
    const first = await bills.finaliseBill(billA.id, { version: billA.version }, null, a);
    const waiting = bills.finaliseBill(billB.id, { version: billB.version }, null, b);
    const settled = waiting.then(() => "through").catch(() => "failed");
    const state = await Promise.race([settled, sleep(500).then(() => "waiting")]);
    expect(state === "waiting", `the second finalise did not wait for the first (${state})`);
    await a.query("ROLLBACK");
    const second = await waiting;
    const third = await bills.finaliseBill(billB2.id, { version: billB2.version }, null, b);
    const no = (bill) => Number(bill.bill_no.slice(FAR_PREFIX.length));
    expect(no(first) === start, `the first finalise took ${first.bill_no}, expected ${start}`);
    expect(no(second) === start, `after a rollback the next finalise took ${second.bill_no}`);
    expect(no(third) === start + 1, `the next number was ${third.bill_no}, not ${start + 1}`);
    await b.query("ROLLBACK");
    const after = await pool.query(
      `SELECT next_no FROM bill_series WHERE series = 'MAIN' AND fy = $1`,
      [FAR_FY],
    );
    expect(Number(after.rows[0].next_no) === start, "a rolled-back finalise burned a number");
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    a.release();
    b.release();
    await pool
      .query(`DELETE FROM bill_series WHERE series = 'MAIN' AND fy = $1 AND prefix = $2`, [
        FAR_FY,
        FAR_PREFIX,
      ])
      .catch((error) => notes.push(`The ${FAR_FY} series was not removed: ${error.message}`));
    if (created) notes.push(`A throwaway MAIN series for ${FAR_FY} was used and removed.`);
  }
}

const LEFT = `(SELECT count(*) FROM service_groups WHERE code LIKE '%' || $1)::int AS groups,
  (SELECT count(*) FROM service_items WHERE code LIKE '%' || $1)::int AS items,
  (SELECT count(*) FROM patients WHERE name LIKE '% ' || $2)::int AS patients,
  (SELECT count(*) FROM bills b JOIN patients p ON p.id = b.patient_id
     WHERE p.name LIKE '% ' || $2)::int AS bills,
  (SELECT count(*) FROM patient_schemes WHERE code LIKE '%' || $2)::int AS categories,
  (SELECT count(*) FROM discount_rules WHERE name LIKE '% ' || $2)::int AS discounts,
  (SELECT count(*) FROM doctors WHERE name LIKE '% ' || $2)::int AS doctors,
  (SELECT count(*) FROM giniflow_test_catalog WHERE test_name LIKE '% ' || $2)::int AS tests,
  (SELECT count(*) FROM billing_requests WHERE proposed_name LIKE '% ' || $2)::int AS requests,
  (SELECT count(*) FROM bill_series WHERE prefix LIKE '%' || $1 || '/'
     OR (fy = $3 AND prefix = $4))::int AS series`;

const GLOBAL = `SELECT (SELECT row_to_json(s)::text FROM billing_settings s) AS settings`;

const before = (await pool.query(GLOBAL)).rows[0];
client = await pool.connect();
let failed = false;
try {
  await client.query("BEGIN");
  await seed();
  await run();
} catch (error) {
  results.push({ name: "setup", ok: false, error: error.message });
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  client = null;
}

await concurrent();

try {
  const left = Object.entries(
    (await pool.query(`SELECT ${LEFT}`, [T, tag, FAR_FY, FAR_PREFIX])).rows[0],
  ).filter(([, n]) => n > 0);
  const after = (await pool.query(GLOBAL)).rows[0];
  const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
  const problems = [
    ...left.map(([table, n]) => `${n} in ${table}`),
    ...changed.map((key) => `${key} changed`),
  ];
  results.push(
    problems.length
      ? { name: "11. everything was rolled back", ok: false, error: problems.join(", ") }
      : { name: "11. everything was rolled back", ok: true },
  );
} catch (error) {
  results.push({ name: "11. everything was rolled back", ok: false, error: error.message });
}

for (const note of notes) console.log(`ℹ ${note}`);
if (notes.length) console.log("");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
  if (!r.ok) failed = true;
}
console.log(
  `\n${failed ? "FAILED" : "ALL OK"} (${results.filter((r) => r.ok).length}/${results.length})`,
);
await pool.end();
process.exit(failed ? 1 : 0);
