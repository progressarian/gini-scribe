// Resilient re-import: health-checks server before each request, waits if
// server is restarting, retries failures, paces patients to keep Puppeteer
// memory under control.
import "dotenv/config";
import pg from "pg";

const { DATABASE_URL } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

async function serverUp() {
  try {
    const r = await fetch("http://localhost:3001/api/sync/debug/labs/P_179753", {
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForServer(maxSec = 60) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSec) {
    if (await serverUp()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function importForPatient(fn, attempt = 1) {
  if (!(await serverUp())) {
    process.stdout.write(" [server down, waiting...] ");
    if (!(await waitForServer(120))) {
      return { error: "server still down after 120s" };
    }
  }
  try {
    const r = await fetch(
      `http://localhost:3001/api/sync/lab/import-pdf?file_no=${encodeURIComponent(fn)}`,
      { method: "POST", signal: AbortSignal.timeout(420000) }, // 7 min
    );
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    const cs = j.cases || [];
    return {
      dl: cs.filter((x) => x.status === "downloaded").length,
      sk: cs.filter((x) => x.status === "skipped").length,
      er: cs.filter((x) => x.status === "error").length,
    };
  } catch (e) {
    if (attempt === 1 && e.name !== "TimeoutError") {
      // server probably crashed mid-flight; wait + retry once
      process.stdout.write(" [crash, retry once] ");
      if (await waitForServer(120)) return importForPatient(fn, 2);
    }
    return { error: `${e.name}: ${e.message}` };
  }
}

const { rows } = await pool.query(
  `SELECT DISTINCT p.file_no
     FROM lab_cases lc
     JOIN patients p ON p.id = lc.patient_id
    WHERE lc.case_date::date BETWEEN DATE '2026-04-26' AND DATE '2026-04-30'
      AND lc.pdf_storage_path IS NULL
    ORDER BY p.file_no`,
);

const fileNos = rows.map((r) => r.file_no);
console.log(`patients still pending re-import: ${fileNos.length}\n`);

const failed = [];
let totalDl = 0,
  totalSk = 0,
  totalEr = 0;

for (let i = 0; i < fileNos.length; i++) {
  const fn = fileNos[i];
  process.stdout.write(`[${i + 1}/${fileNos.length}] ${fn} ... `);
  const t0 = Date.now();
  const r = await importForPatient(fn);
  const dt = Math.round((Date.now() - t0) / 1000);
  if (r.error) {
    console.log(`FAIL ${r.error} (${dt}s)`);
    failed.push(fn);
  } else {
    totalDl += r.dl;
    totalSk += r.sk;
    totalEr += r.er;
    console.log(`dl=${r.dl} sk=${r.sk} er=${r.er} (${dt}s)`);
  }
  // Pause to let Puppeteer release memory between patients
  await new Promise((r) => setTimeout(r, 3000));
}

console.log(
  `\nFirst pass: downloaded=${totalDl} skipped=${totalSk} per-case-errors=${totalEr} patient-failures=${failed.length}`,
);

// Retry pass
if (failed.length) {
  console.log(`\nRetrying ${failed.length} failed patients...\n`);
  const stillFailed = [];
  for (let i = 0; i < failed.length; i++) {
    const fn = failed[i];
    process.stdout.write(`[retry ${i + 1}/${failed.length}] ${fn} ... `);
    const r = await importForPatient(fn);
    if (r.error) {
      console.log(`FAIL ${r.error}`);
      stillFailed.push(fn);
    } else {
      totalDl += r.dl;
      totalSk += r.sk;
      totalEr += r.er;
      console.log(`dl=${r.dl} sk=${r.sk} er=${r.er}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`\nStill-failed after retry: ${stillFailed.length}`);
  for (const fn of stillFailed) console.log(`  ${fn}`);
}

console.log(
  `\nFINAL  downloaded=${totalDl}  skipped=${totalSk}  per-case-errors=${totalEr}`,
);

await pool.end();
