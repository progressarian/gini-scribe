import pool from "../../config/db.js";
import { RESERVED_CATEGORY_CODES, VISIT_TYPES } from "../../../shared/billingVocab.js";
import { paise } from "../../../shared/labPayment.js";
import { indiaToday } from "./categoryResolver.js";
import { getSettings } from "./billingSettings.js";
import { autoRulesFor, checkCode } from "./discountRules.js";
import { applyDiscounts } from "./lineDiscounts.js";
import { linePayable } from "./linePayable.js";
import { lineTax } from "./lineTax.js";
import { assertLineBalances } from "./lineInvariant.js";
import { checkBillable, cleanDraftRule, draftForLine, ruleForLine } from "./paymentRules.js";
import { httpError } from "./transaction.js";
import { cleanDate, INT_MAX, MONEY_MAX, readNumber, wholeNumber } from "./common.js";

function cleanItem(value) {
  const id = readNumber(value, "Choose a valid item");
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) throw httpError(400, "Choose a valid item");
  return id;
}

function cleanCategory(value) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw httpError(400, "Category must be a category code");
  }
  const code = (value ?? "").trim().toLowerCase();
  return !code || RESERVED_CATEGORY_CODES.includes(code) ? null : code;
}

function checkQuantity(item, quantity) {
  if (quantity !== 1 && !item.allow_quantity) {
    throw httpError(400, `${item.name} is billed one at a time; its quantity must be 1`);
  }
  if (item.max_quantity !== null && quantity > item.max_quantity) {
    throw httpError(
      400,
      `${item.name} can be billed at most ${item.max_quantity} ${item.unit} on one line`,
    );
  }
}

const rateOn = (scheme) => `
  LEFT JOIN LATERAL (
    SELECT r.rate, r.bill_name, r.bill_code
      FROM category_item_rates r
     WHERE r.scheme_code = ${scheme} AND r.service_item_id = i.id
       AND r.valid_from <= $3::date AND (r.valid_to IS NULL OR r.valid_to >= $3::date)
     ORDER BY r.valid_from DESC LIMIT 1
  )`;

const pick = (own, parent, base) =>
  own !== null && own !== undefined
    ? { value: own, source: "own" }
    : parent !== null && parent !== undefined
      ? { value: parent, source: "parent" }
      : { value: base, source: "base" };

export async function lineActual({ item, quantity, category, date } = {}, db = pool) {
  const itemId = cleanItem(item);
  const count = wholeNumber(quantity, "Quantity", { min: 1 }) ?? 1;
  const on = cleanDate(date, "Date") ?? indiaToday();
  const code = cleanCategory(category);
  const { rows } = await db.query(
    `SELECT i.id, i.code, i.name, i.kind, i.subgroup_id, sg.group_id, sg.code AS subgroup_code,
            g.code AS group_code, i.doctor_id, i.visit_type,
            i.unit, i.allow_quantity, i.max_quantity, i.base_price, i.price_includes_tax,
            i.is_active, t.id AS tax_id, t.code AS tax_code, t.sac_hsn AS tax_sac_hsn,
            t.rate_pct AS tax_rate_pct, t.is_active AS tax_active,
            own.rate AS own_rate, own.bill_name AS own_bill_name, own.bill_code AS own_bill_code,
            par.rate AS parent_rate, par.bill_name AS parent_bill_name,
            par.bill_code AS parent_bill_code
       FROM service_items i
       JOIN service_subgroups sg ON sg.id = i.subgroup_id
       JOIN service_groups g ON g.id = sg.group_id
       LEFT JOIN tax_codes t ON t.id = i.tax_code_id
       ${rateOn("$2")} own ON TRUE
       ${rateOn("(SELECT parent_code FROM patient_schemes WHERE code = $2)")} par ON TRUE
      WHERE i.id = $1`,
    [itemId, code, on],
  );
  if (!rows.length) throw httpError(404, "That item doesn't exist");
  const [row] = rows;
  if (!row.is_active) throw httpError(409, `${row.name} is deactivated`);
  checkQuantity(row, count);
  if (code) await checkBillable(db, code);
  const rate = pick(
    row.own_rate === null ? null : paise(row.own_rate),
    row.parent_rate === null ? null : paise(row.parent_rate),
    paise(row.base_price),
  );
  const billName = pick(row.own_bill_name, row.parent_bill_name, row.name);
  const billCode = pick(row.own_bill_code, row.parent_bill_code, null);
  const actual = count * rate.value;
  if (actual > paise(MONEY_MAX)) {
    throw httpError(400, `${row.name} × ${count} is too large for one line`);
  }
  return {
    item_id: row.id,
    item_code: row.code,
    item_name: row.name,
    kind: row.kind,
    group_id: row.group_id,
    group_code: row.group_code,
    subgroup_id: row.subgroup_id,
    subgroup_code: row.subgroup_code,
    doctor_id: row.doctor_id,
    visit_type: row.visit_type,
    unit: row.unit,
    quantity: count,
    category: code,
    date: on,
    base_price: paise(row.base_price),
    rate: rate.value,
    rate_source: rate.source,
    bill_name: billName.value,
    bill_name_source: billName.source,
    bill_code: billCode.value,
    bill_code_source: billCode.value === null ? null : billCode.source,
    actual,
    tax_code:
      row.tax_id === null
        ? null
        : {
            id: row.tax_id,
            code: row.tax_code,
            sac_hsn: row.tax_sac_hsn,
            rate_pct: Number(row.tax_rate_pct),
            is_active: row.tax_active,
          },
    price_includes_tax: row.price_includes_tax,
  };
}

