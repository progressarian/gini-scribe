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
console.log(
  `Billing claims and reports smoke — ${target.host}/${target.name} — everything is rolled back\n`,
);
if (!/test/i.test(target.name) && process.env.SMOKE_ANY_DATABASE !== "1") {
  console.log(
    `Refused: ${target.name || "this database"} is not a test database. Point DATABASE_URL at one, or set SMOKE_ANY_DATABASE=1 if you really mean to run it here.`,
  );
  process.exit(2);
}

const { default: pool } = await import("../config/db.js");
const { paise } = await import("../../shared/labPayment.js");
const { indiaToday } = await import("../services/billing/categoryResolver.js");
const { financialYear } = await import("../services/billing/billSeries.js");
const bills = await import("../services/billing/bills.js");
const payments = await import("../services/billing/payments.js");
const requests = await import("../services/billing/billingRequests.js");
const register = await import("../services/billing/cghsRegister.js");
const { runReport } = await import("../services/billing/reports.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const coded = (name) => `SMKR-${name}-${T}`;
const named = (name) => `Smoke ${name} ${tag}`;
const schemeCode = (name) => `smkr_${name}_${tag}`;
const FY = financialYear(indiaToday());
const shiftDay = (day, by) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + by * 86400000).toISOString().slice(0, 10);
const DAY = shiftDay("2014-01-01", parseInt(tag, 16) % 2000);
const NEXT = shiftDay(DAY, 1);
const PERIOD = { from: DAY, to: DAY };
const PAY_LATER_OFF_NOTE = "Pay later is off now — these balances were left while it was on";

const results = [];
const world = {};
let client = null;
let desk = null;
let admin = null;

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const same = (actual, expected, label) =>
  expect(actual === expected, `${label}: got ${actual}, expected ${expected}`);

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

async function insert(db, table, columns, returning = "id") {
  const keys = Object.keys(columns);
  const { rows } = await db.query(
    `INSERT INTO ${table} (${keys.join(", ")})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${returning}`,
    keys.map((key) => columns[key]),
  );
  return rows[0][returning];
}

const report = (key, filters = {}) => runReport(key, { ...PERIOD, ...filters }, client);

const sectionOf = (result, key) => {
  const found = result.sections.find((part) => part.key === key);
  expect(found, `the ${result.key} report has no ${key} section`);
  return found;
};

const one = async (text, params) => (await client.query(text, params)).rows[0];

async function scheme(key, label, extra = {}) {
  return insert(client, "patient_schemes", { code: schemeCode(key), label, ...extra }, "code");
}

async function seedWorld() {
  desk = {
    actorId: await insert(client, "doctors", { name: named("Desk"), role: "reception_admin" }),
    ip: "10.9.53.1",
    role: "reception_admin",
  };
  admin = {
    actorId: await insert(client, "doctors", { name: named("Admin"), role: "admin" }),
    ip: "10.9.53.2",
    role: "admin",
  };
  world.consultant = await insert(client, "doctors", {
    name: named("Consultant"),
    role: "consultant",
  });
  for (const [series, prefix] of [
    ["MAIN", `SR${T}/`],
    ["RCPT", `SP${T}/`],
    ["CN", `SC${T}/`],
  ]) {
    await client.query(
      `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
       VALUES ($1, $2, $3, 6, 1) ON CONFLICT (series, fy) DO NOTHING`,
      [series, FY, prefix],
    );
  }
  world.payer = named("CGHS payer");
  world.cghs = await scheme("cghs", named("CGHS"), { payer_name: world.payer });
  world.pensioner = await scheme("pens", named("Pensioner"), { parent_code: world.cghs });
  world.paid = await scheme("paid", named("Paid"), { parent_code: world.cghs });
  world.self = await scheme("self", named("Self"));
  world.later = await scheme("later", named("Later"), { allow_pay_later: true });
  await insert(client, "category_payment_rules", {
    scheme_code: world.pensioner,
    name: named("pensioner claims all"),
    patient_pays: "nothing",
    remainder: "claim",
  });
  await insert(client, "category_payment_rules", {
    scheme_code: world.paid,
    name: named("paid pays part"),
    patient_pays: "amount",
    patient_value: 100,
    remainder: "claim",
  });
  const group = await insert(client, "service_groups", {
    code: coded("G"),
    name: named("Group"),
  });
  const subgroup = await insert(client, "service_subgroups", {
    group_id: group,
    code: coded("S"),
    name: named("Subgroup"),
  });
  const item = (code, name, price) =>
    insert(client, "service_items", {
      code: coded(code),
      name: named(name),
      subgroup_id: subgroup,
      base_price: price,
      kind: "procedure",
    });
  world.consult = await item("CN", "Consult", 700);
  world.dressing = await item("DR", "Dressing", 500);
  world.brace = await item("BR", "Brace", 800);
  world.coupon = `SMKR${T}`;
  world.couponId = await insert(client, "discount_rules", {
    code: world.coupon,
    name: named("Coupon"),
    method: "code",
    kind: "percent",
    value: 10,
    applies_per: "line",
  });
}

