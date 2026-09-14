import "../loadEnv.js";
import pool from "../config/db.js";
import { getMachines, clearMachineCache } from "../services/giniflow/machineCatalog.js";
import { getMachineQueue } from "../services/giniflow/machineStation.js";
import { suggestedRows } from "../services/giniflow/labResults.js";
import { defaultPlan } from "../services/giniflow/journey.js";
import {
  machineFor,
  machineForTest,
  machineHandsOver,
  machinesOnBillLine,
} from "../../shared/machineStages.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const EXPECTED = [
  ["abi", "ABI", 10, ["ABI"]],
  ["vpt", "VPT", 5, ["VPT"]],
  ["fundus", "Fundus", 10, ["Fundus"]],
  ["tmt", "TMT", 20, ["TMT"]],
  ["ecg", "ECG", 5, ["ECG"]],
  ["echo", "2D Echo", 20, ["2D Echo", "Echo", "Echocardiography"]],
];

const REAL_BILL_LINES = [
  ["ABI,VPT", ["abi", "vpt"]],
  ["ECG", ["ecg"]],
  ["2D Echo", ["echo"]],
  ["TMT", ["tmt"]],
  ["Microalbumin/Creatinine Ratio", []],
  ["Follow-up Appointment - Dr. Anil Bhansali", []],
];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  clearMachineCache();
  const machines = await getMachines(client);

  console.log("\n── The catalogue ───────────────────────────────────────────");
  check(
    "the six machines, in Machine Room order",
    machines.map((m) => m.id).join(" ") === EXPECTED.map(([id]) => id).join(" "),
    machines.map((m) => m.id).join(" "),
  );
  for (const [id, name, minutes, bill] of EXPECTED) {
    const m = machineFor(machines, id);
    check(
      `${id}: name, duration and bill names`,
      m?.name === name && m?.durationMin === minutes && m?.tests.join("|") === bill.join("|"),
      m ? `${m.name} · ${m.durationMin}m · ${m.tests.join("|")}` : "missing",
    );
  }
  check(
    "each machine has an icon, a report type and value fields",
    machines.every((m) => m.icon && m.docTypes.length && m.values.length),
  );
  check(
    "only ECG closes without a report",
    machines
      .filter((m) => machineHandsOver(machines, m.id))
      .map((m) => m.id)
      .join(" ") === "ecg",
  );
  const billNames = machines.flatMap((m) => m.tests.map((t) => t.toLowerCase()));
  check("no bill name belongs to two machines", new Set(billNames).size === billNames.length);
  const { rows: priced } = await client.query(
    `SELECT test_name FROM giniflow_test_catalog WHERE category = 'machine' AND is_active`,
  );
  check(
    "every machine bills against a priced test",
    machines.every((m) =>
      priced.some((p) => p.test_name.toLowerCase() === m.tests[0].toLowerCase()),
    ),
  );

  console.log("\n── Reading bills ───────────────────────────────────────────");
  for (const [line, ids] of REAL_BILL_LINES) {
    const got = machinesOnBillLine(machines, line);
    check(
      `"${line}" → ${ids.join(", ") || "no machine"}`,
      got.join(" ") === ids.join(" "),
      got.join(" "),
    );
  }
  check(
    "an order test resolves back to its machine",
    machineForTest(machines, "2D Echo")?.id === "echo",
  );

  console.log("\n── Readers ─────────────────────────────────────────────────");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const queue = await getMachineQueue(today, null, client);
  check(
    "Machine Room tabs come from the catalogue",
    queue.machines.map((m) => m.id).join(" ") === machines.map((m) => m.id).join(" "),
  );
  const plan = await defaultPlan("NEW_APPT", client);
  check(
    "journey templates carry the machine flag",
    plan.every((p) => typeof p.machine === "boolean"),
  );
  const { rows: tmt } = await client.query(
    `SELECT o.id FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.kind = 'machine' AND t.test_name = 'TMT' LIMIT 1`,
  );
  if (tmt[0]) {
    const rows = (await suggestedRows(tmt[0].id, client)).flatMap((g) =>
      g.params.map((p) => p.testName),
    );
    check(
      "a TMT values form opens on its catalogue fields",
      rows[0] === "TMT Result",
      rows.join(", "),
    );
  }
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll machine catalogue checks passed");
process.exit(failures ? 1 : 0);