function cleanCodes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
    throw httpError(400, "Discount codes must be a list of codes");
  }
  const seen = new Set();
  return value
    .map((code) => code.trim())
    .filter((code) => code && !seen.has(code.toLowerCase()) && seen.add(code.toLowerCase()));
}

function cleanVisitType(value, own) {
  if (value !== undefined && value !== null && !VISIT_TYPES.includes(value)) {
    throw httpError(400, `Visit type must be one of: ${VISIT_TYPES.join(", ")}`);
  }
  return own ?? value ?? null;
}

async function lineDoctor(own, value, db) {
  const id = wholeNumber(value, "Doctor", { min: 1 }) ?? null;
  if (own !== null || id === null) return own;
  const { rows } = await db.query(`SELECT 1 FROM doctors WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That doctor doesn't exist");
  return id;
}

function checkTaxCode(taxCode, settings) {
  if (settings.gst_enabled && taxCode && !taxCode.is_active) {
    throw httpError(409, `Tax code ${taxCode.code} is deactivated`);
  }
}

const schemeRateRefusal = (code, rule, payment) => ({
  code,
  reason: "payment_rule",
  message: `The code ${rule.code} doesn't apply here: this line is under the payment rule "${payment.rule?.name}", and the code only applies to lines where the patient pays in full`,
});

async function lineDiscountRules(line, context, codes, payment, db) {
  const target = {
    item_id: line.item_id,
    subgroup_id: line.subgroup_id,
    group_id: line.group_id,
    doctor_id: line.doctor_id,
    visit_type: line.visit_type,
  };
  const fullPay = payment.patient_pays === "full";
  const fits = (rule) => fullPay || rule.applies_on_scheme_rate;
  const rules = (await autoRulesFor(target, context, db)).filter(fits);
  const refused = [];
  let accepted = 0;
  for (const code of codes) {
    const result = await checkCode(
      code,
      target,
      { ...context, codesOnBill: context.codesOnBill + accepted },
      db,
    );
    if (result.ok && result.rule.applies_per === "bill") {
      refused.push({
        code,
        reason: "bill_level",
        message: `The code ${result.rule.code} applies to the whole bill, not to one line`,
      });
    } else if (result.ok && !fits(result.rule)) {
      refused.push(schemeRateRefusal(code, result.rule, payment));
    } else if (result.ok) {
      rules.push(result.rule);
      accepted += 1;
    } else refused.push({ code, reason: result.reason, message: result.message });
  }
  const unique = [...new Map(rules.map((rule) => [rule.id, rule])).values()];
  return { rules: unique, refused };
}

const described = (applied, rules, takenFrom) => {
  const methods = new Map(rules.map((rule) => [rule.id, rule.method]));
  return applied.map((step) => ({
    ...step,
    method: methods.get(step.rule_id),
    taken_from: takenFrom,
  }));
};

export async function priceLine(input = {}, db = pool) {
  const line = await lineActual(input, db);
  const visitType = cleanVisitType(input.visitType, line.visit_type);
  const doctorId = await lineDoctor(line.doctor_id, input.doctorId, db);
  const codes = cleanCodes(input.codes);
  const codesOnBill = wholeNumber(input.codesOnBill, "Codes on the bill") ?? 0;
  const settings = input.settings ?? (await getSettings(db));
  checkTaxCode(line.tax_code, settings);
  const draft = draftForLine(cleanDraftRule(input.draftRule), line, visitType);
  const payment =
    draft ??
    (await ruleForLine(
      { category: line.category, item: line.item_id, visitType, date: line.date },
      db,
    ));
  const context = {
    category: line.category,
    patient: input.patient ?? {},
    date: line.date,
    role: input.role,
    codesOnBill,
  };
  const fullPay = payment.patient_pays === "full";
  const { rules, refused } = await lineDiscountRules(
    { ...line, visit_type: visitType, doctor_id: doctorId },
    context,
    codes,
    payment,
    db,
  );
  const discountOn = (amount, list) =>
    applyDiscounts({
      actual: amount,
      quantity: line.quantity,
      rules: list,
      stacking: settings.discount_stacking,
    });
  const lineStep = discountOn(line.actual, fullPay ? rules : []);
  const taxOn = (net) =>
    lineTax({
      net,
      taxCode: line.tax_code,
      gstEnabled: settings.gst_enabled,
      priceIncludesTax: line.price_includes_tax,
    });
  const tax = taxOn(line.actual - lineStep.discount);
  const actual = line.price_includes_tax
    ? Math.max(taxOn(line.actual).taxable, tax.taxable)
    : line.actual;
  const shares = linePayable({ total: tax.total, payment, quantity: line.quantity });
  const payableStep = discountOn(shares.patient_payable, fullPay ? [] : rules);
  return assertLineBalances({
    ...line,
    visit_type: visitType,
    doctor_id: doctorId,
    actual,
    listed_actual: line.actual,
    discount: actual - tax.taxable + payableStep.discount,
    listed_discount: lineStep.discount + payableStep.discount,
    payable_discount: payableStep.discount,
    discounts: [
      ...described(lineStep.applied, rules, "actual"),
      ...described(payableStep.applied, rules, "patient_payable"),
    ],
    refused_codes: refused,
    ...tax,
    ...shares,
    patient_payable: shares.patient_payable - payableStep.discount,
    payment_rule_text: payment.draft
      ? `${shares.payment_rule_text} (draft)`
      : shares.payment_rule_text,
    payment_rule_name: payment.rule?.name ?? null,
    payment_rule_scope: payment.scope,
    payment_rule_from_parent: payment.from_parent,
  });
}
