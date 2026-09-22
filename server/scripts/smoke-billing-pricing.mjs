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
console.log(`Billing pricing smoke — ${target.host}/${target.name} — everything is rolled back\n`);
if (!/test/i.test(target.name) && process.env.SMOKE_ANY_DATABASE !== "1") {
  console.log(
    `Refused: ${target.name || "this database"} is not a test database. Point DATABASE_URL at one, or set SMOKE_ANY_DATABASE=1 if you really mean to run it here.`,
  );
  process.exit(2);
}

const { default: pool } = await import("../config/db.js");
const { indiaToday } = await import("../services/billing/categoryResolver.js");
const { gstinCheckCharacter, updateSettings } =
  await import("../services/billing/billingSettings.js");
const { createScheme } = await import("../services/patientSchemes.js");
const { createGroup, createSubgroup } = await import("../services/billing/serviceGroups.js");
const { createItem, updateItem } = await import("../services/billing/serviceItems.js");
const { createTaxCode } = await import("../services/billing/taxCodes.js");
const { saveRate } = await import("../services/billing/categoryRates.js");
const { createPaymentRule } = await import("../services/billing/paymentRules.js");
const { CODE_REFUSALS, checkCode, createDiscountRule, setDiscountRuleActive, usageToday } =
  await import("../services/billing/discountRules.js");
const { priceLine } = await import("../services/billing/priceLine.js");
const { priceBill } = await import("../services/billing/priceBill.js");
const { assertLineBalances } = await import("../services/billing/lineInvariant.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const up = (name) => `SMOKE_${name}_${T}`;
const cat = (name) => `smoke_${name}_${tag}`;
const named = (name) => `Smoke ${name} ${tag}`;
const DAY = indiaToday();
const shift = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const NEXT_DAY = shift(DAY, 1);
const PATIENT = { id: 2100000001, age: 40, gender: "Male" };
const ROLE = "reception";
const rupees = (n) => Math.round(n * 100);

const results = [];
const notes = [];
const priced = [];
const ids = {};
let client = null;
let ctx = null;

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const show = (value) => JSON.stringify(value);

function same(actual, expected, label) {
  const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, actual?.[key]]));
  expect(
    show(picked) === show(expected),
    `${label}: expected ${show(expected)}, got ${show(picked)}`,
  );
}

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

async function price(item, extra = {}) {
  const line = await priceLine(
    { item: ids[item], date: DAY, role: ROLE, patient: PATIENT, ...extra },
    client,
  );
  priced.push(line);
  return line;
}

const money = (line) => ({
  actual: line.actual,
  discount: line.discount,
  tax: line.tax,
  patient: line.patient_payable,
  claim: line.claim,
  adjustment: line.adjustment,
});

const expectMoney = (line, expected, label) =>
  same(
    money(line),
    {
      discount: 0,
      tax: 0,
      adjustment: 0,
      ...Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, rupees(v)])),
    },
    label,
  );

const lineOf = (item, extra = {}) => ({
  item_id: ids[item],
  subgroup_id: ids[`${item}Subgroup`],
  group_id: ids[`${item}Group`],
  doctor_id: null,
  visit_type: null,
  ...extra,
});

const context = (extra = {}) => ({
  category: null,
  patient: PATIENT,
  date: DAY,
  role: ROLE,
  codesOnBill: 0,
  ...extra,
});

const addDiscount = (name, extra) =>
  createDiscountRule(
    {
      name: named(name),
      method: "code",
      code: `${name}${T}`,
      kind: "percent",
      value: 10,
      ...extra,
    },
    ctx,
    client,
  );

const addPaymentRule = (scheme, name, extra) =>
  createPaymentRule(
    { scheme_code: cat(scheme), name: named(name), valid_from: DAY, ...extra },
    ctx,
    client,
  );

