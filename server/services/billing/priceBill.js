import pool from "../../config/db.js";
import { billingVisitType } from "../../../shared/billingVisitType.js";
import {
  CONSULTATION_VISIT_TYPES,
  RESERVED_CATEGORY_CODES,
  VISIT_TYPES,
} from "../../../shared/billingVocab.js";
import { getSettings } from "./billingSettings.js";
import { indiaToday, normalizeGender, resolveCategoryFor } from "./categoryResolver.js";
import { cleanDate, wholeNumber } from "./common.js";
import { autoRulesFor, checkCode, CODE_REFUSALS } from "./discountRules.js";
import { applyDiscounts } from "./lineDiscounts.js";
import { assertBillLineBalances } from "./lineInvariant.js";
import { cleanDraftRule } from "./paymentRules.js";
import { priceLine } from "./priceLine.js";
import { httpError } from "./transaction.js";

export const MAX_BILL_LINES = 100;
export const MAX_BILL_CODES = 20;

const TOTALS = [
  "actual",
  "discount",
  "bill_discount",
  "taxable",
  "cgst",
  "sgst",
  "tax",
  "patient_payable",
  "claim",
  "adjustment",
];

const LINE_TARGETS = {
  group_ids: "group_id",
  subgroup_ids: "subgroup_id",
  service_item_ids: "item_id",
};

const NO_CONSULTATION_VISIT = VISIT_TYPES.find((type) => !CONSULTATION_VISIT_TYPES.includes(type));

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readOnce(db) {
  const seen = new Map();
  return {
    query(text, params) {
      if (typeof text !== "string" || !/^\s*SELECT\b/i.test(text)) return db.query(text, params);
      const key = JSON.stringify([text, params ?? []]);
      if (!seen.has(key)) seen.set(key, db.query(text, params));
      return seen.get(key).then((result) => ({ ...result, rows: structuredClone(result.rows) }));
    },
  };
}

function cleanLines(value) {
  if (!Array.isArray(value) || !value.length)
    throw httpError(400, "A bill needs at least one line");
  if (value.length > MAX_BILL_LINES) {
    throw httpError(400, `A bill can have at most ${MAX_BILL_LINES} lines`);
  }
  return value.map((line, index) => {
    if (!isObject(line) || line.item === undefined || line.item === null) {
      throw httpError(400, `Line ${index + 1} must name an item`);
    }
    return line;
  });
}

function cleanCodes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
    throw httpError(400, "Discount codes must be a list of codes");
  }
  const seen = new Set();
  const codes = value
    .map((code) => code.trim())
    .filter((code) => code && !seen.has(code.toLowerCase()) && seen.add(code.toLowerCase()));
  if (codes.length > MAX_BILL_CODES) {
    throw httpError(400, `A bill can have at most ${MAX_BILL_CODES} discount codes entered`);
  }
  return codes;
}

function cleanCategory(value) {
  if (value === undefined) return undefined;
  if (value !== null && typeof value !== "string") {
    throw httpError(400, "Category must be a category code");
  }
  const code = (value ?? "").trim().toLowerCase();
  return !code || RESERVED_CATEGORY_CODES.includes(code) ? null : code;
}