async function visitFor(label) {
  const name = named(`Patient ${label}`);
  const fileNo = coded(`F${label}`);
  const patient = await insert(client, "patients", { name, file_no: fileNo, age: 61, sex: "Male" });
  const appointment = await insert(client, "appointments", {
    patient_id: patient,
    patient_name: name,
    file_no: fileNo,
    appointment_date: indiaToday(),
    visit_type: "New Patient",
  });
  const visit = await insert(client, "giniflow_visits", {
    patient_id: patient,
    visit_date: indiaToday(),
    appointment_id: appointment,
  });
  return { patient, visit };
}

const fresh = (id) => bills.readBill(id, client);

async function pay(billId, mode, amount) {
  const bill = await fresh(billId);
  return payments.takePayments(
    billId,
    { version: bill.version, mode, amount, reference: `${mode.toUpperCase()}${T}${amount}` },
    desk,
    client,
  );
}

async function finalise(billId, extra = {}) {
  const bill = await fresh(billId);
  return bills.finaliseBill(billId, { version: bill.version, ...extra }, desk, client);
}

async function draft(label, category, lines, { codes = [] } = {}) {
  const { patient, visit } = await visitFor(label);
  const opened = await bills.openDraft(visit, desk, client);
  for (const line of lines) {
    await bills.addLine(
      opened.id,
      { item_id: line.item, ...(line.doctor ? { doctor_id: line.doctor } : {}) },
      desk,
      client,
    );
  }
  await bills.setCategory(opened.id, { category }, desk, client);
  for (const code of codes) await bills.addCode(opened.id, { code }, desk, client);
  return { patient, visit, id: opened.id };
}

async function refund(billId, itemId) {
  const bill = await fresh(billId);
  const line = bill.lines.find((l) => l.service_item_id === itemId);
  const asked = await requests.createRefundRequest(
    { bill_id: billId, lines: [{ line_id: line.id }], reason: `Not needed ${tag}` },
    desk,
    client,
  );
  const approved = await requests.approveRequest(asked.id, {}, admin, client);
  return approved.credit_note;
}

