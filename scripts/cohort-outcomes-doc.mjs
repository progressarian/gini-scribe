// Writes the all-time patient-outcome document (and a full CSV alongside it)
// from the same service that powers the "All-Time Outcomes" OPD tab, so the
// document and the screen can never disagree.
//
// Usage: node scripts/cohort-outcomes-doc.mjs [out.md]

import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const { buildCohort, MARKERS } = await import("../server/services/cohortOutcomes.js");

const OUT = process.argv[2] || "docs/PATIENT_OUTCOMES_ALL_TIME.md";
const CSV = OUT.replace(/\.md$/, "") + ".csv";
const TOP = 40; // named rows per problem group; the CSV carries everyone

const d = await buildCohort();
const pct = (n) => (d.total ? Math.round((n / d.total) * 100) : 0);
const c = (k) => d.counts[k] || 0;
const fmt = (v) => (v == null ? "" : Number.isInteger(v) ? v : Number(v.toFixed(1)));

const vals = (p) =>
  MARKERS.filter((m) => p.cur[m.key] != null)
    .slice(0, 5)
    .map((m) => {
      const prev = p.prev[m.key];
      const arrow = prev != null && prev !== p.cur[m.key] ? `${fmt(prev)} → ` : "";
      return `${m.label} ${arrow}${fmt(p.cur[m.key])}`;
    })
    .join(" · ");

const rank = (p) => p.offTarget.length;
const section = (key, title, blurb) => {
  const list = d.patients.filter((p) => p.group === key).sort((a, b) => rank(b) - rank(a));
  const shown = list.slice(0, TOP);
  return `### ${title} — ${list.length.toLocaleString()} patients

${blurb}

${
  shown.length
    ? `| Patient | File | Readings | Why |
|---|---|---|---|
${shown
  .map(
    (p) =>
      `| ${p.name || "—"} | ${p.file_no || "—"} | ${vals(p) || "—"} | ${
        p.reason ||
        (p.offTarget.length ? p.offTarget.join(", ").toUpperCase() + " off target" : "—")
      } |`,
  )
  .join("\n")}

${list.length > TOP ? `_Showing the ${TOP} most off-target of ${list.length.toLocaleString()}. The full list is in \`${CSV.split("/").pop()}\`._` : ""}`
    : "_None._"
}
`;
};

const coverage = MARKERS.map((m) => {
  const cv = d.coverage[m.key] || {};
  const p = cv.withValue ? Math.round((cv.offTarget / cv.withValue) * 100) : 0;
  return `| ${m.label} | ${(cv.withValue || 0).toLocaleString()} | ${(cv.withTrend || 0).toLocaleString()} | ${
    m.key === "weight" ? "—" : `${(cv.offTarget || 0).toLocaleString()} (${p}%)`
  } |`;
}).join("\n");

