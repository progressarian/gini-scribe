import pool from "../../config/db.js";
import {
  splitClasses,
  duplicationMatters,
  ruleKey,
  brandToken,
} from "../../../shared/giniflowInteractions.js";

// The interaction check (24-ADDENDUM-V11-PLAN.md §5.2).
//
// Runs over the COMBINED list — the prescription being written plus the
// medicines another hospital started — because a check that only sees this
// clinic's own prescribing answers the wrong question.
//
// What it will not do is claim more than it knows. A medicine whose class
// cannot be resolved is returned by name in `unchecked`, and the whole result
// is `partial` rather than `clear` whenever that list is not empty. Two thirds
// of the medicine list is unresolvable today, and a screen that said "no
// interactions" over that would be inventing an assurance.

const DEFAULT_DUPLICATION = {
  severity: "moderate",
  note: "Two drugs from the same class. Check this is deliberate — one is often a combination tablet containing the other.",
};

// Class comes from the curated reference tables first, and only then from what
// was typed on a medication row.
//
// That order is the wrong way round from what you would expect, and it is
// deliberate. `medications.drug_class` is per-row and demonstrably wrong in
// places: "TAB EMPHA M" — a metformin combination — is filed as `Antiplatelet`
// on some rows and `Biguanide` on others, and taking the first one found made
// this check report a severe interaction that does not exist. A false severe
// finding is not a small bug here: it stops a finalize and teaches the
// consultant that the warnings are wrong.
//
// So the class of a brand is what MOST of its rows say, not what this one row
// says — "Empha" is a biguanide on dozens of rows and an antiplatelet on two.
// A brand with no majority resolves to nothing and surfaces as unchecked: the
// database contradicting itself evenly is not knowledge, and the honest answer
// to "what class is this" is then "nobody knows".
export async function resolveClasses(names, db = pool) {
  const wanted = [...new Set(names.map((n) => (n || "").trim()).filter(Boolean))];
  if (!wanted.length) return new Map();

  // The brand is the first word that is not a form word — "Glizid MR 60mg" is
  // Glizid, "INJ LANTUS 12U" is Lantus. Matching the whole string as well
  // catches the molecules, which are written out in full.
  const heads = wanted.map(brandToken);

  const { rows } = await db.query(
    `WITH wanted AS (SELECT unnest($1::text[]) AS name, unnest($2::text[]) AS head),
     -- Every class this brand has ever been filed under. One distinct value is
     -- an answer; two is a contradiction, and a contradiction is not an answer.
     tallied AS (
       SELECT w.name, m.drug_class, count(*)::int AS votes
         FROM wanted w
         JOIN medications m
           ON m.drug_class IS NOT NULL AND m.drug_class <> ''
          -- "Other" is a bucket, not a class. Letting it win a vote loses real
          -- findings: sildenafil is filed as Other on most rows, and the
          -- nitrate pair it belongs to is one of the few absolute
          -- contraindications in this whole rule set.
          AND m.drug_class NOT ILIKE 'other'
          AND m.drug_class NOT ILIKE 'unknown'
          AND m.drug_class NOT ILIKE 'misc%'
          AND (UPPER(m.name) = UPPER(w.name)
               OR UPPER(m.name) ~ ('(^| )' || w.head || '( |$)'))
        WHERE w.head <> ''
        GROUP BY w.name, m.drug_class
     ),
     prescribed AS (
       SELECT name,
              (array_agg(drug_class ORDER BY votes DESC))[1] AS top_class,
              (array_agg(votes ORDER BY votes DESC))[1] AS top_votes,
              COALESCE((array_agg(votes ORDER BY votes DESC))[2], 0) AS runner_up
         FROM tallied GROUP BY name
     )
     SELECT w.name,
            COALESCE(
              (SELECT d.drug_class FROM drug_master d
                WHERE UPPER(d.generic_name) IN (UPPER(w.name), UPPER(w.head))
                   OR EXISTS (SELECT 1 FROM unnest(COALESCE(d.brand_names, '{}')) b
                               WHERE UPPER(b) IN (UPPER(w.name), UPPER(w.head)))
                LIMIT 1),
              (SELECT f.drug_class FROM mhg_drug_formulary f
                WHERE UPPER(f.brand) IN (UPPER(w.name), UPPER(w.head))
                   OR UPPER(f.molecule) IN (UPPER(w.name), UPPER(w.head))
                LIMIT 1)
            ) AS reference_class,
            p.top_class, p.top_votes, p.runner_up
       FROM wanted w
       LEFT JOIN prescribed p ON p.name = w.name`,
    [wanted, heads],
  );

  return new Map(
    rows.map((r) => {
      if (r.reference_class) return [r.name, r.reference_class];
      // A clear majority is an answer. A tie is not — and a tie is the shape
      // the Empha mislabelling would have to take before this check would
      // repeat that mistake.
      const decided = r.top_class && r.top_votes > r.runner_up;
      return [r.name, decided ? r.top_class : null];
    }),
  );
}

const loadRules = async (db) => {
  const { rows } = await db.query(
    `SELECT class_a, class_b, severity, note FROM giniflow_interaction_rules WHERE is_active`,
  );
  return new Map(rows.map((r) => [ruleKey(r.class_a, r.class_b), r]));
};

