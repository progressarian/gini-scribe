import "../loadEnv.js";
import { cronPool } from "../config/db.js";
import { getPatientBase } from "../services/analytics/patientBase.js";
import { getMarkerSummary } from "../services/analytics/markerSeries.js";
import { buildConditionIndex, getDiagnosisRows } from "../services/analytics/conditions.js";
import {
  buildControlByContinuity,
  buildControlCascade,
  buildMarkerControl,
  buildTrajectoryByCondition,
  indexSummary,
} from "../services/analytics/biomarkers.js";

const asOf = process.argv[2] || new Date().toISOString().slice(0, 10);

const [patients, summary, dx] = await Promise.all([
  getPatientBase(cronPool, { asOf }),
  getMarkerSummary(cronPool, { asOf }),
  getDiagnosisRows(cronPool),
]);
const byMarker = indexSummary(summary);
const index = buildConditionIndex(dx);

const control = buildMarkerControl(byMarker, { asOf });
console.log("Marker control and trajectory:\n");
console.log(
  `${"marker".padEnd(12)}${"current".padStart(9)}${"goal%".padStart(8)}${"bord%".padStart(8)}${"off%".padStart(8)}${"paired".padStart(8)}${"impr%".padStart(8)}${"stab%".padStart(8)}${"wors%".padStart(8)}`,
);
for (const r of control.sort((a, b) => a.tier - b.tier || b.patients_current - a.patients_current)) {
  console.log(
    `${r.marker.padEnd(12)}${String(r.patients_current).padStart(9)}${String(r.at_goal_pct).padStart(8)}${String(r.borderline_pct).padStart(8)}${String(r.off_goal_pct).padStart(8)}${String(r.patients_paired).padStart(8)}${String(r.improving_pct).padStart(8)}${String(r.stable_pct).padStart(8)}${String(r.worsening_pct).padStart(8)}`,
  );
}

const cascade = buildControlCascade(byMarker, index, patients, { asOf });
console.log("\nDiabetes control cascade:");
for (const s of cascade.steps) console.log(`  ${s.step.padEnd(34)} ${String(s.patients).padStart(6)}  ${s.share_pct}%`);
console.log("  Bands (of recently tested):");
for (const b of cascade.control_bands) console.log(`    ${b.band.padEnd(30)} ${String(b.patients).padStart(6)}  ${b.share_pct}%`);

const traj = buildTrajectoryByCondition(byMarker, index, ["diabetes", "hypertension", "adiposity", "masld"], {
  markers: ["hba1c", "sbp", "weight", "ldl"],
});
console.log("\nTrajectory by condition:");
console.log(`${"condition".padEnd(14)}${"marker".padEnd(9)}${"paired".padStart(8)}${"impr%".padStart(8)}${"stab%".padStart(8)}${"wors%".padStart(8)}${"medianChg".padStart(11)}`);
for (const r of traj) {
  console.log(
    `${r.condition.padEnd(14)}${r.marker.padEnd(9)}${String(r.patients_paired).padStart(8)}${String(r.improving_pct).padStart(8)}${String(r.stable_pct).padStart(8)}${String(r.worsening_pct).padStart(8)}${String(r.median_change).padStart(11)}`,
  );
}

const cont = buildControlByContinuity(byMarker, patients, { asOf, markers: ["hba1c", "sbp", "ldl"] });
console.log("\nControl by continuity:");
for (const r of cont) console.log(`  ${r.marker.padEnd(8)} ${r.group.padEnd(11)} n=${String(r.patients).padStart(6)} goal=${r.at_goal_pct}% off=${r.off_goal_pct}% median=${r.median}`);

await cronPool.end();