async function use(
  ruleId,
  { date = DAY, doctor = null, patient = PATIENT.id, status = "final" } = {},
) {
  const bill = await client.query(
    `INSERT INTO bills (patient_id, bill_date, status) VALUES ($1, $2, $3) RETURNING id`,
    [patient, date, status],
  );
  const line = await client.query(
    `INSERT INTO bill_lines (bill_id, doctor_id) VALUES ($1, $2) RETURNING id`,
    [bill.rows[0].id, doctor],
  );
  await client.query(`INSERT INTO bill_line_discounts (bill_line_id, rule_id) VALUES ($1, $2)`, [
    line.rows[0].id,
    ruleId,
  ]);
  return bill.rows[0].id;
}

async function usageTables() {
  const { rows } = await client.query(
    `SELECT to_regclass('public.bills') IS NOT NULL AS bills,
            to_regclass('public.bill_line_discounts') IS NOT NULL AS discounts`,
  );
  const temp = rows[0].bills || rows[0].discounts;
  if (temp)
    notes.push(
      "The real bill tables exist; usage is counted on temporary tables that shadow them.",
    );
  const kind = temp ? "TEMP TABLE" : "TABLE";
  await client.query(`
    CREATE ${kind} bills (id SERIAL PRIMARY KEY, patient_id INT, bill_date DATE, status TEXT);
    CREATE ${kind} bill_lines (id SERIAL PRIMARY KEY, bill_id INT, doctor_id INT,
                               is_live BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE ${kind} bill_line_discounts (id SERIAL PRIMARY KEY, bill_line_id INT, rule_id INT);`);
}

async function isolate() {
  const { rowCount } = await client.query(
    `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND is_active`,
  );
  if (rowCount) notes.push(`${rowCount} automatic discount(s) switched off for this run only.`);
  await client.query(
    `UPDATE billing_settings SET discount_stacking = 'best_only', gst_enabled = FALSE,
            max_codes_per_bill = NULL`,
  );
}

async function setup() {
  await isolate();
  await usageTables();
  const doctor = async (name, role = "consultant") =>
    (
      await client.query(
        `INSERT INTO doctors (name, role, is_active) VALUES ($1, $2, TRUE) RETURNING id`,
        [named(name), role],
      )
    ).rows[0].id;
  ctx = { actorId: await doctor("Admin", "admin"), ip: null };
  ids.rahul = await doctor("Dr Rahul");
  ids.beant = await doctor("Dr Beant");
  ids.banshali = await doctor("Dr Banshali");

  const scheme = (input) => createScheme(input, client, ctx);
  await scheme({ code: cat("cghs"), label: named("CGHS"), payer_name: "CGHS" });
  await scheme({ code: cat("paid"), label: "CGHS Paid", parent_code: cat("cghs") });
  await scheme({
    code: cat("referral"),
    label: "CGHS Referral",
    parent_code: cat("cghs"),
    requires_referral: true,
  });
  await scheme({ code: cat("pensioner"), label: "Pensioner", parent_code: cat("cghs") });
  await scheme({ code: cat("ord"), label: named("Order"), payer_name: "Smoke payer" });
  await scheme({ code: cat("orda"), label: "Order A", parent_code: cat("ord") });
  await scheme({ code: cat("ordb"), label: "Order B", parent_code: cat("ord") });

  const group = async (key) =>
    (ids[key] = (await createGroup({ code: up(key), name: named(key) }, ctx, client)).id);
  const subgroup = async (key, groupKey) => {
    ids[`${key}Of`] = groupKey;
    ids[key] = (
      await createSubgroup(
        { group_id: ids[groupKey], code: up(key), name: named(key) },
        ctx,
        client,
      )
    ).id;
  };
  await group("OPD");
  await group("LAB");
  await subgroup("CONS", "OPD");
  await subgroup("PROC", "OPD");
  await subgroup("TESTS", "LAB");
  ids.gst18 = (
    await createTaxCode({ code: up("GST18"), sac_hsn: "999312", rate_pct: 18 }, ctx, client)
  ).id;

  const item = async (key, sub, basePrice, extra = {}) => {
    ids[`${key}Subgroup`] = ids[sub];
    ids[`${key}Group`] = ids[ids[`${sub}Of`]];
    ids[key] = (
      await createItem(
        {
          code: up(key),
          name: named(key),
          subgroup_id: ids[sub],
          base_price: basePrice,
          kind: "procedure",
          ...extra,
        },
        ctx,
        client,
      )
    ).id;
  };
  await item("newVisit", "CONS", 1500);
  await item("followUp", "CONS", 1000);
  await item("dressing", "PROC", 800);
  await item("taxed", "PROC", 1000, { tax_code_id: ids.gst18 });
  await item("hba1c", "TESTS", 250);
  for (const dr of ["rahul", "beant", "banshali"]) {
    await item(`${dr}Consult`, "CONS", 1500, {
      kind: "consultation",
      doctor_id: ids[dr],
      visit_type: "New",
    });
  }
  const fees = { rahul: 350, beant: 350, banshali: 700 };
  for (const scheme of ["pensioner", "referral"]) {
    for (const [dr, fee] of Object.entries(fees)) {
      await saveRate(
        { scheme_code: cat(scheme), service_item_id: ids[`${dr}Consult`], rate: fee },
        ctx,
        client,
      );
    }
  }
  await addPaymentRule("paid", "paid consults ₹700", {
    subgroup_id: ids.CONS,
    patient_pays: "amount",
    patient_value: 700,
    visit_types: ["New", "Follow Up"],
  });
  await addPaymentRule("referral", "referral pays nothing", {
    subgroup_id: ids.CONS,
    patient_pays: "nothing",
  });
  await addPaymentRule("pensioner", "pensioner pays nothing", {
    subgroup_id: ids.CONS,
    patient_pays: "nothing",
  });
}

