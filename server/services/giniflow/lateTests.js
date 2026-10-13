import { BACK_FOR_TESTS, isTerminalStatus } from "../../../shared/giniflowStatus.js";
import { machineForTest } from "../../../shared/machineStages.js";
import { LAB_TEST_STEP_IDS } from "../../../shared/journeyOrder.js";
import { advanceStatus } from "./statusEngine.js";
import { getMachines } from "./machineCatalog.js";
import { TESTS_HOLD_SQL } from "./testsHold.js";

export const LATE_TRIGGERS = ["scribe_order", "healthray_case", "healthray_bill", "reception"];

export async function stepIdsForOrders(client, orderIds) {
  if (!orderIds?.length) return [];
  const { rows } = await client.query(
    `SELECT o.kind, COALESCE(array_agg(t.test_name) FILTER (WHERE t.test_name IS NOT NULL), '{}') AS tests
       FROM giniflow_lab_orders o
       LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.id = ANY($1::uuid[])
      GROUP BY o.id, o.kind`,
    [orderIds],
  );
  const machines = rows.some((r) => r.kind === "machine") ? await getMachines(client) : [];
  const ids = rows.flatMap((r) =>
    r.kind === "machine"
      ? r.tests.map((name) => machineForTest(machines, name)?.id).filter(Boolean)
      : LAB_TEST_STEP_IDS,
  );
  return [...new Set(ids)];
}

async function placeStepsAtEnd(client, visitId, stepIds) {
  if (!stepIds.length) return [];
  const { rows: plan } = await client.query(
    `SELECT id, step_catalog_id, status, step_order FROM giniflow_visit_steps
      WHERE visit_id = $1 ORDER BY step_order`,
    [visitId],
  );
  const { rows: catalog } = await client.query(
    `SELECT id, name, default_duration_min, station, assigned_role, chain_status
       FROM flow_step_catalog WHERE id = ANY($1)`,
    [stepIds],
  );
  let next = (plan.at(-1)?.step_order ?? 0) + 1;
  const placed = [];
  for (const id of stepIds) {
    const existing = plan.find((s) => s.step_catalog_id === id);
    if (existing && ["pending", "in_progress"].includes(existing.status)) continue;
    if (existing) {
      await client.query(
        `UPDATE giniflow_visit_steps
            SET status = 'pending', started_at = NULL, completed_at = NULL,
                source = 'auto', step_order = $2
          WHERE id = $1`,
        [existing.id, next++],
      );
      placed.push(id);
      continue;
    }
    const c = catalog.find((row) => row.id === id);
    if (!c) continue;
    await client.query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
          station, assigned_role, chain_status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto')`,
      [
        visitId,
        next++,
        c.id,
        c.name,
        c.default_duration_min,
        c.station,
        c.assigned_role,
        c.chain_status,
      ],
    );
    placed.push(id);
  }
  return placed;
}

export async function reopenForTests(
  client,
  visitId,
  { trigger, tests = [], orderIds = [], stepIds = null, actorRole = "system", actorId = null },
) {
  if (!LATE_TRIGGERS.includes(trigger)) throw new Error(`Unknown late-test trigger: ${trigger}`);
  const { rows } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
    [visitId],
  );
  const status = rows[0]?.current_status;
  const closed = isTerminalStatus(status);
  if (!closed && status !== BACK_FOR_TESTS) return { reopened: false, steps: [] };

  const steps = await placeStepsAtEnd(
    client,
    visitId,
    stepIds ?? (await stepIdsForOrders(client, orderIds)),
  );
  if (closed) {
    await advanceStatus(client, {
      visitId,
      toStatus: BACK_FOR_TESTS,
      actorRole,
      actorId,
      meta: { source: "late_tests", trigger, tests, orderIds, steps },
    });
  }
  return { reopened: closed, steps };
}

export async function sweepLateTestExits(client, day) {
  const { rows } = await client.query(
    `SELECT v.id FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = $1::date AND v.current_status = $2
        AND (SELECT h.tests_pending FROM (${TESTS_HOLD_SQL("v", "p")}) h) = 0`,
    [day, BACK_FOR_TESTS],
  );
  let closed = 0;
  for (const row of rows) {
    try {
      await client.query("BEGIN");
      await advanceStatus(client, {
        visitId: row.id,
        toStatus: "exited",
        actorRole: "system",
        meta: { source: "late_tests", reason: "late_tests_done" },
      });
      await client.query("COMMIT");
      closed += 1;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[giniflow] late tests sweep:", row.id, e.message);
    }
  }
  return closed;
}
