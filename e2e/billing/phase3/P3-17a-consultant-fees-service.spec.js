import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs } from "../../helpers/auth.mjs";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const schemes = await import("../../../server/services/patientSchemes.js");
const rules = await import("../../../server/services/billing/paymentRules.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const fees = await import("../../../server/services/billing/consultantFees.js");
const { indiaToday } = await import("../../../server/services/billing/categoryResolver.js");

const FEES = "/api/billing/master/consultant-fees";
const ctx = { actorId: USERS.reception_admin.id, ip: "10.17.1.17" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p317a_${name}_${tag}`;
const ids = {};
const today = indiaToday();

const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);

async function call(role, method, url, data) {
  const api = await apiAs(role);
  try {
    const response = await api[method](url, data === undefined ? {} : { data });
    return { status: response.status(), json: await response.json() };
  } finally {
    await api.dispose();
  }
}

const admin = (method, url, data) => call("reception_admin", method, url, data);

async function grid(params = {}) {
  const search = new URLSearchParams(params).toString();
  const { status, json } = await admin("get", `${FEES}${search ? `?${search}` : ""}`);
  expect(status, JSON.stringify(json)).toBe(200);
  return json;
}

async function cell(doctor, visitType, scheme, date) {
  const body = await grid({
    doctorId: String(ids[doctor]),
    schemeCode: c("cghs"),
    ...(date ? { date } : {}),
  });
  const row = body.rows.find((r) => r.visit_type === visitType);
  return row.cells[c(scheme)];
}

const save = (data) => admin("put", FEES, data);
const summary = (x) => ({
  fee: x.fee,
  fee_source: x.fee_source,
  pays: x.pays.patient_pays,
  value: x.pays.patient_value,
  pays_source: x.pays.source,
});

test.describe.serial("P3-17a consultant fees service", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P317A CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      getPool(),
      ctx,
    );
    for (const [key, label] of [
      ["pensioner", "Pensioner"],
      ["referral", "CGHS Referral"],
      ["paid", "CGHS Paid"],
    ]) {
      await schemes.createScheme({ code: c(key), label, parent_code: c("cghs") }, getPool(), ctx);
    }
    await schemes.createScheme({ code: c("staff"), label: `P317A Staff ${tag}` }, getPool(), ctx);
    ids.opd = await one(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
      `P317A-OPD-${T}`,
    ]);
    ids.consults = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [ids.opd, `P317A-CONS-${T}`],
    );
    ids.dressing = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $1, $2, 200, 'procedure') RETURNING id`,
      [`P317A-DRESS-${T}`, ids.consults],
    );
    for (const [key, name, price] of [
      ["rahul", "Dr Rahul", 1000],
      ["beant", "Dr Beant", 1000],
      ["banshali", "Dr Banshali", 1500],
      ["nofee", "Dr No Fee", null],
    ]) {
      ids[key] = await one(
        `INSERT INTO doctors (name, short_name, role) VALUES ($1, $2, 'consultant') RETURNING id`,
        [`${name} P317A ${tag}`, name],
      );
      if (price === null) continue;
      for (const [visit, suffix] of [
        ["New", "NEW"],
        ["Follow Up", "FU"],
      ]) {
        ids[`${key}${suffix}`] = await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, doctor_id, visit_type)
           VALUES ($1, $2, $3, $4, 'consultation', $5, $6) RETURNING id`,
          [
            `P317A-${key.toUpperCase()}-${suffix}-${T}`,
            `Consultant meet ${name} ${visit} ${tag}`,
            ids.consults,
            price,
            ids[key],
            visit,
          ],
        );
      }
    }
    ids.oldItem = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, doctor_id, visit_type, is_active)
       VALUES ($1, $1, $2, 900, 'consultation', $3, 'New', FALSE) RETURNING id`,
      [`P317A-NOFEE-OLD-${T}`, ids.consults, ids.nofee],
    );
    await rates.saveRate(
      {
        scheme_code: c("cghs"),
        service_item_id: ids.rahulNEW,
        rate: 500,
        bill_code: `P317A${T}`,
        valid_from: "2026-01-01",
      },
      ctx,
      getPool(),
    );
    await rules.createPaymentRule(
      {
        scheme_code: c("cghs"),
        name: "CGHS consults half",
        group_id: ids.opd,
        patient_pays: "percent",
        patient_value: 50,
        valid_from: "2026-01-01",
      },
      ctx,
      getPool(),
    );
    await rules.createPaymentRule(
      {
        scheme_code: c("referral"),
        name: "Referral consults free",
        subgroup_id: ids.consults,
        patient_pays: "nothing",
        valid_from: "2026-01-01",
      },
      ctx,
      getPool(),
    );
  });

  test.afterAll(async () => {
    await query(`UPDATE service_items SET is_active = FALSE WHERE code LIKE $1`, [`P317A-%-${T}`]);
    await query(`UPDATE doctors SET is_active = FALSE WHERE name LIKE $1`, [`% P317A ${tag}`]);
  });

  test("1. the grid: rows per doctor and visit type, General + every category column, inherited values marked", async () => {
    const body = await grid({ doctorId: String(ids.rahul) });
    expect(body.date).toBe(today);
    expect(body.visit_types).toEqual(["New", "Follow Up"]);
    const codes = body.columns.map((col) => col.code);
    expect(codes[0]).toBe("general");
    const at = (code) => codes.indexOf(c(code));
    expect(at("cghs")).toBeGreaterThan(0);
    for (const sub of ["pensioner", "referral", "paid"])
      expect(at(sub)).toBeGreaterThan(at("cghs"));
    expect(body.columns.find((col) => col.code === c("pensioner")).display_label).toBe(
      `P317A CGHS ${tag} › Pensioner`,
    );
    expect(body.columns.find((col) => col.code === c("cghs")).has_sub_categories).toBe(true);
    expect(body.rows.map((r) => [r.doctor_id, r.visit_type, r.item.id])).toEqual([
      [ids.rahul, "New", ids.rahulNEW],
      [ids.rahul, "Follow Up", ids.rahulFU],
    ]);
    expect(body.not_priced).toEqual([]);

    const [fresh, followUp] = body.rows;
    expect(fresh.cells.general).toMatchObject({ fee: 1000, fee_source: "base", general: true });
    expect(fresh.cells.general.pays.patient_pays).toBe("full");

    const parent = fresh.cells[c("cghs")];
    expect(summary(parent)).toEqual({
      fee: 500,
      fee_source: "own",
      pays: "percent",
      value: 50,
      pays_source: "category",
    });
    expect(parent.own).toMatchObject({ rate: 500, valid_from: "2026-01-01", valid_to: null });
    expect(parent.pays).toMatchObject({ scope: "group", from_parent: false, inherited: true });
    expect(parent.inherited).toBe(false);

    const pensioner = fresh.cells[c("pensioner")];
    expect(summary(pensioner)).toEqual({
      fee: 500,
      fee_source: "parent",
      pays: "percent",
      value: 50,
      pays_source: "parent",
    });
    expect(pensioner).toMatchObject({
      fee_inherited: true,
      pays_inherited: true,
      inherited: true,
      own: null,
      own_rule: null,
      bill_code: `P317A${T}`,
      bill_code_source: "parent",
      bill_name_source: "base",
    });
    expect(pensioner.pays).toMatchObject({ scope: "group", from_parent: true });
    expect(pensioner.pays.rule.name).toBe("CGHS consults half");

    const referral = fresh.cells[c("referral")];
    expect(summary(referral)).toEqual({
      fee: 500,
      fee_source: "parent",
      pays: "nothing",
      value: null,
      pays_source: "category",
    });
    expect(referral.pays).toMatchObject({ scope: "subgroup", from_parent: false, inherited: true });

    expect(summary(followUp.cells[c("pensioner")])).toEqual({
      fee: 1000,
      fee_source: "base",
      pays: "percent",
      value: 50,
      pays_source: "parent",
    });
    expect(body.columns.some((col) => col.code === c("staff"))).toBe(true);
    expect(followUp.cells[c("staff")]).toMatchObject({ fee: 1000, inherited: true });
    const cghsOnly = await grid({ doctorId: String(ids.rahul), schemeCode: c("cghs") });
    expect(cghsOnly.columns.map((col) => col.code)).toEqual([
      "general",
      c("cghs"),
      c("paid"),
      c("referral"),
      c("pensioner"),
    ]);

    const all = await grid({ doctorId: String(ids.rahul), schemeCode: c("staff") });
    expect(all.columns.map((col) => col.code)).toEqual(["general", c("staff")]);
    expect(summary(all.rows[0].cells[c("staff")])).toEqual({
      fee: 1000,
      fee_source: "base",
      pays: "full",
      value: null,
      pays_source: "none",
    });
  });

  test("2. done-when: ₹350 / nothing for Dr Rahul and Dr Beant, ₹700 / nothing for Dr Banshali under Pensioner, and they reload", async () => {
    for (const [doctor, fee] of [
      ["rahul", 350],
      ["beant", 350],
      ["banshali", 700],
    ]) {
      for (const suffix of ["NEW", "FU"]) {
        const { status, json } = await save({
          scheme_code: c("pensioner"),
          service_item_id: ids[`${doctor}${suffix}`],
          fee,
          patient_pays: "nothing",
          remainder: "claim",
        });
        expect(status, JSON.stringify(json)).toBe(200);
        expect(json.cell).toMatchObject({ fee, fee_source: "own", inherited: false });
        expect(json.cell.pays).toMatchObject({ patient_pays: "nothing", source: "own" });
        expect(json.rule).toMatchObject({ patient_pays: "nothing", remainder: "claim" });
      }
    }
    for (const [doctor, fee] of [
      ["rahul", 350],
      ["beant", 350],
      ["banshali", 700],
    ]) {
      for (const visit of ["New", "Follow Up"]) {
        const saved = await cell(doctor, visit, "pensioner");
        expect(summary(saved), `${doctor} ${visit}`).toEqual({
          fee,
          fee_source: "own",
          pays: "nothing",
          value: null,
          pays_source: "own",
        });
        expect(saved.own).toMatchObject({ rate: fee, valid_from: today, valid_to: null });
        expect(saved.own_rule).toMatchObject({
          patient_pays: "nothing",
          remainder: "claim",
          valid_from: today,
          scheme_code: c("pensioner"),
        });
        expect(saved.pays.scope).toBe("item");
        expect(saved.inherited).toBe(false);
      }
    }
    const audit = await query(
      `SELECT entity, action FROM billing_audit
        WHERE actor_id = $1 AND at > NOW() - interval '5 minutes'
          AND ((entity = 'category_item_rates' AND entity_id LIKE $2)
               OR (entity = 'category_payment_rules'
                   AND entity_id IN (SELECT id::text FROM category_payment_rules WHERE scheme_code = $3)))`,
      [USERS.reception_admin.id, `${c("pensioner")}:%`, c("pensioner")],
    );
    expect(audit.rows.filter((r) => r.entity === "category_item_rates").length).toBe(6);
    expect(audit.rows.filter((r) => r.entity === "category_payment_rules").length).toBe(6);
  });

  test("3. a pays-amount above the fee is refused with the item listed, and nothing is saved", async () => {
    const before = await cell("rahul", "New", "pensioner");
    const refused = await save({
      scheme_code: c("pensioner"),
      service_item_id: ids.rahulNEW,
      fee: 350,
      patient_pays: "amount",
      patient_value: 400,
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain("can't pay ₹400");
    expect(refused.json.error).toContain("the fee there is ₹350");
    expect(refused.json.items).toEqual([expect.objectContaining({ id: ids.rahulNEW, price: 350 })]);
    const inherited = await save({
      scheme_code: c("referral"),
      service_item_id: ids.rahulNEW,
      patient_pays: "amount",
      patient_value: 600,
    });
    expect(inherited.status).toBe(409);
    expect(inherited.json.error).toContain("the fee there is ₹500");
    const lowered = await save({
      scheme_code: c("pensioner"),
      service_item_id: ids.rahulNEW,
      fee: 100,
      patient_pays: "amount",
      patient_value: 350,
    });
    expect(lowered.status).toBe(409);
    expect(lowered.json.error).toContain("the fee there is ₹100");
    expect(await cell("rahul", "New", "pensioner")).toEqual(before);
  });

  test("4. other refusals: General, a non-consultation item, nothing to save, a claim with no payer", async () => {
    const general = await save({ scheme_code: "general", service_item_id: ids.rahulNEW, fee: 1 });
    expect(general.status).toBe(400);
    expect(general.json.error).toContain("Services page");
    const dressing = await save({
      scheme_code: c("pensioner"),
      service_item_id: ids.dressing,
      fee: 100,
    });
    expect(dressing.status).toBe(409);
    expect(dressing.json.error).toContain("isn't a consultation item");
    const empty = await save({ scheme_code: c("pensioner"), service_item_id: ids.rahulNEW });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toContain("Nothing to save");
    const valueOnly = await save({
      scheme_code: c("pensioner"),
      service_item_id: ids.rahulNEW,
      patient_value: 10,
    });
    expect(valueOnly.status).toBe(400);
    expect(valueOnly.json.error).toContain("what the patient pays");
    const noPayer = await save({
      scheme_code: c("staff"),
      service_item_id: ids.rahulNEW,
      fee: 300,
      patient_pays: "nothing",
      remainder: "claim",
    });
    expect(noPayer.status).toBe(409);
    expect(noPayer.json.error).toContain("no payer name");
    const staff = await grid({ doctorId: String(ids.rahul), schemeCode: c("staff") });
    expect(staff.rows[0].cells[c("staff")].own).toBeNull();
    const unknown = await save({ scheme_code: "zz_nobody", service_item_id: ids.rahulNEW, fee: 1 });
    expect(unknown.status).toBe(404);
  });

  test("5. a fee lowered below its own rule's amount saves when the rule changes in the same save", async () => {
    const first = await save({
      scheme_code: c("paid"),
      service_item_id: ids.beantNEW,
      fee: 700,
      patient_pays: "amount",
      patient_value: 500,
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const lowered = await save({
      scheme_code: c("paid"),
      service_item_id: ids.beantNEW,
      fee: 300,
      patient_pays: "nothing",
    });
    expect(lowered.status, JSON.stringify(lowered.json)).toBe(200);
    expect(summary(lowered.json.cell)).toEqual({
      fee: 300,
      fee_source: "own",
      pays: "nothing",
      value: null,
      pays_source: "own",
    });
    expect(lowered.json.rule.id).toBe(first.json.rule.id);
    const raised = await save({
      scheme_code: c("paid"),
      service_item_id: ids.beantNEW,
      fee: 900,
      patient_pays: "amount",
      patient_value: 800,
    });
    expect(raised.status, JSON.stringify(raised.json)).toBe(200);
    expect(summary(raised.json.cell)).toMatchObject({ fee: 900, pays: "amount", value: 800 });
    const tooLow = await save({ scheme_code: c("paid"), service_item_id: ids.beantNEW, fee: 600 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.json.conflicts?.length).toBeGreaterThan(0);
  });

  test("6. start date: new cells start today, edits keep their start date, a changed start date starts a new period", async () => {
    const created = await save({
      scheme_code: c("paid"),
      service_item_id: ids.rahulFU,
      fee: 800,
      patient_pays: "amount",
      patient_value: 300,
      valid_from: "2026-02-01",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json.starts_in_past).toBe(true);
    const edited = await save({
      scheme_code: c("paid"),
      service_item_id: ids.rahulFU,
      fee: 850,
      patient_pays: "amount",
      patient_value: 400,
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    const kept = await cell("rahul", "Follow Up", "paid");
    expect(kept.own).toMatchObject({ rate: 850, valid_from: "2026-02-01", valid_to: null });
    expect(kept.own_rule).toMatchObject({ patient_value: 400, valid_from: "2026-02-01" });
    const billName = await save({
      scheme_code: c("paid"),
      service_item_id: ids.rahulFU,
      bill_name: `CGHS consult ${tag}`,
    });
    expect(billName.status, JSON.stringify(billName.json)).toBe(200);
    expect((await cell("rahul", "Follow Up", "paid")).own).toMatchObject({
      rate: 850,
      bill_name: `CGHS consult ${tag}`,
      valid_from: "2026-02-01",
    });
    const rows = await query(
      `SELECT valid_from, valid_to, rate::float8 AS rate FROM category_item_rates
        WHERE scheme_code = $1 AND service_item_id = $2 ORDER BY valid_from`,
      [c("paid"), ids.rahulFU],
    );
    expect(rows.rows).toEqual([{ valid_from: "2026-02-01", valid_to: null, rate: 850 }]);

    const later = await save({
      scheme_code: c("paid"),
      service_item_id: ids.rahulFU,
      fee: 1200,
      patient_pays: "amount",
      patient_value: 700,
      valid_from: "2027-01-01",
    });
    expect(later.status, JSON.stringify(later.json)).toBe(200);
    const now = await cell("rahul", "Follow Up", "paid");
    expect(now.own).toMatchObject({ rate: 850, valid_to: "2026-12-31" });
    expect(now.next_valid_from).toBe("2027-01-01");
    expect(now.own_rule).toMatchObject({ patient_value: 400, valid_to: "2026-12-31" });
    const then = await cell("rahul", "Follow Up", "paid", "2027-01-02");
    expect(then.own).toMatchObject({ rate: 1200, bill_name: `CGHS consult ${tag}` });
    expect(then.own_rule).toMatchObject({ patient_value: 700, valid_from: "2027-01-01" });
    expect(summary(then)).toMatchObject({ fee: 1200, pays: "amount", value: 700 });

    const fresh = await save({
      scheme_code: c("paid"),
      service_item_id: ids.banshaliFU,
      fee: 1100,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.json.cell.own.valid_from).toBe(today);
    expect(fresh.json.starts_in_past).toBe(false);
  });

  test("7. clearing a cell brings the inherited fee and payment back", async () => {
    const cleared = await admin("delete", `${FEES}/${c("pensioner")}/items/${ids.rahulNEW}`);
    expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
    expect(cleared.json.deleted_rate).toMatchObject({ rate: 350 });
    expect(cleared.json.deleted_rules).toHaveLength(1);
    const back = await cell("rahul", "New", "pensioner");
    expect(summary(back)).toEqual({
      fee: 500,
      fee_source: "parent",
      pays: "percent",
      value: 50,
      pays_source: "parent",
    });
    expect(back).toMatchObject({ own: null, own_rule: null, inherited: true });
    const again = await admin("delete", `${FEES}/${c("pensioner")}/items/${ids.rahulNEW}`);
    expect(again.status).toBe(404);
    const restored = await save({
      scheme_code: c("pensioner"),
      service_item_id: ids.rahulNEW,
      fee: 350,
      patient_pays: "nothing",
    });
    expect(restored.status).toBe(200);
    expect(summary(restored.json.cell)).toMatchObject({ fee: 350, pays: "nothing" });
  });

  test("8. copying the Pensioner column to CGHS Referral gives the same cells there", async () => {
    const copy = await admin("post", `${FEES}/copy`, {
      from_scheme_code: c("pensioner"),
      to_scheme_code: c("referral"),
    });
    expect(copy.status, JSON.stringify(copy.json)).toBe(200);
    expect(copy.json.copied).toBe(6);
    for (const [doctor, fee] of [
      ["rahul", 350],
      ["beant", 350],
      ["banshali", 700],
    ]) {
      for (const visit of ["New", "Follow Up"]) {
        const from = await cell(doctor, visit, "pensioner");
        const to = await cell(doctor, visit, "referral");
        expect(summary(to), `${doctor} ${visit}`).toEqual(summary(from));
        expect(summary(to)).toMatchObject({ fee, pays: "nothing", pays_source: "own" });
        expect(to.own_rule.remainder).toBe(from.own_rule.remainder);
        expect(to.own_rule.scheme_code).toBe(c("referral"));
      }
    }
    const same = await admin("post", `${FEES}/copy`, {
      from_scheme_code: c("pensioner"),
      to_scheme_code: c("pensioner"),
    });
    expect(same.status).toBe(400);
    const toGeneral = await admin("post", `${FEES}/copy`, {
      from_scheme_code: c("pensioner"),
      to_scheme_code: "general",
    });
    expect(toGeneral.status).toBe(400);
    const noPayer = await admin("post", `${FEES}/copy`, {
      from_scheme_code: c("pensioner"),
      to_scheme_code: c("staff"),
    });
    expect(noPayer.status).toBe(409);
    const staff = await grid({ schemeCode: c("staff"), doctorId: String(ids.beant) });
    expect(staff.rows.every((r) => r.cells[c("staff")].own === null)).toBe(true);
  });

  test("9. a consultant with no consultation item is listed as not priced", async () => {
    const body = await grid({ doctorId: String(ids.nofee) });
    expect(body.rows).toEqual([]);
    expect(body.not_priced).toEqual([
      expect.objectContaining({
        doctor_id: ids.nofee,
        visit_type: "New",
        status: "item_deactivated",
        item_id: ids.oldItem,
      }),
      expect.objectContaining({
        doctor_id: ids.nofee,
        visit_type: "Follow Up",
        status: "no_item",
        item_id: null,
      }),
    ]);
    const everyone = await grid({ schemeCode: c("pensioner") });
    expect(everyone.columns.map((col) => col.code)).toEqual(["general", c("pensioner")]);
    expect(everyone.not_priced.filter((r) => r.doctor_id === ids.nofee)).toHaveLength(2);
    expect(
      everyone.rows.filter((r) => [ids.rahul, ids.beant, ids.banshali].includes(r.doctor_id)),
    ).toHaveLength(6);
  });

  test("10. reception can't read or change consultant fees", async () => {
    const read = await call("reception", "get", FEES);
    expect(read.status).toBe(403);
    const write = await call("reception", "put", FEES, {
      scheme_code: c("pensioner"),
      service_item_id: ids.rahulNEW,
      fee: 1,
    });
    expect(write.status).toBe(403);
    expect(summary(await cell("rahul", "New", "pensioner"))).toMatchObject({ fee: 350 });
  });

  test("11. a cell's payment rule can't be saved over one already scheduled for a later date", async () => {
    const base = { scheme_code: c("paid"), service_item_id: ids.beantFU };
    const refused = (input) =>
      fees.saveConsultantFee({ ...base, ...input }, ctx, getPool()).then(
        () => null,
        (error) => ({ status: error.status, message: error.message }),
      );
    const scheduled = await fees.saveConsultantFee(
      { ...base, patient_pays: "nothing", valid_from: "2027-03-01" },
      ctx,
      getPool(),
    );
    const name = scheduled.rule.name;
    const clash = {
      status: 409,
      message: `Consultant meet Dr Beant Follow Up ${tag} in P317A CGHS ${tag} › CGHS Paid already has the payment rule "${name}" from 2027-03-01; give this one a To date of 2027-02-28 or earlier, or change that rule`,
    };
    expect(await refused({ patient_pays: "full", valid_from: "2027-02-01" })).toEqual(clash);
    expect(
      await refused({ patient_pays: "full", valid_from: "2027-02-01", valid_to: "2027-03-15" }),
    ).toEqual(clash);
    const before = await fees.saveConsultantFee(
      { ...base, patient_pays: "full", valid_from: "2027-02-01", valid_to: "2027-02-28" },
      ctx,
      getPool(),
    );
    expect(before.rule).toMatchObject({ valid_from: "2027-02-01", valid_to: "2027-02-28" });
    expect(
      await refused({ patient_pays: "full", valid_from: "2027-02-01", valid_to: null }),
    ).toEqual(clash);
    const rows = await query(
      `SELECT patient_pays, valid_from, valid_to FROM category_payment_rules
        WHERE scheme_code = $1 AND service_item_id = $2 ORDER BY valid_from`,
      [c("paid"), ids.beantFU],
    );
    expect(rows.rows).toEqual([
      { patient_pays: "full", valid_from: "2027-02-01", valid_to: "2027-02-28" },
      { patient_pays: "nothing", valid_from: "2027-03-01", valid_to: null },
    ]);
    const march = await fees.consultantFeeGrid(
      { doctorId: ids.beant, schemeCode: c("paid"), date: "2027-03-02" },
      getPool(),
    );
    const cellThen = march.rows.find((r) => r.visit_type === "Follow Up").cells[c("paid")];
    expect(cellThen.own_rule).toMatchObject({ name, patient_pays: "nothing" });
  });
});