const percentOf = (line) => Math.round((line.patient_payable * 100) / line.actual);

async function run() {
  await check("1a. CGHS Paid, New ₹1,500 → patient ₹700, claim ₹800", async () => {
    const line = await price("newVisit", { category: cat("paid"), visitType: "New" });
    expectMoney(line, { actual: 1500, patient: 700, claim: 800 }, "CGHS Paid New");
    expect(line.payment_rule_text === "amount ₹700", `rule text ${line.payment_rule_text}`);
    expect(line.remainder === "claim", `remainder ${line.remainder}`);
  });

  await check("1b. CGHS Paid, Follow Up ₹1,000 → patient ₹700, claim ₹300", async () => {
    const line = await price("followUp", { category: cat("paid"), visitType: "Follow Up" });
    expectMoney(line, { actual: 1000, patient: 700, claim: 300 }, "CGHS Paid Follow Up");
  });

  await check("1c. CGHS Referral → ₹0 every visit, the full amount claimed", async () => {
    const visits = [
      ["newVisit", "New", DAY, 1500],
      ["followUp", "Follow Up", DAY, 1000],
      ["followUp", "Follow Up", shift(DAY, 30), 1000],
      ["followUp", "Follow Up", shift(DAY, 400), 1000],
    ];
    for (const [item, visitType, date, fee] of visits) {
      const line = await price(item, { category: cat("referral"), visitType, date });
      expectMoney(line, { actual: fee, patient: 0, claim: fee }, `Referral ${visitType} ${date}`);
    }
  });

  await check("1d. CGHS Pensioner → ₹0, the full amount claimed", async () => {
    for (const [item, visitType, fee] of [
      ["newVisit", "New", 1500],
      ["followUp", "Follow Up", 1000],
    ]) {
      const line = await price(item, { category: cat("pensioner"), visitType });
      expectMoney(line, { actual: fee, patient: 0, claim: fee }, `Pensioner ${visitType}`);
    }
  });

  await check(
    "1e. Pensioner and CGHS Referral per-doctor fees: Dr Rahul / Dr Beant ₹350, Dr Banshali ₹700",
    async () => {
      for (const scheme of ["pensioner", "referral"]) {
        for (const [dr, fee] of [
          ["rahul", 350],
          ["beant", 350],
          ["banshali", 700],
        ]) {
          const line = await price(`${dr}Consult`, { category: cat(scheme) });
          expectMoney(line, { actual: fee, patient: 0, claim: fee }, `${scheme} ${dr}`);
          expect(line.rate_source === "own", `${scheme} ${dr}: rate from ${line.rate_source}`);
          expect(line.doctor_id === ids[dr], `${scheme} ${dr}: doctor ${line.doctor_id}`);
        }
      }
      const general = await price("rahulConsult");
      expectMoney(general, { actual: 1500, patient: 1500, claim: 0 }, "General Dr Rahul");
    },
  );

  await check("2a. rule order: item beats subgroup beats group beats category", async () => {
    const pct = (name, value, scope) =>
      addPaymentRule("ord", name, { patient_pays: "percent", patient_value: value, ...scope });
    await pct("whole category 90%", 90, {});
    await pct("OPD group 80%", 80, { group_id: ids.OPD });
    await pct("procedures 70%", 70, { subgroup_id: ids.PROC });
    await pct("dressing 60%", 60, { service_item_id: ids.dressing });
    const cases = [
      ["dressing", 60, "item"],
      ["taxed", 70, "subgroup"],
      ["followUp", 80, "group"],
      ["hba1c", 90, "category"],
    ];
    for (const [item, expected, scope] of cases) {
      const line = await price(item, { category: cat("orda"), visitType: "Follow Up" });
      expect(
        percentOf(line) === expected && line.payment_rule_scope === scope,
        `${item}: expected ${expected}% from the ${scope} rule, got ${percentOf(line)}% from ${line.payment_rule_scope}`,
      );
      expect(line.payment_rule_from_parent === true, `${item}: rule not from the parent`);
    }
  });

  await check("2b. a sub-category's rule beats its parent's (Pensioner over CGHS)", async () => {
    await addPaymentRule("ord", "dressing 60%", {
      service_item_id: ids.dressing,
      patient_pays: "percent",
      patient_value: 60,
    });
    await addPaymentRule("ordb", "B everything 50%", {
      patient_pays: "percent",
      patient_value: 50,
    });
    const a = await price("dressing", { category: cat("orda") });
    const b = await price("dressing", { category: cat("ordb") });
    expect(percentOf(a) === 60, `Order A: expected 60%, got ${percentOf(a)}%`);
    expect(
      percentOf(b) === 50 && b.payment_rule_from_parent === false,
      `Order B: expected its own 50% rule, got ${percentOf(b)}%`,
    );
    await addPaymentRule("cghs", "CGHS follow-up pays half", {
      service_item_id: ids.followUp,
      patient_pays: "percent",
      patient_value: 50,
    });
    const pensioner = await price("followUp", {
      category: cat("pensioner"),
      visitType: "Follow Up",
    });
    expectMoney(
      pensioner,
      { actual: 1000, patient: 0, claim: 1000 },
      "Pensioner under a CGHS rule",
    );
    const paid = await price("followUp", { category: cat("paid"), visitType: "Follow Up" });
    expectMoney(paid, { actual: 1000, patient: 700, claim: 300 }, "CGHS Paid under a CGHS rule");
  });

  await check("2c. visit type filter", async () => {
    await addPaymentRule("ord", "new visit 10%", {
      service_item_id: ids.newVisit,
      patient_pays: "percent",
      patient_value: 10,
      visit_types: ["New"],
    });
    await addPaymentRule("ord", "OPD group 80%", {
      group_id: ids.OPD,
      patient_pays: "percent",
      patient_value: 80,
    });
    const fresh = await price("newVisit", { category: cat("orda"), visitType: "New" });
    const later = await price("newVisit", { category: cat("orda"), visitType: "Follow Up" });
    expect(percentOf(fresh) === 10, `New: expected 10%, got ${percentOf(fresh)}%`);
    expect(percentOf(later) === 80, `Follow Up: expected 80%, got ${percentOf(later)}%`);
    const investigation = await price("newVisit", {
      category: cat("paid"),
      visitType: "Investigation",
    });
    expectMoney(
      investigation,
      { actual: 1500, patient: 1500, claim: 0 },
      "CGHS Paid Investigation (the ₹700 rule is New / Follow Up only)",
    );
  });

  await check("3a. an amount above an item's price is refused at save", async () => {
    const error = await refused(
      () =>
        addPaymentRule("paid", "dressing ₹900", {
          service_item_id: ids.dressing,
          patient_pays: "amount",
          patient_value: 900,
        }),
      409,
      new RegExp(`can't pay ₹900.*${named("dressing")}`),
      "a ₹900 rule on an ₹800 dressing",
    );
    expect(error.items?.length === 1, `items listed: ${show(error.items)}`);
    const saved = await client.query(
      `SELECT count(*)::int AS n FROM category_payment_rules WHERE name = $1`,
      [named("dressing ₹900")],
    );
    expect(saved.rows[0].n === 0, "the refused rule was saved");
  });

  await check("3b. lowering a price below a rule is refused", async () => {
    const rule = named("paid consults ₹700");
    await refused(
      () => updateItem(ids.followUp, { base_price: 600, reason: "smoke" }, ctx, client),
      409,
      new RegExp(rule),
      "base price ₹600 under the ₹700 rule",
    );
    await refused(
      () =>
        saveRate(
          { scheme_code: cat("paid"), service_item_id: ids.followUp, rate: 500 },
          ctx,
          client,
        ),
      409,
      new RegExp(rule),
      "CGHS Paid rate ₹500 under the ₹700 rule",
    );
    const line = await price("followUp", { category: cat("paid"), visitType: "Follow Up" });
    expectMoney(line, { actual: 1000, patient: 700, claim: 300 }, "the price after the refusals");
  });

  const ageRule = (extra = {}) =>
    createDiscountRule(
      {
        name: named("age 70+ OPD 10%"),
        method: "auto",
        kind: "percent",
        value: 10,
        group_ids: [ids.OPD],
        min_age: 70,
        stackable: true,
        ...extra,
      },
      ctx,
      client,
    );

  await check("4. automatic age rule (70+): age 69 / 70 / 71", async () => {
    await ageRule();
    for (const [age, off] of [
      [69, 0],
      [70, 100],
      [71, 100],
    ]) {
      const line = await price("followUp", {
        visitType: "Follow Up",
        patient: { ...PATIENT, age },
      });
      expectMoney(
        line,
        { actual: 1000, discount: off, patient: 1000 - off, claim: 0 },
        `age ${age}`,
      );
    }
  });

  await check("5a. stacking: best_only takes the largest, per_rule stacks", async () => {
    await ageRule();
    await addDiscount("CC50", { value: 50, group_ids: [ids.OPD] });
    const old = { ...PATIENT, age: 72 };
    const best = await price("followUp", {
      visitType: "Follow Up",
      patient: old,
      codes: [`cc50${tag}`],
    });
    expectMoney(best, { actual: 1000, discount: 500, patient: 500, claim: 0 }, "best_only");
    expect(best.discounts.length === 1, `best_only applied ${best.discounts.length} discounts`);
    await updateSettings({ discount_stacking: "per_rule" }, ctx, client);
    const stacked = await price("followUp", {
      visitType: "Follow Up",
      patient: old,
      codes: [`CC50${T}`],
    });
    expectMoney(stacked, { actual: 1000, discount: 550, patient: 450, claim: 0 }, "per_rule");
  });

  await check(
    "5b. caps: max_discount caps a percent; the discount never exceeds the price",
    async () => {
      await addDiscount("CAP", { value: 50, max_discount: 200 });
      await addDiscount("HUGE", { kind: "flat", value: 5000 });
      const capped = await price("followUp", { visitType: "Follow Up", codes: [`CAP${T}`] });
      expectMoney(
        capped,
        { actual: 1000, discount: 200, patient: 800, claim: 0 },
        "50% capped at ₹200",
      );
      const whole = await price("followUp", { visitType: "Follow Up", codes: [`HUGE${T}`] });
      expectMoney(
        whole,
        { actual: 1000, discount: 1000, patient: 0, claim: 0 },
        "₹5,000 flat on ₹1,000",
      );
    },
  );

  await check(
    "6. applies_on_scheme_rate: off changes nothing, on lowers only the patient's part",
    async () => {
      await addDiscount("OFF", { group_ids: [ids.OPD] });
      await addDiscount("ON", { group_ids: [ids.OPD], applies_on_scheme_rate: true });
      const plain = await price("newVisit", { category: cat("paid"), visitType: "New" });
      const off = await price("newVisit", {
        category: cat("paid"),
        visitType: "New",
        codes: [`OFF${T}`],
      });
      expect(show(money(off)) === show(money(plain)), `switch off changed ${show(money(off))}`);
      expect(
        off.refused_codes[0]?.reason === "payment_rule",
        `switch off: refusal ${show(off.refused_codes)}`,
      );
      const on = await price("newVisit", {
        category: cat("paid"),
        visitType: "New",
        codes: [`ON${T}`],
      });
      expectMoney(on, { actual: 1500, discount: 70, patient: 630, claim: 800 }, "switch on");
    },
  );

  const refusalCases = {
    unknown: async () => ({ code: `NOPE${T}` }),
    inactive: async () => {
      const rule = await addDiscount("INACT");
      await setDiscountRuleActive(rule.id, false, ctx, client);
      return { code: rule.code };
    },
    role: async () => ({ code: (await addDiscount("ROLE", { allowed_roles: ["admin"] })).code }),
    not_yet_valid: async () => ({
      code: (await addDiscount("SOON", { valid_from: NEXT_DAY })).code,
    }),
    expired: async () => ({
      code: (await addDiscount("OLD", { valid_from: shift(DAY, -10), valid_to: shift(DAY, -1) }))
        .code,
    }),
    too_many_codes: async () => {
      await updateSettings({ max_codes_per_bill: 1 }, ctx, client);
      return { code: (await addDiscount("MANY")).code, context: { codesOnBill: 1 } };
    },
    category: async () => ({
      code: (await addDiscount("CATG", { scheme_codes: [cat("paid")] })).code,
    }),
    patient: async () => ({ code: (await addDiscount("AGED", { min_age: 70 })).code }),
    items: async () => ({ code: (await addDiscount("LABONLY", { group_ids: [ids.LAB] })).code }),
    doctor: async () => ({
      code: (await addDiscount("DOCR", { doctor_ids: [ids.rahul] })).code,
      line: { doctor_id: ids.beant },
    }),
    visit_type: async () => ({
      code: (await addDiscount("NEWONLY", { visit_types: ["New"] })).code,
      line: { visit_type: "Follow Up" },
    }),
    total_limit: async () => {
      const rule = await addDiscount("TOTAL", { max_uses_total: 1 });
      await use(rule.id, { date: shift(DAY, -5), patient: 2100000002 });
      return { code: rule.code };
    },
    patient_limit: async () => {
      const rule = await addDiscount("PERPAT", { max_uses_per_patient: 1 });
      await use(rule.id, { date: shift(DAY, -5) });
      return { code: rule.code };
    },
    daily_limit: async () => {
      const rule = await addDiscount("DAILY", { max_uses_per_day: 1 });
      await use(rule.id, { patient: 2100000002 });
      return { code: rule.code };
    },
    doctor_daily_limit: async () => {
      const rule = await addDiscount("DOCDAY", { max_uses_per_doctor_per_day: 1 });
      await use(rule.id, { doctor: ids.rahul, patient: 2100000002 });
      return { code: rule.code, line: { doctor_id: ids.rahul } };
    },
  };

  await check("7. every code refusal reason from P3-08 is covered below", async () => {
    const missing = CODE_REFUSALS.filter((reason) => !refusalCases[reason]);
    const extra = Object.keys(refusalCases).filter((reason) => !CODE_REFUSALS.includes(reason));
    expect(
      !missing.length && !extra.length,
      `not covered: ${missing.join(", ") || "none"}; unknown: ${extra.join(", ") || "none"}`,
    );
  });

  for (const [reason, arrange] of Object.entries(refusalCases)) {
    await check(`7. code refused: ${reason}`, async () => {
      const setupCase = await arrange();
      const result = await checkCode(
        setupCase.code,
        lineOf("followUp", { visit_type: "Follow Up", ...setupCase.line }),
        context(setupCase.context),
        client,
      );
      expect(
        !result.ok && result.reason === reason,
        `expected ${reason}, got ${show(result.ok ? { ok: true } : result)}`,
      );
      expect(result.message, "the refusal has no message");
    });
  }

  await check("7b. a doctor coupon is refused for another doctor", async () => {
    await addDiscount("DRCOUPON", { value: 20, doctor_ids: [ids.rahul] });
    const rahul = await price("rahulConsult", { codes: [`DRCOUPON${T}`] });
    expectMoney(rahul, { actual: 1500, discount: 300, patient: 1200, claim: 0 }, "Dr Rahul");
    const beant = await price("beantConsult", { codes: [`DRCOUPON${T}`] });
    expectMoney(beant, { actual: 1500, patient: 1500, claim: 0 }, "Dr Beant");
    expect(
      beant.refused_codes[0]?.reason === "doctor" &&
        beant.refused_codes[0].message.includes(named("Dr Rahul")),
      `Dr Beant: ${show(beant.refused_codes)}`,
    );
  });

  const codeOn = (rule, item, extra = {}) =>
    checkCode(
      rule.code,
      lineOf(item, { visit_type: "New", ...extra.line }),
      context(extra),
      client,
    );

  await check(
    "7c. max_uses_per_day = 2: accepted twice, refused the third time, fine the next day",
    async () => {
      const rule = await addDiscount("TWOADAY", { max_uses_per_day: 2 });
      for (const n of [1, 2]) {
        const result = await codeOn(rule, "newVisit");
        expect(result.ok, `use ${n} refused: ${result.message}`);
        await use(rule.id, { patient: 2100000000 + n });
      }
      const third = await codeOn(rule, "newVisit");
      expect(
        !third.ok && third.reason === "daily_limit" && /2 of 2 used today/.test(third.message),
        `third use: ${show(third)}`,
      );
      const priced3 = await price("newVisit", { visitType: "New", codes: [rule.code] });
      expect(priced3.refused_codes[0]?.reason === "daily_limit", "the priced line took the code");
      const tomorrow = await codeOn(rule, "newVisit", { date: NEXT_DAY });
      expect(tomorrow.ok, `next day refused: ${tomorrow.message}`);
      const today = await usageToday(rule.id, client);
      expect(today.count === 2, `usageToday says ${today.count}`);
    },
  );

  await check("7d. max_uses_per_doctor_per_day is counted per doctor", async () => {
    const rule = await addDiscount("PERDOC", { max_uses_per_doctor_per_day: 1 });
    await use(rule.id, { doctor: ids.rahul });
    const rahul = await codeOn(rule, "rahulConsult", { line: { doctor_id: ids.rahul } });
    expect(
      !rahul.ok &&
        rahul.reason === "doctor_daily_limit" &&
        rahul.message.includes(named("Dr Rahul")),
      `Dr Rahul: ${show(rahul)}`,
    );
    const beant = await codeOn(rule, "beantConsult", { line: { doctor_id: ids.beant } });
    expect(beant.ok, `Dr Beant refused: ${beant.message}`);
    const today = await usageToday(rule.id, client);
    expect(
      today.by_doctor.length === 1 && today.by_doctor[0].doctor_id === ids.rahul,
      `usageToday by doctor: ${show(today.by_doctor)}`,
    );
  });

  await check("7e. a cancelled bill gives its use back", async () => {
    const rule = await addDiscount("ONCE", { max_uses_per_day: 1, max_uses_total: 1 });
    const bill = await use(rule.id);
    const before = await codeOn(rule, "newVisit");
    expect(!before.ok, "the code was accepted past its limit");
    await use(rule.id, { status: "draft", patient: 2100000009 });
    await client.query(`UPDATE bills SET status = 'cancelled' WHERE id = $1`, [bill]);
    const after = await codeOn(rule, "newVisit");
    expect(after.ok, `still refused after the cancel: ${after.message}`);
  });

  await check("9. GST: off gives zero tax; on splits CGST / SGST", async () => {
    const off = await price("taxed");
    expectMoney(off, { actual: 1000, patient: 1000, claim: 0 }, "GST off");
    expect(off.tax_code === null && off.cgst === 0 && off.sgst === 0, `GST off: ${show(off)}`);
    const gstin = `03ABCDE1234F1Z${gstinCheckCharacter("03ABCDE1234F1Z")}`;
    await updateSettings({ gst_enabled: true, gstin, legal_name: "Smoke Hospital" }, ctx, client);
    const on = await price("taxed");
    expectMoney(on, { actual: 1000, tax: 180, patient: 1180, claim: 0 }, "GST on");
    same(
      on,
      { tax_code: up("GST18"), tax_rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 },
      "GST on",
    );
    const paid = await price("newVisit", { category: cat("paid"), visitType: "New" });
    expectMoney(paid, { actual: 1500, patient: 700, claim: 800 }, "untaxed line with GST on");
  });

  await check("8. the invariant holds on every priced line and on a whole bill", async () => {
    const bill = await priceBill(
      {
        lines: [{ item: ids.newVisit }, { item: ids.dressing }, { item: ids.hba1c }],
        category: cat("paid"),
        patient: { age: 40, gender: "Male" },
        date: DAY,
        visitType: "New",
        role: ROLE,
      },
      client,
    );
    same(
      bill.totals,
      { patient_payable: rupees(1750), claim: rupees(800), round_off: 0, payable: rupees(1750) },
      "bill totals",
    );
    const lines = [...priced, ...bill.lines];
    const broken = lines.filter(
      (l) => l.actual - l.discount + l.tax !== l.patient_payable + l.claim + l.adjustment,
    );
    expect(
      !broken.length,
      `${broken.length} line(s) don't balance: ${broken.map((l) => l.item_code).join(", ")}`,
    );
    for (const line of priced) assertLineBalances(line);
    let caught = false;
    try {
      assertLineBalances({ ...priced[0], patient_payable: priced[0].patient_payable + 1 });
    } catch {
      caught = true;
    }
    expect(caught, "a line one paisa off was not caught");
    expect(priced.length >= 30, `only ${priced.length} lines were priced`);
    notes.push(`${lines.length} priced lines checked against the invariant.`);
  });
}