const md = `# Patient Outcomes — All Time

**Every patient on record. No date filter.** For each test we take the patient's
**latest reading** and the **one before it**, however far apart those two visits
were, and apply the same rules the OPD Live Dashboard uses.

This is the panel-wide counterpart to the daily dashboard: that page asks *"how
is today's clinic doing?"*, this asks *"how is our whole patient base doing?"*

Live version: **OPD → 🧭 All-Time Outcomes**.

---

## The short answer

**${d.total.toLocaleString()} patients** have at least one reading on file.

| | Patients | Share |
|---|---|---|
| ✅ **Doing fine** | **${d.fine.toLocaleString()}** | ${pct(d.fine)}% |
| ⚠️ **Need attention** | **${d.notFine.toLocaleString()}** | ${pct(d.notFine)}% |

### How that breaks down

| Group | Patients | Share | Meaning |
|---|---|---|---|
| 📉 Getting worse | ${c("worse").toLocaleString()} | ${pct(c("worse"))}% | A main test (HbA1c / SBP / TSH) has deteriorated |
| ⚠️ Mixed signals | ${c("mixed").toLocaleString()} | ${pct(c("mixed"))}% | One thing improved while another worsened |
| 🔴 Off target | ${c("offtarget").toLocaleString()} | ${pct(c("offtarget"))}% | Not deteriorating, but a value is outside its safe range |
| 📈 Getting better | ${c("better").toLocaleString()} | ${pct(c("better"))}% | Main tests improved, nothing else worsening |
| ➖ Stable | ${c("stable").toLocaleString()} | ${pct(c("stable"))}% | No meaningful change between the last two readings |
| 🆕 One reading only | ${c("single").toLocaleString()} | ${pct(c("single"))}% | Nothing to compare against yet |

---

## By test

How many patients have each test on file, how many have enough history to show a
trend, and how many are **currently outside the safe range**.

| Test | On file | Comparable | Off target now |
|---|---|---|---|
${coverage}

Weight is tracked and displayed but **never changes a patient's verdict** — there
is no single safe range for it.

---

## ⚠️ Need attention

${section("worse", "📉 Getting worse", "A headline test has moved the wrong way since the previous reading.")}
${section("mixed", "⚠️ Mixed signals", "Improving on one measure and worsening on another. **Do not record these as “improving” without a review.**")}
${section("offtarget", "🔴 Off target", "Nothing is deteriorating, but at least one value sits outside its safe range right now. These are the patients a trend-only view misses entirely.")}
---

## ✅ Doing fine

${section("better", "📈 Getting better", "Headline tests improved and nothing else is worsening.")}
${section("stable", "➖ Stable", "No meaningful change. **Stable does not mean at target** — it means nothing moved.")}
---

## How to read this

- **"Doing fine"** = nothing deteriorating **and** nothing outside its safe range.
- **"Need attention"** covers three different problems: something got worse, signals disagree, or a value is off target even though it has not moved.
- Each test is compared against **its own** previous reading. HbA1c might be compared across six months while blood pressure is compared across two weeks.
- **There is no time limit on the comparison.** A "trend" here can span years, and a patient's "latest" value may itself be old. See \`OPD_DATA_FRESHNESS_PLAN.md\` — adding a recency window is a proposed change, not a current behaviour.
- Patients with no readings at all do not appear; they cannot be judged either way.

**Full data:** \`${CSV.split("/").pop()}\` contains every patient with all markers, verdict, and reason.

_Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from \`scripts/cohort-outcomes-doc.mjs\`._
`;

fs.writeFileSync(OUT, md);

// ── CSV: everyone, every marker ──
const esc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const head = [
  "file_no",
  "name",
  "verdict",
  "reason",
  "off_target",
  "last_reading",
  ...MARKERS.flatMap((m) => [`${m.key}_prev`, `${m.key}_latest`]),
];
const lines = [head.join(",")];
for (const p of d.patients) {
  lines.push(
    [
      p.file_no,
      p.name,
      p.group,
      p.reason,
      p.offTarget.join(" "),
      p.lastSeen,
      ...MARKERS.flatMap((m) => [fmt(p.prev[m.key]), fmt(p.cur[m.key])]),
    ]
      .map(esc)
      .join(","),
  );
}
fs.writeFileSync(CSV, lines.join("\n"));

console.log(`${OUT}
${CSV}  (${d.patients.length.toLocaleString()} rows)

  patients on record  ${d.total.toLocaleString()}
  doing fine          ${d.fine.toLocaleString()} (${pct(d.fine)}%)
  need attention      ${d.notFine.toLocaleString()} (${pct(d.notFine)}%)
    getting worse     ${c("worse").toLocaleString()}
    mixed signals     ${c("mixed").toLocaleString()}
    off target        ${c("offtarget").toLocaleString()}
  getting better      ${c("better").toLocaleString()}
  stable              ${c("stable").toLocaleString()}
  one reading only    ${c("single").toLocaleString()}`);
process.exit(0);
