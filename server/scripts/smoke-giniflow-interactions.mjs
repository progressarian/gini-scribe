// The interaction check (24-ADDENDUM-V11-PLAN.md §5.2).
//
// The rule this suite exists to protect is not "it finds interactions" — it is
// that it never claims to have checked what it could not read. A check that
// reports "clear" over a list it half understood is worse than no check.
//
//   npm run smoke:giniflow-interactions   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  checkCombinedList,
  checkVisit,
  acknowledge,
  resolveClasses,
} from "../services/giniflow/interactions.js";
import { splitClasses, brandToken, ruleKey } from "../../shared/giniflowInteractions.js";
import { finalizeConsult, fastPathFinalize } from "../services/giniflow/finalize.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
// A "ZZ" prefix on every invented brand, so these cases test the RULES and not
// the floor's own data: a name the database has never seen falls through to the
// class stated here. How a real brand resolves is asserted separately, below.
const med = (name, drugClass = null) => ({
  name: `ZZ${name}`,
  drugClass,
  source: "prescription",
});
const run = (meds) => checkCombinedList(meds, pool);
const has = (r, sev, ...names) =>
  r[sev].some((f) => names.every((n) => f.medicines.some((m) => m.includes(n))));

const TEST_DAY = "2019-01-05";
const before = await one(`SELECT count(*)::int AS c FROM flow_visits`);

// ── Reading the class off a name ─────────────────────────────────────────────
check("a combination tablet is two drugs", splitClasses("ARB+CCB").join(",") === "ARB,CCB");
check(
  "the same class written three ways folds to one",
  splitClasses("SU")[0] === splitClasses("Sulfonylurea")[0],
);
check("case and punctuation do not make a new class", splitClasses("ACE-Inhibitor")[0] === "ACEI");
check(
  "the brand is found past the form word HealthRay writes first",
  brandToken("INJ LANTUS 12U") === "LANTUS",
  brandToken("INJ LANTUS 12U"),
);

// ── The findings ─────────────────────────────────────────────────────────────
const dual = await run([med("Ecosprin 75", "Antiplatelet"), med("Clopilet", "Antiplatelet")]);
check(
  "dual antiplatelet is severe — the brief's own example",
  has(dual, "severe", "Ecosprin", "Clopilet"),
);

const raas = await run([med("Telma 40", "ARB"), med("Envas 5", "ACE Inhibitor")]);
check("an ACE inhibitor beside an ARB is severe", has(raas, "severe", "Telma", "Envas"));

const hidden = await run([med("Telma AM", "ARB+CCB"), med("Amlong", "CCB")]);
check(
  "a CCB hidden inside a combination tablet is still seen",
  has(hidden, "moderate", "Telma AM", "Amlong"),
);

const metformin = await run([med("Glycomet", "Biguanide"), med("Janumet", "DPP4i+Biguanide")]);
check(
  "two metformins, one inside a combination, is severe",
  has(metformin, "severe", "Glycomet", "Janumet"),
);

const nitrate = await run([med("Sorbitrate", "Nitrate"), med("Sildenafil", "PDE5 inhibitor")]);
check(
  "a nitrate with a PDE5 inhibitor is severe",
  has(nitrate, "severe", "Sorbitrate", "Sildenafil"),
);

const clean = await run([
  med("Telma 40", "ARB"),
  med("Glycomet", "Biguanide"),
  med("Rosuvas", "Statin"),
]);
check("a clean list reports nothing", !clean.severe.length && !clean.moderate.length);
check("and says so as 'checked', not as 'partial'", clean.status === "checked", clean.status);

// ── The honesty rules ────────────────────────────────────────────────────────
const partial = await run([med("Telma 40", "ARB"), med("Zzqq Unknown Syrup")]);
check(
  "a medicine nobody can identify is named, not dropped",
  partial.unchecked.includes("ZZZzqq Unknown Syrup"),
  partial.unchecked.join(","),
);
check(
  "and one unreadable medicine makes the whole check partial",
  partial.status === "partial",
  partial.status,
);
check("the count says how much was actually read", partial.checked === 1 && partial.total === 2);

const supplements = await run([med("Shelcal", "Supplement"), med("Aktiv D3", "Supplement")]);
check(
  "two supplements are not a finding — noise is how warnings get ignored",
  !supplements.severe.length && !supplements.moderate.length,
);
const antibiotics = await run([med("Amikacin", "Antibiotic"), med("Levofloxacin", "Antibiotic")]);
check(
  "nor are two antibiotics, which are usually deliberate",
  !antibiotics.severe.length && !antibiotics.moderate.length,
);