const LEFT = `(SELECT count(*) FROM service_groups WHERE code LIKE '%' || $1)::int AS groups,
  (SELECT count(*) FROM service_items WHERE code LIKE '%' || $1)::int AS items,
  (SELECT count(*) FROM tax_codes WHERE code LIKE '%' || $1)::int AS tax_codes,
  (SELECT count(*) FROM patient_schemes WHERE code LIKE '%' || $2)::int AS categories,
  (SELECT count(*) FROM category_item_rates WHERE scheme_code LIKE '%' || $2)::int AS rates,
  (SELECT count(*) FROM category_payment_rules WHERE scheme_code LIKE '%' || $2)::int AS payment_rules,
  (SELECT count(*) FROM discount_rules WHERE name LIKE '% ' || $2)::int AS discounts,
  (SELECT count(*) FROM doctors WHERE name LIKE '% ' || $2)::int AS doctors,
  (SELECT count(*) FROM billing_audit WHERE entity_id LIKE '%' || $2 || '%'
     OR entity_id LIKE '%' || $1 || '%')::int AS audit`;

const GLOBAL = `SELECT (SELECT row_to_json(s)::text FROM billing_settings s) AS settings,
  (SELECT count(*) FROM discount_rules WHERE method = 'auto' AND is_active)::int AS active_auto`;

const before = (await pool.query(GLOBAL)).rows[0];
client = await pool.connect();
let failed = false;
try {
  await client.query("BEGIN");
  await setup();
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
      ? { name: "10. everything was rolled back", ok: false, error: problems.join(", ") }
      : { name: "10. everything was rolled back", ok: true },
  );
} catch (error) {
  results.push({ name: "10. everything was rolled back", ok: false, error: error.message });
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
