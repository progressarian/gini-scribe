// Patient outcome report — "how many patients are doing fine, and who isn't".
//
// Reuses the app's own building blocks so the report cannot drift from the
// dashboard's clinical logic:
//   - server/utils/labNormalization.js  → lab test name → canonical name
//   - src/utils/biomarkerClassify.js    → the verdict rules themselves
//
// Values are sourced the same way the OPD dashboard sources them: today's
// reading from this visit's appointment JSON + labs dated on/around the visit,
// and the comparison reading from the most recent earlier lab or visit.
//
// Usage: node scripts/patient-outcome-report.mjs [YYYY-MM-DD] [out.md]

import fs from "fs";
import pg from "pg";
import dotenv from "dotenv";
import { normalizeTestName } from "../server/utils/labNormalization.js";
import { classifyBiomarker, classifyComposite, targetStatus } from "../src/utils/biomarkerClassify.js";

dotenv.config({ quiet: true });

const DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
const OUT = process.argv[3] || `docs/PATIENT_OUTCOMES_${DATE}.md`;

// canonical lab name → biomarker key used by the classifier
const LAB_TO_KEY = {
  HbA1c: "hba1c",
  FBS: "fg",
  PPBS: "ppbs",
  LDL: "ldl",
  Triglycerides: "tg",
  HDL: "hdl",
  UACR: "uacr",
  eGFR: "egfr",
  TSH: "tsh",
};
// appointment.biomarkers uses its own key spellings
const APPT_TO_KEY = { bpSys: "sbp", bpDia: "dbp", fg: "fg", hba1c: "hba1c", ldl: "ldl",
  tg: "tg", hdl: "hdl", uacr: "uacr", egfr: "egfr", tsh: "tsh", ppbs: "ppbs" };

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();
const q = async (s, p) => (await client.query(s, p)).rows;

const appts = await q(
  `SELECT a.id, a.patient_id, a.patient_name, a.status, a.doctor_name, a.time_slot,
          a.biomarkers, p.file_no
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
    WHERE a.appointment_date::date = $1
    ORDER BY a.time_slot NULLS LAST`,
  [DATE],
);
if (!appts.length) {
  console.error(`No appointments on ${DATE}`);
  await client.end();
  process.exit(1);
}
const pids = [...new Set(appts.map((a) => a.patient_id).filter(Boolean))];

// Labs: everything up to and including the report date, newest first.
const labs = await q(
  `SELECT patient_id, test_name, result, to_char(test_date::date,'YYYY-MM-DD') AS d
     FROM lab_results
    WHERE patient_id = ANY($1::int[]) AND test_date::date <= $2
    ORDER BY test_date DESC NULLS LAST`,
  [pids, DATE],
);
// Earlier visits' biomarkers, newest first.
const hist = await q(
  `SELECT patient_id, biomarkers, to_char(appointment_date::date,'YYYY-MM-DD') AS d
     FROM appointments
    WHERE patient_id = ANY($1::int[]) AND appointment_date::date < $2
      AND biomarkers IS NOT NULL AND biomarkers::text <> '{}'
    ORDER BY appointment_date DESC`,
  [pids, DATE],
);

// Build per-patient timelines: key → [{val, date}] newest first.
const series = {};
const push = (pid, key, val, d) => {
  const n = num(val);
  if (n == null || !key) return;
  ((series[pid] ||= {})[key] ||= []).push({ val: n, date: d ? String(d) : "" });
};
for (const l of labs) push(l.patient_id, LAB_TO_KEY[normalizeTestName(l.test_name)], l.result, l.d);
for (const h of hist)
  for (const [k, v] of Object.entries(h.biomarkers || {}))
    push(h.patient_id, APPT_TO_KEY[k], v, h.d);

const rows = appts.map((a) => {
  const s = series[a.patient_id] || {};
  const cur = {}, prev = {};
  // This visit's own vitals win for BP — they were taken today.
  for (const [k, v] of Object.entries(a.biomarkers || {})) {
    const key = APPT_TO_KEY[k];
    if (key && num(v) != null) cur[key] = num(v);
  }
  for (const [key, list] of Object.entries(s)) {
    const sorted = [...list].sort((x, y) => y.date.localeCompare(x.date)); // ISO strings, newest first
    if (cur[key] == null && sorted[0]) cur[key] = sorted[0].val;
    const older = sorted.find((e) => e.val !== cur[key]);
    if (older) prev[key] = older.val;
  }
  const per = {};
  for (const key of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
    const c = cur[key] ?? null, p = prev[key] ?? null;
    if (c == null && p == null) continue;
    per[key] = { cur: c, prev: p, status: c != null && p != null ? classifyBiomarker(key, c, p) : "unknown" };
  }
  const anyTrend = Object.values(per).some((v) => v.status !== "unknown");
  const comp = classifyComposite(per);
  const outcome = anyTrend ? comp.outcome : "single";
  const offTarget = Object.entries(cur)
    .filter(([k, v]) => targetStatus(k, v) === "bad")
    .map(([k]) => k.toUpperCase());
  return { ...a, cur, prev, outcome, reason: comp.reasons[0] || "", offTarget };
});

