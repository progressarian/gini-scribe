import "../loadEnv.js";
import pool from "../config/db.js";
import { sweepOutsideStage } from "../services/giniflow/outsideStage.js";

const COMMIT = process.argv.includes("--commit");

try {
  const result = await sweepOutsideStage(pool, {
    dryRun: !COMMIT,
    pauseMs: COMMIT ? 200 : 0,
    onBatch: ({ done, of, changed }) =>
      console.log(`${COMMIT ? "Saved" : "Would save"} ${changed} in batch — ${done}/${of} cases`),
  });
  console.log(
    `${COMMIT ? "Done" : "Dry run"}: ${result.fixed} of ${result.checked} case(s) ${COMMIT ? "given" : "need"} a stage change.`,
  );
  if (!COMMIT) console.log("Run again with --commit to save.");
} finally {
  await pool.end();
}
