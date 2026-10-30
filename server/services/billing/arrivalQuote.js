import pool from "../../config/db.js";
import { withoutChief } from "../../../shared/directConsult.js";
import { machineFor } from "../../../shared/machineStages.js";
import { carryOverChoices } from "../giniflow/carryOver.js";
import {
  AUTO_LAB_BILLING_SQL,
  billedLabTestsOf,
  labTestsOf,
  VISIT_DIRECT_CONSULT_SQL,
} from "../giniflow/journey.js";
import { getMachines } from "../giniflow/machineCatalog.js";
import { stepsAllowedByBill, storedBill } from "../giniflow/patientBill.js";
import { schemeForVisit, testPricesFor, testPricesForVisit } from "../pricing.js";
import { priceUnsavedDraft } from "./bills.js";
import { healthrayQuoteLines } from "./healthrayBillLines.js";
import { outsourcedTestNames, TEST_MATCHES_SQL } from "./testMatch.js";
import { consultationItem } from "./visitLines.js";

const NOT_ARRIVED = ["booked", "no_show", "cancelled"];

const CLEAN_SLATE_SQL = `
  SELECT v.current_status, v.patient_id, v.visit_date::text AS visit_date, v.appointment_id,
         v.assigned_doctor_id, v.visit_type_id, a.visit_type,
         COALESCE(a.doctor_id,
                  (SELECT d.id FROM doctors d
                    WHERE lower(btrim(d.name)) = lower(btrim(a.doctor_name))
                    ORDER BY d.is_active IS NOT FALSE DESC, d.id LIMIT 1)) AS appointment_doctor_id,
         ${VISIT_DIRECT_CONSULT_SQL} AS direct_consult,
         (EXISTS (SELECT 1 FROM bills b WHERE b.visit_id = v.id)
          OR EXISTS (SELECT 1 FROM giniflow_lab_orders o WHERE o.visit_id = v.id)
          OR EXISTS (SELECT 1 FROM giniflow_visit_steps s WHERE s.visit_id = v.id)
          OR EXISTS (SELECT 1 FROM lab_cases lc
                      WHERE lc.case_date = v.visit_date
                        AND (lc.patient_id = v.patient_id
                             OR (lc.patient_id IS NULL
                                 AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))))
           AS has_history
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN appointments a ON a.id = v.appointment_id
   WHERE v.id = $1`;

const asList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const itemIds = (value) => [...new Set(asList(value).map(Number))].filter(Number.isInteger);

class JourneyRefused extends Error {}

async function cleanSlate(db, visitId) {
  const { rows } = await db.query(CLEAN_SLATE_SQL, [visitId]);
  const visit = rows[0];
  if (!visit || !NOT_ARRIVED.includes(visit.current_status) || visit.has_history) return null;
  if ((await carryOverChoices(visitId, db)).length) return null;
  return visit;
}

async function journeyTests(db, visitId, visit, steps) {
  const bill = await storedBill(visit.patient_id, visit.visit_date, db);
  const machines = await getMachines(db);
  const allowed = stepsAllowedByBill(steps, bill, machines);
  const routed = visit.direct_consult ? withoutChief(allowed) : allowed;
  const billed = billedLabTestsOf(routed);
  const picked = labTestsOf(routed).filter((name) => !billed.has(name));
  const lab = [...picked, ...billed.keys()];
  if (picked.length) {
    const priceOf = await testPricesFor(picked, await schemeForVisit(visitId, db), db);
    const unknown = picked.filter((name) => priceOf[name] === undefined);
    if (unknown.length)
      throw new JourneyRefused(`Not in the test catalogue: ${unknown.join(", ")}`);
  }
  const outsourced = await outsourcedTestNames(db, lab);
  const tests = [
    ...lab.filter((name) => !outsourced.has(name)),
    ...lab.filter((name) => outsourced.has(name)),
  ];
  const routedMachines = routed
    .map((step) => (step.catalogId ? machineFor(machines, step.catalogId) : null))
    .filter(Boolean);
  const machinePrices = await testPricesForVisit(
    visitId,
    routedMachines.map((machine) => machine.tests[0]),
    db,
  );
  for (const machine of routedMachines) {
    const price = Number(machinePrices[machine.tests[0]] ?? 0);
    if (!(price > 0)) {
      throw new JourneyRefused(
        `${machine.name} has no price in the test catalogue — an admin must add it under Settings → Flow → Test catalogue before it can be billed`,
      );
    }
    if (!tests.includes(machine.tests[0])) tests.push(machine.tests[0]);
  }
  return { tests, billed: new Set(billed.keys()), steps: routed };
}