async function seedBills() {
  const a = await draft("A", world.self, [{ item: world.dressing }, { item: world.brace }], {
    codes: [world.coupon],
  });
  await pay(a.id, "upi", (await fresh(a.id)).totals.payable / 100);
  await finalise(a.id);

  const b = await draft("B", world.self, [{ item: world.brace }]);
  await pay(b.id, "card", 800);
  await finalise(b.id);
  const note = await refund(b.id, world.brace);
  await payments.payOut(
    note.id,
    {
      version: note.version,
      payments: [{ mode: "card", amount: note.refund.due / 100, reference: `REV${T}` }],
    },
    desk,
    client,
  );

  const c = await draft("C", world.pensioner, [{ item: world.consult, doctor: world.consultant }]);
  await finalise(c.id);

  const d = await draft("D", world.paid, [{ item: world.consult, doctor: world.consultant }]);
  await pay(d.id, "upi", 100);
  await finalise(d.id);

  const e = await draft("E", world.pensioner, [{ item: world.dressing }, { item: world.brace }]);
  await finalise(e.id);

  const f = await draft("F", world.later, [{ item: world.dressing }]);
  await finalise(f.id, { pay_later: true });
  await bills.cancelBill(f.id, { reason: `Wrong patient ${tag}` }, desk, client);

  const g = await draft("G", world.self, [{ item: world.brace }]);
  await pay(g.id, "upi", 800);

  const h = await draft("H", world.later, [{ item: world.dressing }]);
  await finalise(h.id, { pay_later: true });
  await pay(h.id, "upi", 300);

  world.bills = { a, b, c, d, e, f, g, h };
  world.creditNote = note.id;
  world.patients = Object.values(world.bills).map((bill) => bill.patient);

  const at = (param, time) => `((${param}::date + time '${time}') AT TIME ZONE 'Asia/Kolkata')`;
  await client.query(`UPDATE bills SET bill_date = $1::date WHERE patient_id = ANY($2::int[])`, [
    DAY,
    world.patients,
  ]);
  await client.query(
    `UPDATE bills SET cancelled_at = ${at("$1", "12:30")}
      WHERE patient_id = ANY($2::int[]) AND status = 'cancelled'`,
    [DAY, world.patients],
  );
  await client.query(
    `UPDATE payments SET received_at = ${at("$1", "11:15")}
      WHERE bill_id IN (SELECT id FROM bills WHERE patient_id = ANY($2::int[]))`,
    [DAY, world.patients],
  );
  await client.query(`UPDATE payments SET received_at = ${at("$1", "10:00")} WHERE bill_id = $2`, [
    NEXT,
    h.id,
  ]);
  const shapes = await client.query(
    `SELECT b.id, b.status, b.bill_type FROM bills b WHERE b.patient_id = ANY($1::int[])`,
    [world.patients],
  );
  const statusOf = (id) => shapes.rows.find((row) => row.id === id)?.status;
  expect(statusOf(f.id) === "cancelled", `bill F is ${statusOf(f.id)}, not cancelled`);
  expect(statusOf(g.id) === "draft", `bill G is ${statusOf(g.id)}, not a draft`);
  expect(
    shapes.rows.filter((row) => row.bill_type === "credit_note").length === 1,
    "the seed does not hold exactly one credit note",
  );
}

const SIGNED = `CASE WHEN b.bill_type = 'credit_note' THEN -1 ELSE 1 END`;

async function rawLines(extra = "", params = []) {
  const row = await one(
    `SELECT COALESCE(SUM(l.actual_amount) FILTER (WHERE b.bill_type = 'invoice'), 0) AS invoiced,
            COALESCE(SUM(l.actual_amount) FILTER (WHERE b.bill_type = 'credit_note'), 0)
              AS credited,
            COALESCE(SUM(${SIGNED} * l.actual_amount), 0) AS actual,
            COALESCE(SUM(${SIGNED} * l.discount), 0) AS discount,
            COALESCE(SUM(${SIGNED} * (l.cgst + l.sgst)), 0) AS tax,
            COALESCE(SUM(${SIGNED} * l.patient_payable), 0) AS patient,
            COALESCE(SUM(${SIGNED} * l.claim_amount), 0) AS claim,
            COALESCE(SUM(${SIGNED} * l.adjustment_amount), 0) AS adjustment
       FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      WHERE b.status = 'final' AND b.bill_date BETWEEN $1::date AND $2::date ${extra}`,
    [DAY, DAY, ...params],
  );
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, paise(value)]));
}

const MINE = `AND b.patient_id = ANY($3::int[])`;

function sameMoney(total, raw, keys, label) {
  for (const key of keys) same(total[key], raw[key], `${label} ${key}`);
}

const LINE_KEYS = ["actual", "discount", "tax", "patient", "claim", "adjustment"];