// One entry per medicine on the combined list, with every class it contributes.
// A combination tablet contributes more than one, which is how an ARB hidden
// inside "ARB+CCB" gets seen at all.
// The class stated on the row is checked against the reference tables and the
// rest of the database rather than trusted: the row's own label is where the
// bad data lives, and it is the one place that cannot correct itself.
// Three sources, in order of how much they can be trusted: the curated
// reference tables, then what most of the database says about this brand, then
// the label on the row itself. The row's own label is last because that is
// exactly where the bad data lives — but it is still better than nothing for a
// brand nobody has prescribed before, which is the only case that reaches it.
const expand = (meds, resolved) =>
  meds.map((m) => {
    const stated = resolved.get(m.name) || m.drugClass || null;
    return { ...m, classes: stated ? splitClasses(stated) : [] };
  });

export async function checkCombinedList(meds, db = pool) {
  const resolved = await resolveClasses(
    meds.map((m) => m.name),
    db,
  );
  const rules = await loadRules(db);
  const expanded = expand(meds, resolved);

  const findings = new Map();
  const record = (rule, key, a, b) => {
    const existing = findings.get(key);
    const medicines = [...new Set([...(existing?.medicines || []), a.name, b.name])];
    findings.set(key, {
      key,
      severity: rule.severity,
      note: rule.note,
      classes: key.split("|"),
      medicines,
      // Named, because "two antiplatelets" is a sentence a consultant has to
      // translate back into which two boxes on the screen.
      sources: [...new Set([...(existing?.sources || []), a.source, b.source])],
    });
  };

  for (let i = 0; i < expanded.length; i++) {
    for (let j = i + 1; j < expanded.length; j++) {
      const a = expanded[i];
      const b = expanded[j];
      for (const ca of a.classes) {
        for (const cb of b.classes) {
          const key = ruleKey(ca, cb);
          const rule = rules.get(key);
          if (rule) {
            record(rule, key, a, b);
          } else if (ca === cb && duplicationMatters(ca)) {
            record(DEFAULT_DUPLICATION, key, a, b);
          }
        }
      }
    }
  }

  const unchecked = expanded.filter((m) => !m.classes.length).map((m) => m.name);
  const all = [...findings.values()];
  return {
    severe: all.filter((f) => f.severity === "severe"),
    moderate: all.filter((f) => f.severity === "moderate"),
    unchecked,
    checked: expanded.length - unchecked.length,
    total: expanded.length,
    // Three states, not two. `partial` is the honest answer for a list the
    // check could only half read, and the screen must not render it as clear.
    status: unchecked.length ? "partial" : expanded.length ? "checked" : "empty",
  };
}

// The combined list for one visit: what is being prescribed now, plus what
// another hospital started. The patient's existing Gini regimen is deliberately
// not added — once the draft is seeded it already contains those rows, and
// counting them twice would report every continued medicine as a duplication.
export async function checkVisit(visitId, db = pool) {
  const [{ rows: items }, { rows: external }, { rows: acks }] = await Promise.all([
    db.query(
      `SELECT medicine_name, drug_class FROM giniflow_rx_items
        WHERE visit_id = $1 AND change_type <> 'stopped'`,
      [visitId],
    ),
    db.query(
      `SELECT m.name, m.drug_class, m.external_doctor
         FROM medications m
         JOIN giniflow_visits v ON v.patient_id = m.patient_id
        WHERE v.id = $1 AND m.is_active AND m.external_doctor IS NOT NULL`,
      [visitId],
    ),
    db.query(
      `SELECT rule_key, reason, acked_at FROM giniflow_interaction_acks WHERE visit_id = $1`,
      [visitId],
    ),
  ]);

  const meds = [
    ...items.map((i) => ({
      name: i.medicine_name,
      drugClass: i.drug_class,
      source: "prescription",
    })),
    ...external.map((e) => ({
      name: e.name,
      drugClass: e.drug_class,
      source: e.external_doctor ? `outside — ${e.external_doctor}` : "outside",
    })),
  ];

  const result = await checkCombinedList(meds, db);
  const ackBy = new Map(acks.map((a) => [a.rule_key, a]));
  const withAcks = (list) =>
    list.map((f) => ({
      ...f,
      acknowledged: ackBy.has(f.key),
      acknowledgedReason: ackBy.get(f.key)?.reason || null,
    }));

  const severe = withAcks(result.severe);
  return {
    ...result,
    severe,
    moderate: withAcks(result.moderate),
    // What finalize actually gates on.
    blocking: severe.filter((f) => !f.acknowledged),
  };
}

export async function acknowledge(visitId, { ruleKey: key, reason }, actorId = null, db = pool) {
  const clean = (reason || "").trim();
  // An override with no reason is not an override, it is a click. The whole
  // value of stopping the consultant is the sentence it produces on the record.
  if (clean.length < 4) {
    throw Object.assign(new Error("Say why this combination is intended — it goes on the record"), {
      status: 400,
    });
  }
  const current = await checkVisit(visitId, db);
  const finding = [...current.severe, ...current.moderate].find((f) => f.key === key);
  if (!finding) {
    throw Object.assign(new Error("That interaction is not on this prescription any more"), {
      status: 409,
    });
  }
  const { rows } = await db.query(
    `INSERT INTO giniflow_interaction_acks (visit_id, rule_key, severity, medicines, reason, acked_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (visit_id, rule_key)
       DO UPDATE SET reason = EXCLUDED.reason, acked_by = EXCLUDED.acked_by, acked_at = NOW()
     RETURNING rule_key, reason, acked_at`,
    [visitId, key, finding.severity, finding.medicines, clean, actorId],
  );
  return rows[0];
}