async function journeyDoctor(db, steps) {
  const picks = steps
    .map((step, order) => ({
      catalogId: step.catalogId,
      staffId: String(step.staffId ?? ""),
      order,
    }))
    .filter((step) => step.catalogId && /^\d+$/.test(step.staffId));
  if (!picks.length) return null;
  const { rows } = await db.query(
    `SELECT d.id
       FROM unnest($1::text[], $2::int[], $3::int[]) AS p(catalog_id, staff_id, n)
       JOIN flow_step_catalog c ON c.id = p.catalog_id AND c.chain_status = 'with_doctor'
       JOIN doctors d ON d.id = p.staff_id
      ORDER BY COALESCE(d.is_chief, FALSE) DESC, p.catalog_id = 'sd_consult' DESC, p.n
      LIMIT 1`,
    [picks.map((p) => p.catalogId), picks.map((p) => Number(p.staffId)), picks.map((p) => p.order)],
  );
  return rows[0]?.id ?? null;
}

async function journeyVisitType(db, visitTypeId) {
  if (!visitTypeId) return null;
  const { rows } = await db.query(
    `SELECT CASE WHEN for_followup THEN 'Follow Up' ELSE 'New' END AS visit_type
       FROM flow_visit_types WHERE id = $1`,
    [visitTypeId],
  );
  return rows[0]?.visit_type ?? null;
}

async function testItems(db, names) {
  if (!names.length) return [];
  const { rows } = await db.query(
    `SELECT m.test_name, i.id
       FROM (${TEST_MATCHES_SQL("$1::text[]")}) m
       JOIN service_items i ON i.test_catalog_id = m.catalog_id AND i.is_active`,
    [names],
  );
  const byName = new Map(rows.map((row) => [row.test_name, row.id]));
  return names.map((name) => ({ name, id: byName.get(name) })).filter((test) => test.id);
}