async function loadAppointment(id, db) {
  if (id === undefined) return null;
  const { rows } = await db.query(
    `SELECT id, patient_id, patient_category, visit_type, doctor_id FROM appointments WHERE id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That appointment doesn't exist");
  return rows[0];
}

async function loadPatient(id, db) {
  if (id === undefined || id === null) return null;
  const { rows } = await db.query(
    `SELECT id, dob::text AS dob, age, sex, scheme_code, scheme_ref FROM patients WHERE id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That patient doesn't exist");
  return rows[0];
}

const SUB_CATEGORIES = `
  (SELECT json_agg(json_build_object(
            'category', json_build_object(
              'code', c.code,
              'label', c.label,
              'display_label', s.label || ' › ' || c.label,
              'parent_code', c.parent_code,
              'payer_name', c.payer_name),
            'rule', NULL,
            'reason', 'choose_sub_category')
          ORDER BY c.sort_order, c.label, c.code)
     FROM patient_schemes c WHERE c.parent_code = s.code AND c.is_active)`;

function needsSubCategory(displayLabel, suggestions) {
  const choices = suggestions.map((s) => s.category.display_label);
  return httpError(
    409,
    `${displayLabel} has sub-categories, so the bill can't be made under it: choose one of ${choices.join(", ")}`,
    { needs_sub_category: true, suggestions },
  );
}

async function describeCategory(code, db) {
  if (code === null) return null;
  const { rows } = await db.query(
    `SELECT s.code, s.label, s.parent_code,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS display_label,
            COALESCE(NULLIF(btrim(s.payer_name), ''), NULLIF(btrim(p.payer_name), '')) AS payer_name,
            s.is_active AND COALESCE(p.is_active, TRUE) AS billable,
            ${SUB_CATEGORIES} AS sub_categories
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  const { billable, sub_categories: subCategories, ...category } = rows[0];
  if (!billable) throw httpError(409, `${category.display_label} is retired`);
  if (subCategories) throw needsSubCategory(category.display_label, subCategories);
  return category;
}

function billPatientFacts(value) {
  if (value === undefined || value === null) return { id: null, age: null, gender: null };
  if (!isObject(value)) throw httpError(400, "Patient must be an object with age and gender");
  return {
    id: null,
    age: wholeNumber(value.age, "Age", { min: 0 }) ?? null,
    gender: normalizeGender(value.gender),
  };
}

async function billWho(input, date, db) {
  const appointment = await loadAppointment(
    wholeNumber(input.appointmentId, "Appointment", { min: 1 }),
    db,
  );
  const patientId = wholeNumber(input.patientId, "Patient", { min: 1 });
  if (appointment?.patient_id && patientId !== undefined && appointment.patient_id !== patientId) {
    throw httpError(409, "That appointment belongs to another patient");
  }
  const patient = await loadPatient(patientId ?? appointment?.patient_id, db);
  const explicit = cleanCategory(input.category);
  const resolution =
    patient || appointment ? await resolveCategoryFor({ patient, appointment, date }, db) : null;
  const code = explicit !== undefined ? explicit : (resolution?.category?.code ?? null);
  const category = await describeCategory(code, db);
  const facts = patient
    ? { id: patient.id, age: resolution.age, gender: normalizeGender(patient.sex) }
    : billPatientFacts(input.patient);
  return {
    appointment,
    patient: { ...facts, age_source: patient ? resolution.age_source : null },
    category: category && {
      ...category,
      source: explicit !== undefined ? "chosen" : resolution.source,
      rule: explicit !== undefined ? null : resolution.rule,
    },
    warnings: explicit === undefined ? (resolution?.warnings ?? []) : [],
  };
}

async function priceOne(input, index, db) {
  try {
    return await priceLine(input, db);
  } catch (error) {
    if (error.status) {
      error.message = `Line ${index + 1}: ${error.message}`;
      error.line_no = index + 1;
    }
    throw error;
  }
}

const sameCode = (a, b) => a.toLowerCase() === b.toLowerCase();

const refusalRank = (reason) => {
  const index = CODE_REFUSALS.indexOf(reason);
  return index === -1 ? CODE_REFUSALS.length : index;
};

function lineCodeOutcome(code, priced) {
  const refusals = priced
    .map((line) => line.refused_codes.find((refused) => sameCode(refused.code, code)))
    .filter(Boolean);
  if (refusals.length < priced.length) return { applies: true };
  const best = refusals.reduce((a, b) => (refusalRank(b.reason) > refusalRank(a.reason) ? b : a));
  return { applies: false, reason: best.reason, message: best.message };
}

const BILL_MISSES = ["items", "doctor", "visit_type", "payment_rule"];

function billRuleMiss(rule, line) {
  const targets = Object.keys(LINE_TARGETS).filter((key) => rule[key]);
  if (targets.length && !targets.some((key) => rule[key].includes(line[LINE_TARGETS[key]]))) {
    return "items";
  }
  if (rule.doctor_ids && !rule.doctor_ids.includes(line.doctor_id)) return "doctor";
  if (rule.visit_types && !rule.visit_types.includes(line.visit_type)) return "visit_type";
  if (line.remainder !== null && !rule.applies_on_scheme_rate) return "payment_rule";
  return null;
}

const BILL_MISS_MESSAGES = {
  items: (rule) => `The code ${rule.code} isn't for any item on this bill`,
  doctor: (rule) => `The code ${rule.code} isn't for any doctor on this bill`,
  visit_type: (rule) =>
    `The code ${rule.code} is only for ${rule.visit_types.join(" or ")} visits, and this bill has none`,
  payment_rule: (rule) =>
    `The code ${rule.code} only applies to lines where the patient pays in full, and this bill has none`,
};

const wholeBillPrice = (rule) => rule.kind === "fixed_price";

function billCodeOutcome(rule, lines) {
  if (wholeBillPrice(rule)) {
    return {
      applies: false,
      reason: "fixed_price",
      message: `The code ${rule.code} sets a fixed price, which can't apply to a whole bill`,
    };
  }
  const misses = lines.map((line) => billRuleMiss(rule, line));
  if (misses.some((miss) => miss === null)) return { applies: true };
  const reason = misses.reduce((a, b) => (BILL_MISSES.indexOf(b) > BILL_MISSES.indexOf(a) ? b : a));
  return { applies: false, reason, message: BILL_MISS_MESSAGES[reason](rule) };
}

const crowdedRefusal = (code, max, count) => ({
  code,
  reason: "too_many_codes",
  message: `A bill can have at most ${max} discount code${max === 1 ? "" : "s"}, and this bill already has ${count}`,
});

async function priceWithCodes(lineInputs, lineCodes, db) {
  const priced = [];
  for (const [index, input] of lineInputs.entries()) {
    priced.push(await priceOne({ ...input, codes: lineCodes, codesOnBill: 0 }, index, db));
  }
  return priced;
}

async function admitCodes({ codes, context, lineInputs, settings }, db) {
  const refused = [];
  const probed = [];
  for (const code of codes) {
    const result = await checkCode(code, null, context, db);
    if (result.ok) probed.push({ code, rule: result.rule });
    else refused.push({ code, reason: result.reason, message: result.message });
  }
  const lineCodes = probed.filter((p) => p.rule.applies_per !== "bill").map((p) => p.code);
  const priced = await priceWithCodes(lineInputs, lineCodes, db);
  const max = settings.max_codes_per_bill;
  const admitted = [];
  for (const { code, rule } of probed) {
    if (max !== null && admitted.length >= max) {
      refused.push(crowdedRefusal(code, max, admitted.length));
      continue;
    }
    const outcome =
      rule.applies_per === "bill" ? billCodeOutcome(rule, priced) : lineCodeOutcome(code, priced);
    if (outcome.applies) admitted.push({ code, rule });
    else refused.push({ code, reason: outcome.reason, message: outcome.message });
  }
  const order = new Map(codes.map((code, index) => [code, index]));
  refused.sort((a, b) => order.get(a.code) - order.get(b.code));
  return { admitted, refused, priced, lineCodes };
}

async function settleLineCodes({ priced, lineInputs, lineCodes, admitted }, db) {
  const kept = admitted.filter(({ rule }) => rule.applies_per !== "bill").map(({ code }) => code);
  const lines = [];
  for (const [index, line] of priced.entries()) {
    const accepted = lineCodes.filter(
      (code) => !line.refused_codes.some((refused) => sameCode(refused.code, code)),
    );
    const keep = accepted.filter((code) => kept.includes(code));
    lines.push(
      keep.length === accepted.length
        ? line
        : await priceOne({ ...lineInputs[index], codes: keep, codesOnBill: 0 }, index, db),
    );
  }
  return lines;
}

const byPriority = (a, b) =>
  Number(a.priority ?? 0) - Number(b.priority ?? 0) || Number(a.id) - Number(b.id);

function ruleTakes(rule, scope, remaining, stacking) {
  const base = scope.reduce((sum, index) => sum + remaining[index], 0);
  if (!base) return 0;
  return applyDiscounts({
    actual: base,
    quantity: 1,
    rules: [{ ...rule, applies_per: "line" }],
    stacking,
  }).discount;
}

function largestBillRule(rules, scopes, remaining, stacking) {
  let best = null;
  for (const rule of [...rules].sort(byPriority)) {
    const amount = ruleTakes(rule, scopes.get(rule.id), remaining, stacking);
    if (amount > 0 && (!best || amount > best.amount)) best = { rule, amount };
  }
  return best;
}

function allocate(amount, scope, remaining) {
  const base = scope.reduce((sum, index) => sum + remaining[index], 0);
  const shares = scope.map((index) => {
    const exact = BigInt(amount) * BigInt(remaining[index]);
    return {
      index,
      share: Number(exact / BigInt(base)),
      rest: exact % BigInt(base),
    };
  });
  let left = amount - shares.reduce((sum, s) => sum + s.share, 0);
  const byRest = [...shares].sort((a, b) =>
    a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1,
  );
  for (const s of byRest) {
    if (!left) break;
    s.share += 1;
    left -= 1;
  }
  return shares.filter((s) => s.share > 0);
}

function billSteps(rules, lines, stacking) {
  const scopes = new Map(
    rules.map((rule) => [
      rule.id,
      lines.flatMap((line, index) => (billRuleMiss(rule, line) === null ? [index] : [])),
    ]),
  );
  const remaining = lines.map((line) => line.patient_payable);
  const steps = [];
  const take = (found) => {
    if (!found) return;
    const shares = allocate(found.amount, scopes.get(found.rule.id), remaining);
    for (const { index, share } of shares) remaining[index] -= share;
    steps.push({ rule: found.rule, amount: found.amount, shares });
  };
  if (stacking === "best_only") {
    take(largestBillRule(rules, scopes, remaining, stacking));
  } else {
    take(
      largestBillRule(
        rules.filter((rule) => !rule.stackable),
        scopes,
        remaining,
        stacking,
      ),
    );
    for (const rule of rules.filter((r) => r.stackable).sort(byPriority)) {
      const amount = ruleTakes(rule, scopes.get(rule.id), remaining, stacking);
      if (amount > 0) take({ rule, amount });
    }
  }
  return steps;
}

const stepOf = (rule, amount) => ({
  rule_id: rule.id,
  code: rule.code ?? null,
  name: rule.name,
  kind: rule.kind,
  value: Number(rule.value),
  method: rule.method,
  amount,
});

function withBillDiscounts(lines, steps) {
  return lines.map((line, index) => {
    const taken = steps.flatMap(({ rule, shares }) =>
      shares.filter((s) => s.index === index).map((s) => stepOf(rule, s.share)),
    );
    const billDiscount = taken.reduce((sum, step) => sum + step.amount, 0);
    const { refused_codes: _refused, ...rest } = line;
    return {
      line_no: index + 1,
      ...rest,
      discount: line.discount + billDiscount,
      patient_payable: line.patient_payable - billDiscount,
      bill_discount: billDiscount,
      bill_discounts: taken,
    };
  });
}

const takenBy = (ruleId, lines) =>
  lines.reduce(
    (sum, line) =>
      sum +
      [...line.discounts, ...line.bill_discounts]
        .filter((step) => step.rule_id === ruleId)
        .reduce((total, step) => total + step.amount, 0),
    0,
  );

const roundToRupee = (amount) => Math.floor((amount + 50) / 100) * 100;

function totalsOf(lines) {
  const totals = Object.fromEntries(
    TOTALS.map((key) => [key, lines.reduce((sum, line) => sum + line[key], 0)]),
  );
  const payable = roundToRupee(totals.patient_payable);
  return { ...totals, round_off: payable - totals.patient_payable, payable };
}

const appointmentVisitType = (appointment) =>
  appointment ? (billingVisitType(appointment.visit_type) ?? NO_CONSULTATION_VISIT) : null;

export async function priceBill(input = {}, source = pool) {
  if (!isObject(input)) throw httpError(400, "A bill must be an object");
  const db = readOnce(source);
  const lineList = cleanLines(input.lines);
  const codes = cleanCodes(input.codes);
  const date = cleanDate(input.date, "Date") ?? indiaToday();
  const settings = await getSettings(db);
  const who = await billWho(input, date, db);
  const category = who.category?.code ?? null;
  const visitType = input.visitType ?? appointmentVisitType(who.appointment);
  const doctorId = input.doctorId ?? who.appointment?.doctor_id ?? null;
  const draftRule = cleanDraftRule(input.draftRule);
  const base = { category, date, patient: who.patient, role: input.role, settings, draftRule };
  const lineInputs = lineList.map((line) => ({
    ...base,
    item: line.item,
    quantity: line.quantity,
    visitType: line.visitType ?? visitType,
    doctorId: line.doctorId ?? doctorId,
  }));
  const context = { category, patient: who.patient, date, role: input.role, codesOnBill: 0 };
  const { admitted, refused, priced, lineCodes } = await admitCodes(
    { codes, context, lineInputs, settings },
    db,
  );
  const settled = await settleLineCodes({ priced, lineInputs, lineCodes, admitted }, db);
  const billRules = [
    ...(await autoRulesFor(null, context, db)),
    ...admitted.filter(({ rule }) => rule.applies_per === "bill").map(({ rule }) => rule),
  ];
  const unique = [
    ...new Map(
      billRules.filter((rule) => !wholeBillPrice(rule)).map((rule) => [rule.id, rule]),
    ).values(),
  ];
  const steps = billSteps(unique, settled, settings.discount_stacking);
  const lines = withBillDiscounts(settled, steps);
  lines.forEach(assertBillLineBalances);
  const totals = totalsOf(lines);
  if (totals.claim > 0 && !who.category?.payer_name) {
    throw httpError(
      409,
      `${who.category?.display_label ?? "This category"} has no payer name, so its claim can't be billed; add a payer name to the category or its parent first`,
    );
  }
  return {
    date,
    patient: who.patient,
    category: who.category,
    payer_name: who.category?.payer_name ?? null,
    warnings: who.warnings,
    visit_type: visitType,
    doctor_id: doctorId,
    appointment_id: who.appointment?.id ?? null,
    settings: {
      discount_stacking: settings.discount_stacking,
      gst_enabled: settings.gst_enabled,
      max_codes_per_bill: settings.max_codes_per_bill,
    },
    lines,
    applied_codes: admitted.map(({ code, rule }) => ({
      code,
      rule_id: rule.id,
      name: rule.name,
      applies_per: rule.applies_per,
      amount: takenBy(rule.id, lines),
    })),
    refused_codes: refused,
    bill_discounts: steps.map(({ rule, amount, shares }) => ({
      ...stepOf(rule, amount),
      line_nos: shares.map((s) => s.index + 1),
    })),
    totals,
  };
}