async function run() {
  await check("1. revenue totals equal final bills' lines, credit notes subtracted", async () => {
    const raw = await rawLines();
    const items = sectionOf(await report("revenue_items"), "items").total;
    sameMoney(items, raw, ["invoiced", "credited", ...LINE_KEYS], "by service");
    const consultants = sectionOf(await report("revenue_consultants"), "consultants");
    sameMoney(consultants.total, raw, ["invoiced", "credited", ...LINE_KEYS], "by consultant");
    const categories = sectionOf(await report("revenue_categories"), "categories").total;
    sameMoney(categories, raw, ["actual", "discount", "tax", "claim", "adjustment"], "by category");
    same(categories.patient_lines, raw.patient, "by category patient share on lines");
    const mine = await rawLines(MINE, [world.patients]);
    same(mine.invoiced, 530000, "my invoiced");
    same(mine.credited, 80000, "my credited");
    same(mine.actual, 450000, "my net actual");
    const self = sectionOf(await report("revenue_items", { category: world.self }), "items").total;
    same(self.invoiced, 210000, "Self billed");
    same(self.credited, 80000, "Self credited back");
    same(self.actual, 130000, "Self net");
    const mineRow = consultants.rows.find((row) => row.label === named("Consultant"));
    same(mineRow?.actual, 140000, "my consultant's net");
  });

  await check("2. cancelled bills and drafts are excluded", async () => {
    const all = await one(
      `SELECT COALESCE(SUM(l.actual_amount), 0) AS actual FROM bills b
         JOIN bill_lines l ON l.bill_id = b.id
        WHERE b.bill_date = $1::date AND b.patient_id = ANY($2::int[]) AND b.bill_type = 'invoice'`,
      [DAY, world.patients],
    );
    same(paise(all.actual), 660000, "every invoice line of mine, whatever its status");
    const later = sectionOf(await report("revenue_items", { category: world.later }), "items");
    same(later.total.actual, 50000, "Later net (the cancelled bill left out)");
    same(later.total.lines, 1, "Later lines");
    const self = sectionOf(await report("revenue_items", { category: world.self }), "items");
    same(self.total.lines, 4, "Self lines (the draft left out)");
    const byCategory = sectionOf(
      await report("revenue_categories", { category: world.later }),
      "categories",
    );
    same(byCategory.total.bills, 1, "Later bills counted");
    const discounts = sectionOf(await report("discounts", { category: world.self }), "rules");
    same(discounts.total.bills, 1, "Self bills with a discount");
    const cancelled = sectionOf(await report("cancellations", { category: world.later }), "bills");
    expect(
      cancelled.rows.length === 1 && cancelled.rows[0].cancel_reason === `Wrong patient ${tag}`,
      `the cancellations report shows ${JSON.stringify(cancelled.rows)}`,
    );
  });

  await check("3. CGHS sub-category totals add up to the CGHS total", async () => {
    const categories = sectionOf(await report("revenue_categories"), "categories");
    const parent = categories.rows.find(
      (row) => row.level === "category" && row.code === world.cghs,
    );
    const subs = categories.rows.filter(
      (row) => row.level === "sub_category" && [world.pensioner, world.paid].includes(row.code),
    );
    expect(parent, "the CGHS category has no row");
    same(subs.length, 2, "CGHS sub-category rows");
    for (const key of ["bills", "actual", "discount", "tax", "patient", "collected", "claim"]) {
      same(
        subs.reduce((sum, row) => sum + row[key], 0),
        parent[key],
        `CGHS ${key}: sub-categories vs category`,
      );
    }
    same(parent.actual, 270000, "CGHS net actual");
    same(parent.claim, 260000, "CGHS to be claimed");
    same(parent.collected, 10000, "CGHS collected");
    const whole = sectionOf(await report("revenue_items", { category: world.cghs }), "items");
    let parts = 0;
    for (const sub of [world.pensioner, world.paid]) {
      parts += sectionOf(await report("revenue_items", { sub_category: sub }), "items").total
        .actual;
    }
    same(parts, whole.total.actual, "revenue by service: sub-categories vs CGHS");
    const receivables = sectionOf(
      await report("receivables", { category: world.cghs }),
      "sub_categories",
    );
    const top = receivables.rows.find((row) => row.level === "category");
    const below = receivables.rows.filter((row) => row.level === "sub_category");
    same(
      below.reduce((sum, row) => sum + row.amount, 0),
      top?.amount,
      "receivables: sub-categories vs CGHS",
    );
    same(top?.amount, 260000, "CGHS pending receivable");
  });

  await check(
    "4. collections net = in − out, and the category report's collected under its own rule",
    async () => {
      const collections = await report("collections");
      const raw = await one(
        `SELECT COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'in'), 0) AS received,
              COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'out'), 0) AS paid_back,
              COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END), 0)
                AS net,
              COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END)
                FILTER (WHERE b.patient_id = ANY($3::int[])), 0) AS mine
         FROM payments m JOIN bills b ON b.id = m.bill_id
        WHERE m.received_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND m.received_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`,
        [DAY, DAY, world.patients],
      );
      for (const key of ["modes", "users", "shifts", "days"]) {
        const part = sectionOf(collections, key);
        same(part.total.received, paise(raw.received), `collections ${key} received`);
        same(part.total.paid_back, paise(raw.paid_back), `collections ${key} paid back`);
        same(part.total.net, paise(raw.net), `collections ${key} net`);
        same(
          part.rows.reduce((sum, row) => sum + row.net, 0),
          part.total.net,
          `collections ${key} rows vs total`,
        );
      }
      same(
        paise(raw.mine),
        207000,
        "my net collected on the day (the draft's money in, the late part-payment out)",
      );
      const collected = await one(
        `SELECT COALESCE(SUM(${SIGNED} * m.amount), 0) AS collected,
              COALESCE(SUM(${SIGNED} * m.amount) FILTER (WHERE b.patient_id = ANY($3::int[])), 0)
                AS mine
         FROM bills b JOIN payments m ON m.bill_id = b.id
        WHERE b.status = 'final' AND b.bill_date BETWEEN $1::date AND $2::date`,
        [DAY, DAY, world.patients],
      );
      const categories = sectionOf(await report("revenue_categories"), "categories");
      same(categories.total.collected, paise(collected.collected), "category report collected");
      same(paise(collected.mine), 157000, "my collected by bill date");
      expect(
        categories.note &&
          /Collections report counts money on the day it was taken/.test(categories.note),
        "the category report does not explain its collected figure",
      );
    },
  );

  await check("5. discount totals equal bill_line_discounts on final invoices", async () => {
    const result = await report("discounts");
    const raw = await one(
      `SELECT COALESCE(SUM(d.amount), 0) AS amount,
              COALESCE(SUM(d.amount) FILTER (WHERE d.rule_id = $3), 0) AS coupon
         FROM bill_line_discounts d
         JOIN bill_lines l ON l.id = d.bill_line_id
         JOIN bills b ON b.id = l.bill_id
        WHERE b.status = 'final' AND b.bill_type = 'invoice'
          AND b.bill_date BETWEEN $1::date AND $2::date`,
      [DAY, DAY, world.couponId],
    );
    for (const key of ["rules", "methods", "categories", "consultants", "users"]) {
      same(sectionOf(result, key).total.amount, paise(raw.amount), `discounts ${key} total`);
    }
    same(sectionOf(result, "groups").total.amount, paise(raw.amount), "discounts by group");
    const coupon = sectionOf(result, "rules").rows.find((row) => row.code === world.coupon);
    same(coupon?.amount, paise(raw.coupon), "the coupon's row");
    same(paise(raw.coupon), 13000, "10% off ₹500 and ₹800");
  });

  await check(
    "6. a settlement equals its bills' claims; one live settlement per bill",
    async () => {
      const { c, d, e } = world.bills;
      const clear = (ids, amount, reference = `UTR${T}${amount}`) =>
        register.clearBills({ bill_ids: ids, received_on: DAY, reference, amount }, desk, client);
      const before = await register.listPending({ payer: world.payer }, client);
      same(before.totals.count, 3, "pending bills");
      same(before.totals.amount, 260000, "pending total");
      await refused(
        () => clear([c.id, d.id], 1250),
        409,
        /difference ₹50\.00 less/,
        "₹1,250 for ₹1,300",
      );
      const none = await one(
        `SELECT count(*)::int AS n FROM claim_settlements WHERE payer_name = $1`,
        [world.payer],
      );
      same(none.n, 0, "settlements written by a refused clear");
      const first = await clear([c.id, d.id], 1300);
      same(first.amount, 130000, "settlement amount");
      same(
        first.bills.reduce((sum, bill) => sum + bill.amount, 0),
        first.amount,
        "settlement vs its bills",
      );
      const links = await one(
        `SELECT COALESCE(SUM(amount), 0) AS amount FROM claim_settlement_bills
        WHERE settlement_id = $1 AND voided_at IS NULL`,
        [first.id],
      );
      same(paise(links.amount), 130000, "the settlement's links");
      await refused(
        () => clear([c.id], 700, `UTR${T}again`),
        409,
        /already cleared/,
        "clearing C twice",
      );
      const second = await clear([e.id], 1300);
      await client.query("SAVEPOINT smoke_twice");
      let blocked = null;
      try {
        await client.query(
          `INSERT INTO claim_settlement_bills (settlement_id, bill_id, amount) VALUES ($1, $2, 700)`,
          [second.id, c.id],
        );
      } catch (error) {
        blocked = error.code;
      }
      await client.query("ROLLBACK TO SAVEPOINT smoke_twice");
      same(blocked, "23505", "a second live settlement for C");
      await refused(
        () => register.undoClear(first.id, {}, admin, client),
        400,
        /Say why/,
        "undo with no reason",
      );
      await register.undoClear(first.id, { reason: `Wrong UTR ${tag}` }, admin, client);
      const back = await client.query(
        `SELECT id, claim_status, claim_settlement_id FROM bills WHERE id = ANY($1::uuid[])`,
        [[c.id, d.id]],
      );
      expect(
        back.rows.every((row) => row.claim_status === "pending" && !row.claim_settlement_id),
        `after undo the bills are ${JSON.stringify(back.rows)}`,
      );
      const pending = await register.listPending({ payer: world.payer }, client);
      same(pending.totals.amount, 130000, "pending after undo (E still cleared)");
      await clear([c.id, d.id], 1300, `UTR${T}redo`);
      const doubled = await one(
        `SELECT count(*)::int AS n FROM (
         SELECT bill_id FROM claim_settlement_bills sb
           JOIN claim_settlements s ON s.id = sb.settlement_id
          WHERE sb.voided_at IS NULL AND s.voided_at IS NULL AND sb.bill_id = ANY($1::uuid[])
          GROUP BY bill_id HAVING count(*) > 1) x`,
        [[c.id, d.id, e.id]],
      );
      same(doubled.n, 0, "bills in more than one live settlement");
      const cleared = sectionOf(await report("receivables", { category: world.cghs }), "cleared");
      same(cleared.total.amount, 260000, "cleared per month (the voided payment left out)");
    },
  );

  await check("7. pending claims drop by what credit notes took off", async () => {
    const { e } = world.bills;
    const pendingBefore = await register.listPending({ payer: world.payer }, client);
    const receivablesBefore = sectionOf(
      await report("receivables", { category: world.cghs }),
      "sub_categories",
    ).total.amount;
    same(pendingBefore.totals.amount, 260000, "pending before the credit");
    same(receivablesBefore, 260000, "receivable before the credit");
    await refund(e.id, world.brace);
    const pendingAfter = await register.listPending({ payer: world.payer }, client);
    same(pendingAfter.totals.amount, 180000, "pending after an ₹800 credit");
    const row = pendingAfter.rows.find((r) => r.bill_id === e.id);
    same(row?.claim, 50000, "E's net claim");
    same(row?.credited, 80000, "E's credited claim");
    const receivablesAfter = sectionOf(
      await report("receivables", { category: world.cghs }),
      "sub_categories",
    ).total.amount;
    same(receivablesAfter, 180000, "receivable after the credit");
    const clear = (amount) =>
      register.clearBills(
        { bill_ids: [e.id], received_on: DAY, reference: `UTR${T}E${amount}`, amount },
        desk,
        client,
      );
    await refused(() => clear(1300), 409, /difference ₹800\.00 more/, "the gross claim for E");
    const settled = await clear(500);
    same(settled.amount, 50000, "E settled at its net claim");
  });

  await check("8. dues keep a pay-later balance after pay-later is switched off", async () => {
    const { h } = world.bills;
    const on = sectionOf(await report("dues", { category: world.later }), "dues");
    same(on.rows.length, 1, "dues rows while pay later is on");
    same(on.rows[0].outstanding, 20000, "H outstanding");
    expect(!on.note, `a note while pay later is on: ${on.note}`);
    await client.query(`UPDATE billing_settings SET allow_pay_later = FALSE`);
    await client.query(`UPDATE patient_schemes SET allow_pay_later = FALSE WHERE allow_pay_later`);
    const off = sectionOf(await report("dues", { category: world.later }), "dues");
    same(off.rows.length, 1, "dues rows with pay later off");
    same(off.rows[0].bill_no, (await fresh(h.id)).bill_no, "the listed bill");
    same(off.rows[0].outstanding, 20000, "H outstanding with pay later off");
    same(off.total.outstanding, 20000, "dues total with pay later off");
    same(off.note, PAY_LATER_OFF_NOTE, "the pay-later-off note");
    const listed = await payments.listDues({ patientId: h.patient }, client);
    same(listed.find((due) => due.bill_id === h.id)?.outstanding, 20000, "the counter's dues list");
  });
}