async function itemFacts(db, ids) {
  const { rows } = await db.query(
    `SELECT id, name, kind, is_active FROM service_items WHERE id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function plannedLines(db, visitId, visit, { plan, add, remove }) {
  let journey = { tests: [], billed: new Set(), steps: [] };
  let journeyNote = null;
  if (plan) {
    try {
      journey = await journeyTests(db, visitId, visit, asList(plan.steps));
    } catch (error) {
      if (!(error instanceof JourneyRefused)) throw error;
      journeyNote = error.message;
    }
  }
  const journeyHeld = !journeyNote && plan;
  const doctorId = journeyHeld ? await journeyDoctor(db, journey.steps) : null;
  const visitTypeId = journeyHeld ? (plan.visitTypeId ?? visit.visit_type_id) : visit.visit_type_id;
  const consultation = await consultationItem(db, {
    ...visit,
    journey_doctor_id: doctorId,
    journey_visit_type: visit.appointment_id ? null : await journeyVisitType(db, visitTypeId),
  });
  if (consultation?.removed) return null;

  const lines = [];
  const has = (itemId) => lines.some((line) => line.service_item_id === itemId);
  for (const { name, id } of await testItems(db, journey.tests)) {
    if (!has(id)) {
      lines.push({
        service_item_id: id,
        doctor_id: null,
        test: true,
        billed: journey.billed.has(name),
      });
    }
  }
  if (consultation && !has(consultation.id)) {
    lines.push({
      service_item_id: consultation.id,
      doctor_id: consultation.doctor_id ?? consultation.chosen_doctor_id,
    });
  }
  const healthray = await healthrayQuoteLines(db, visitId, visit);
  for (const due of healthray.due) {
    const at = lines.findIndex((line) => line.service_item_id === due.itemId);
    if (at < 0) {
      lines.push({
        service_item_id: due.itemId,
        doctor_id: null,
        agreed_rate: due.agreedRate,
        fromHealthray: true,
      });
    } else if (lines[at].billed) {
      lines[at] = { ...lines[at], agreed_rate: due.agreedRate };
    }
  }
  const dropped = new Set(itemIds(remove));
  const kept = lines.filter((line) => !dropped.has(line.service_item_id));
  for (const itemId of itemIds(add)) {
    if (!kept.some((line) => line.service_item_id === itemId)) {
      kept.push({ service_item_id: itemId, doctor_id: null, added: true });
    }
  }
  const deskChanged = kept.length !== lines.length || kept.some((line) => line.added);
  return {
    lines: kept,
    journeyNote,
    notMatched: healthray.notMatched,
    byDesk: Boolean(consultation) || deskChanged,
  };
}

export async function journeyAddsTests(db, steps) {
  if (labTestsOf(steps).length || billedLabTestsOf(steps).size) return true;
  const machines = await getMachines(db);
  return steps.some((step) => step.catalogId && machineFor(machines, step.catalogId));
}

export async function journeyConsultation(db, visitId, plan) {
  const { rows } = await db.query(
    `SELECT v.appointment_id, v.visit_type_id, ${VISIT_DIRECT_CONSULT_SQL} AS direct_consult,
            EXISTS (SELECT 1 FROM giniflow_visit_steps s
                     WHERE s.visit_id = v.id AND NOT ${AUTO_LAB_BILLING_SQL("s")}) AS planned
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  const visit = rows[0];
  if (!visit) return null;
  const steps = visit.direct_consult ? withoutChief(asList(plan.steps)) : asList(plan.steps);
  return {
    doctorId: visit.planned ? null : await journeyDoctor(db, steps),
    visitType: visit.appointment_id
      ? null
      : await journeyVisitType(db, plan.visitTypeId ?? visit.visit_type_id),
  };
}

const asPricing = (lines) =>
  lines.map((line) => ({
    service_item_id: line.service_item_id,
    quantity: 1,
    doctor_id: line.doctor_id,
    agreed_rate: line.agreed_rate ?? null,
  }));

export async function arrivalQuote(visitId, { add, remove, plan } = {}, ctx = {}, db = pool) {
  const visit = await cleanSlate(db, visitId);
  if (!visit) return null;
  const planned = await plannedLines(db, visitId, visit, { plan, add, remove });
  if (!planned) return null;
  const facts = await itemFacts(
    db,
    planned.lines.map((line) => line.service_item_id),
  );
  if (
    planned.lines.some((line) => {
      const item = facts.get(line.service_item_id);
      return (
        !item?.is_active || ((line.added || line.fromHealthray) && item.kind === "consultation")
      );
    })
  ) {
    return null;
  }

  const pricingCtx = planned.byDesk ? ctx : { actorId: ctx.actorId ?? null };
  const price = (list) =>
    list.length ? priceUnsavedDraft(db, visitId, asPricing(list), pricingCtx) : null;
  let lines = planned.lines;
  let priced = await price(lines);
  const missing = priced ? lines.filter((_, index) => priced.lines[index]?.price_missing) : [];
  if (missing.some((line) => !line.test)) return null;
  if (missing.length) {
    lines = lines.filter((line) => !missing.includes(line));
    priced = await price(lines);
  }

  return {
    billId: null,
    lines: lines.map((line, index) => ({
      itemId: line.service_item_id,
      name: facts.get(line.service_item_id).name,
      kind: facts.get(line.service_item_id).kind,
      orderId: null,
      carried: false,
      fromHealthray: Boolean(line.fromHealthray),
      amount: priced.lines[index].patient_payable,
    })),
    outstanding: priced ? priced.totals.payable : 0,
    carry: [],
    notMatched: planned.notMatched,
    quoted: true,
    ...(planned.journeyNote ? { journeyNote: planned.journeyNote } : {}),
  };
}