// ── Grouping: is this patient fine, or not? ──────────────────────────────
// "Fine" = nothing deteriorating AND nothing currently off target.
const attended = rows.filter((r) => !["cancelled", "no_show"].includes(r.status || ""));
const group = (r) => {
  if (r.outcome === "worse") return "worse";
  if (r.outcome === "mixed") return "mixed";
  if (r.offTarget.length) return "offtarget";
  if (r.outcome === "better") return "better";
  if (r.outcome === "stable") return "stable";
  if (!Object.keys(r.cur).length) return "nodata";
  return "firstreading";
};
const G = {};
for (const r of attended) (G[group(r)] ||= []).push(r);
const n = (k) => (G[k] || []).length;

const fine = n("better") + n("stable") + n("firstreading");
const notFine = n("worse") + n("mixed") + n("offtarget");
const pct = (x) => (attended.length ? Math.round((x / attended.length) * 100) : 0);

const fmtVals = (r) =>
  ["hba1c", "sbp", "fg", "ldl", "tg", "uacr", "egfr"]
    .filter((k) => r.cur[k] != null)
    .slice(0, 4)
    .map((k) => {
      const lbl = { hba1c: "HbA1c", sbp: "BP", fg: "FBS", ldl: "LDL", tg: "TG", uacr: "UACR", egfr: "eGFR" }[k];
      const arrow = r.prev[k] != null ? `${r.prev[k]} → ` : "";
      return `${lbl} ${arrow}${r.cur[k]}`;
    })
    .join(" · ");

const table = (list, withReason = true) =>
  !list?.length
    ? "_None._\n"
    : "| Patient | File | Readings |" + (withReason ? " Why |" : "") + "\n|---|---|---|" +
      (withReason ? "---|" : "") + "\n" +
      list
        .map((r) => `| ${r.patient_name || "—"} | ${r.file_no || "—"} | ${fmtVals(r) || "—"} |` +
          (withReason ? ` ${r.reason || (r.offTarget.length ? r.offTarget.join(", ") + " off target" : "—")} |` : ""))
        .join("\n") + "\n";

const md = `# Patient Outcomes — ${DATE}

Auto-generated from the clinic database using the same rules the OPD dashboard
uses. Cancelled and no-show patients are excluded from all percentages.

**${attended.length} patients attended** (of ${rows.length} booked).

---

## The short answer

| | Patients | Share |
|---|---|---|
| ✅ **Doing fine** | **${fine}** | ${pct(fine)}% |
| ⚠️ **Not fine — needs attention** | **${notFine}** | ${pct(notFine)}% |
| ❔ No readings on file | ${n("nodata")} | ${pct(n("nodata"))}% |

### How that breaks down

| Group | Count | Meaning |
|---|---|---|
| 📉 Getting worse | ${n("worse")} | A main test (HbA1c / BP / TSH) has deteriorated |
| ⚠️ Mixed signals | ${n("mixed")} | Something improved while something else worsened |
| 🔴 Off target | ${n("offtarget")} | Not deteriorating, but a value is outside its safe range |
| 📈 Getting better | ${n("better")} | Main tests improved, nothing else worsening |
| ➖ Stable | ${n("stable")} | No meaningful change since last time |
| 🆕 First reading | ${n("firstreading")} | Nothing to compare against yet |
| ❔ No readings | ${n("nodata")} | Nothing on file — cannot be judged |

---

## ⚠️ Not fine — act on these

### 📉 Getting worse (${n("worse")})

${table(G.worse)}
### ⚠️ Mixed signals (${n("mixed")})

Improving on one measure, worsening on another. **Do not record these as "improving" without a doctor's review.**

${table(G.mixed)}
### 🔴 Off target (${n("offtarget")})

Not deteriorating, but currently outside the safe range on at least one test.

${table(G.offtarget)}
---

## ✅ Doing fine

### 📈 Getting better (${n("better")})

${table(G.better)}
### ➖ Stable (${n("stable")})

No meaningful change. **Stable does not mean at target** — check the numbers.

${table(G.stable, false)}
### 🆕 First reading (${n("firstreading")})

Today's values become the baseline for next time.

${table(G.firstreading, false)}
${n("nodata") ? `---\n\n## ❔ No readings on file (${n("nodata")})\n\nThese patients cannot be judged either way — the gap is the action.\n\n${table(G.nodata, false)}` : ""}
---

## How to read this

- **"Fine"** means nothing is deteriorating *and* nothing is currently outside its safe range.
- **"Not fine"** covers three different problems: something got worse, signals disagree, or a value is off target even though it hasn't moved.
- A patient counted as **stable** can still be above target — stability is about *change*, not *safety*.
- Comparisons use each test's own previous reading, which may be from a different date than the others.
- Cancelled and no-show patients are excluded, since no clinical judgement is possible for them.

_Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from \`scripts/patient-outcome-report.mjs\`._
`;

fs.writeFileSync(OUT, md);
console.log(`${OUT}
  attended       ${attended.length} / ${rows.length} booked
  fine           ${fine} (${pct(fine)}%)
  not fine       ${notFine} (${pct(notFine)}%)
    worse        ${n("worse")}
    mixed        ${n("mixed")}
    off target   ${n("offtarget")}
  better         ${n("better")}
  stable         ${n("stable")}
  first reading  ${n("firstreading")}
  no readings    ${n("nodata")}`);
await client.end();