const LEFT = `(SELECT count(*) FROM service_groups WHERE code LIKE '%' || $1)::int AS groups,
  (SELECT count(*) FROM service_items WHERE code LIKE '%' || $1)::int AS items,
  (SELECT count(*) FROM patients WHERE name LIKE '% ' || $2)::int AS patients,
  (SELECT count(*) FROM bills b JOIN patients p ON p.id = b.patient_id
     WHERE p.name LIKE '% ' || $2)::int AS bills,
  (SELECT count(*) FROM patient_schemes WHERE code LIKE '%' || $2)::int AS categories,
  (SELECT count(*) FROM discount_rules WHERE name LIKE '% ' || $2)::int AS discounts,
  (SELECT count(*) FROM doctors WHERE name LIKE '% ' || $2)::int AS doctors,
  (SELECT count(*) FROM claim_settlements WHERE reference LIKE 'UTR' || $1 || '%')::int
    AS settlements,
  (SELECT count(*) FROM billing_requests WHERE reason LIKE '% ' || $2)::int AS requests,
  (SELECT count(*) FROM bill_series WHERE prefix LIKE '%' || $1 || '/')::int AS series`;

const GLOBAL = `SELECT (SELECT row_to_json(s)::text FROM billing_settings s) AS settings,
  (SELECT count(*) FROM patient_schemes WHERE allow_pay_later)::int AS pay_later_schemes`;

const before = (await pool.query(GLOBAL)).rows[0];
client = await pool.connect();
let failed = false;
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await seedWorld();
  await seedBills();
  await run();
} catch (error) {
  results.push({ name: "setup", ok: false, error: error.message });
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  client = null;
}

try {
  const left = Object.entries((await pool.query(`SELECT ${LEFT}`, [T, tag])).rows[0]).filter(
    ([, n]) => n > 0,
  );
  const after = (await pool.query(GLOBAL)).rows[0];
  const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
  const problems = [
    ...left.map(([table, n]) => `${n} in ${table}`),
    ...changed.map((key) => `${key} changed`),
  ];
  results.push(
    problems.length
      ? { name: "9. everything was rolled back", ok: false, error: problems.join(", ") }
      : { name: "9. everything was rolled back", ok: true },
  );
} catch (error) {
  results.push({ name: "9. everything was rolled back", ok: false, error: error.message });
}

for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
  if (!r.ok) failed = true;
}
console.log(
  `\n${failed ? "FAILED" : "ALL OK"} (${results.filter((r) => r.ok).length}/${results.length})`,
);
await pool.end();
process.exit(failed ? 1 : 0);