// ── Where the class comes from ───────────────────────────────────────────────
// A row's own `drug_class` is the least trustworthy of the three sources, so it
// is used last. Not theoretical: "TAB EMPHA M" — a metformin combination — is
// filed as `Antiplatelet` on some rows, and trusting the row made this check
// report a severe interaction that does not exist, on a real patient.
{
  const mislabelled = await resolveClasses(["TAB Empha M"], pool);
  check(
    "most of the database outvotes one row's wrong label",
    (mislabelled.get("TAB Empha M") || "").toUpperCase() === "BIGUANIDE",
    mislabelled.get("TAB Empha M"),
  );
  const asRow = await checkCombinedList(
    [
      { name: "TAB Empha M", drugClass: "Antiplatelet", source: "prescription" },
      { name: "TAB Pregeb NT", drugClass: "Antiplatelet", source: "prescription" },
    ],
    pool,
  );
  check(
    "so a mislabelled pair no longer reports an interaction that is not there",
    !asRow.severe.length,
    asRow.severe.map((f) => f.medicines.join("+")).join(","),
  );
  // "Other" is a bucket. Letting it win the vote loses real findings silently —
  // sildenafil is filed as Other on most rows, and the nitrate pair it belongs
  // to is one of the few absolute contraindications in the whole rule set.
  const bucket = await resolveClasses(["Sildenafil 50"], pool);
  check(
    "a bucket class never wins the vote",
    !/^other$/i.test(bucket.get("Sildenafil 50") || ""),
    bucket.get("Sildenafil 50") || "unresolved",
  );
}

// ── On a visit, and against finalize ─────────────────────────────────────────
await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

const visit = await one(
  `SELECT v.id, v.patient_id FROM giniflow_visits v WHERE v.visit_date = $1::date LIMIT 1`,
  [TEST_DAY],
);
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visit.id]);
  await client.query(
    `INSERT INTO giniflow_rx_items (visit_id, medicine_name, drug_class, change_type, sort_order)
     VALUES ($1,'Ecosprin 75','Antiplatelet','continued',1),
            ($1,'Clopilet 75','Antiplatelet','new',2)`,
    [visit.id],
  );
  // The other hospital's medicine — the half of the list the check exists for.
  await client.query(
    `INSERT INTO medications (patient_id, name, drug_class, external_doctor, med_group, is_active, is_new)
     VALUES ($1,'Warf 5','Anticoagulant','Dr. Outside','external',true,false)`,
    [visit.patient_id],
  );

  const v = await checkVisit(visit.id, client);
  check(
    "the check reaches across to another hospital's medicine",
    has(v, "severe", "Warf 5"),
    v.severe.map((f) => f.medicines.join("+")).join(" / "),
  );
  check(
    "an undecided severe finding blocks finalize",
    v.blocking.length > 0,
    `${v.blocking.length}`,
  );

  const key = v.blocking[0].key;
  check(
    "an override with no reason is refused",
    await acknowledge(visit.id, { ruleKey: key, reason: "" }, null, client)
      .then(() => false)
      .catch((e) => e.status === 400),
  );
  await acknowledge(
    visit.id,
    { ruleKey: key, reason: "6 months post-stent, planned" },
    null,
    client,
  );
  const after = await checkVisit(visit.id, client);
  check(
    "a recorded reason clears the block without hiding the finding",
    after.blocking.length < v.blocking.length &&
      after.severe.some((f) => f.key === key && f.acknowledged),
  );
  check(
    "and the reason travels with it, for whoever reads the record later",
    after.severe.find((f) => f.key === key)?.acknowledgedReason === "6 months post-stent, planned",
  );

  const stale = await acknowledge(
    visit.id,
    { ruleKey: ruleKey("ZZZ", "YYY"), reason: "made up" },
    null,
    client,
  )
    .then(() => false)
    .catch((e) => e.status === 409);
  check("an override for an interaction that is not there is refused", stale);
  await client.query("ROLLBACK");
} finally {
  client.release();
}

// Finalize itself refuses, on both routes into it. `finalizeConsult` opens its
// own transaction, so it cannot be handed a client to roll back — this runs on
// the pool, against the demo visit, and the assertion IS that nothing is
// written: a guard that fires leaves no consultation behind. `cleanDemoDay`
// below is the backstop if one ever does.
await pool.query(
  `UPDATE giniflow_visits
      SET current_status='with_doctor', category='in_control', blocked_reason=NULL
    WHERE id=$1`,
  [visit.id],
);
await pool.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visit.id]);
await pool.query(
  `INSERT INTO giniflow_rx_items (visit_id, medicine_name, drug_class, change_type, sort_order)
   VALUES ($1,'Telma 40','ARB','continued',1), ($1,'Envas 5','ACE Inhibitor','new',2)`,
  [visit.id],
);

for (const [label, fn] of [
  ["the consultant's finalize", finalizeConsult],
  ["the fast path", fastPathFinalize],
]) {
  const refused = await fn(visit.id, null)
    .then(() => null)
    .catch((e) => e);
  check(
    `${label} refuses a severe interaction nobody has explained`,
    refused?.status === 409 && /Telma|Envas/.test(refused.message),
    refused?.message?.slice(0, 60),
  );
}
const wrote = await one(
  `SELECT count(*)::int AS c FROM consultations c
     JOIN giniflow_visits v ON v.patient_id = c.patient_id AND v.visit_date = c.visit_date
    WHERE v.id = $1`,
  [visit.id],
);
check("a refused finalize writes no consultation", wrote.c === 0, `${wrote.c}`);

await cleanDemoDay();
const after = await one(`SELECT count(*)::int AS c FROM flow_visits`);
check("old flow_* module untouched", after.c === before.c, `${before.c}→${after.c}`);
const leaked = await one(
  `SELECT count(*)::int AS c FROM giniflow_interaction_acks a
     JOIN giniflow_visits v ON v.id = a.visit_id WHERE v.visit_date = $1::date`,
  [TEST_DAY],
);
check("the suite leaves no acknowledgements behind", leaked.c === 0, `${leaked.c}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
