// ── Un-merge patients collided by HealthRay UHID reassignment ───────────────
//
// BACKGROUND (P_180848 incident): HealthRay reuses/reassigns a UHID
// (patient_case_id → our file_no) to a DIFFERENT person over time. The old
// upsertPatient matched by file_no only and never updated an existing row, so a
// reassigned UHID silently piled two people's visits onto ONE patients row and
// froze the first person's name. This script splits those rows back apart.
//
// It is DRY-RUN by default and prints a full plan. Nothing is written without
// --apply. Each patient is split inside its own transaction, so a failure on one
// patient never leaves another half-split.
//
// SAFETY MODEL — only move what is definitively attributable to a person:
//   • appointments            — each row carries name/sex/family_member_id
//   • lab_results             — by appointment_id (definitive FK)
//   • active_visits           — by appointment_id (definitive FK)
//   • consultations + their
//     children (vitals,
//     diagnoses, medications,
//     documents, goals,
//     complications)          — by visit_date, but ONLY for dates owned
//                               EXCLUSIVELY by the person being split out.
//   • lab_results w/o appt_id — by test_date, same exclusive-date rule.
// Anything on a date SHARED by two people is ambiguous — it is LEFT in place and
// listed under "manual review" rather than guessed at.
//
// Usage (from the gini-scribe/server folder):
//   node scripts/split-reassigned-uhids.mjs                       # dry-run, all conflicting-sex collisions
//   node scripts/split-reassigned-uhids.mjs --file-no P_180848    # one case, dry-run
//   node scripts/split-reassigned-uhids.mjs --include-name        # also same-sex, different-name (riskier)
//   node scripts/split-reassigned-uhids.mjs --apply               # execute the writes

import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const INCLUDE_NAME = process.argv.includes("--include-name");
const fileNoArgIdx = process.argv.indexOf("--file-no");
const ONLY_FILE_NO = fileNoArgIdx >= 0 ? process.argv[fileNoArgIdx + 1] : null;

// Clinical children hung off consultations(id).
const CONSULTATION_CHILDREN = [
  "vitals",
  "diagnoses",
  "medications",
  "documents",
  "goals",
  "complications",
];

const normName = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|master|baby|smt|shri|km|kumari)\b\.?/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const titleCase = (s) =>
  (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b([a-z])/gi, (m) => m.toUpperCase());

const normSex = (s) => (s || "").trim().toLowerCase();
const mapSex = (s) => {
  const g = normSex(s);
  if (g === "male") return "Male";
  if (g === "female") return "Female";
  return g ? "Other" : null;
};

// Person grouping key for one appointment. NOTE: we deliberately do NOT key on
// sex — a differing sex on the SAME name is almost always a data-entry typo on
// one visit (same person), not a reassignment. Keying on sex would split one
// person into a bogus duplicate. Genuine reassignments show a different NAME
// (and usually a different sex too); that is decided in the split filter below.
function personKey(appt) {
  if (appt.family_member_id) return `fm:${appt.family_member_id}`;
  return `nm:${normName(appt.patient_name)}`;
}

async function findCollidingPatientIds() {
  if (ONLY_FILE_NO) {
    const { rows } = await pool.query(
      `SELECT DISTINCT patient_id FROM appointments WHERE file_no = $1 AND patient_id IS NOT NULL`,
      [ONLY_FILE_NO],
    );
    return rows.map((r) => r.patient_id);
  }
  // Conflicting sex is the high-confidence signal (a reassigned UHID). With
  // --include-name we also take rows whose appointments carry ≥2 distinct
  // normalized names at the same sex (spelling variants inflate this, so it is
  // opt-in and the per-person grouping below re-checks before splitting).
  const { rows } = await pool.query(
    `SELECT patient_id
       FROM appointments
      WHERE file_no LIKE 'P/_%' ESCAPE '/' AND patient_id IS NOT NULL
      GROUP BY patient_id
     HAVING COUNT(DISTINCT lower(sex)) > 1
        ${INCLUDE_NAME ? `OR COUNT(DISTINCT lower(regexp_replace(patient_name,'^(mr|mrs|ms|dr|master|baby|smt|shri)\\.?\\s+','','i'))) > 1` : ``}`,
  );
  return rows.map((r) => r.patient_id);
}

// Build the split plan for one patient. Returns null if it is not a real
// multi-person collision (e.g. only title/spelling variance of one person).
async function planForPatient(patientId) {
  const { rows: pRows } = await pool.query(
    `SELECT id, name, sex, phone, file_no, health_id FROM patients WHERE id = $1`,
    [patientId],
  );
  const patient = pRows[0];
  if (!patient) return null;

  const { rows: appts } = await pool.query(
    `SELECT id, patient_name, sex, phone, age, healthray_id, family_member_id,
            appointment_date, doctor_name, created_at
       FROM appointments
      WHERE patient_id = $1
      ORDER BY appointment_date NULLS FIRST, created_at NULLS FIRST, id`,
    [patientId],
  );
  if (appts.length === 0) return null;

  // Group appointments into persons.
  const groups = new Map(); // key -> { key, name, sex, phones:Map, familyMemberId, appts:[] }
  for (const a of appts) {
    const key = personKey(a);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: a.patient_name,
        sex: a.sex,
        familyMemberId: a.family_member_id || null,
        ages: [],
        phones: new Map(),
        appts: [],
      });
    }
    const g = groups.get(key);
    g.appts.push(a);
    if (a.age != null) g.ages.push(a.age);
    if (a.phone) g.phones.set(a.phone, (g.phones.get(a.phone) || 0) + 1);
    if (!g.familyMemberId && a.family_member_id) g.familyMemberId = a.family_member_id;
  }
  if (groups.size < 2) return null; // single person — nothing to split

  const groupList = [...groups.values()];
  const commonPhone = (g) => {
    let best = null;
    let bestN = -1;
    for (const [ph, n] of g.phones) if (n > bestN) ((best = ph), (bestN = n));
    return best;
  };
  const latestApptTime = (g) =>
    Math.max(...g.appts.map((a) => new Date(a.created_at || a.appointment_date).getTime() || 0));

  // Primary person = the one matching the patient row's current name (the person
  // the row is already "about"); fall back to the earliest group.
  const pn = normName(patient.name);
  let primary = groupList.find((g) => normName(g.name) === pn) || groupList[0];

  // Decide which non-primary groups are genuinely DIFFERENT people (safe to
  // split out) vs. same-person noise (a sex typo, or — unless --include-name —
  // a mere spelling variant) that must stay merged.
  const differentPerson = (g) => {
    if (g === primary) return false;
    const diffFm =
      g.familyMemberId && primary.familyMemberId && g.familyMemberId !== primary.familyMemberId;
    const diffName = normName(g.name) !== normName(primary.name);
    const diffSex = normSex(g.sex) && normSex(primary.sex) && normSex(g.sex) !== normSex(primary.sex);
    // High confidence: a different family member, OR a different name AND sex
    // (the P_180848 = Meenu/Rattan signature). Name-only differences are
    // spelling-variant territory — opt-in via --include-name.
    return diffFm || (diffName && diffSex) || (INCLUDE_NAME && diffName);
  };
  const splitGroups = groupList.filter(differentPerson);
  if (splitGroups.length === 0) return null; // no genuine collision to un-merge

  // Current UHID owner = person (primary or split-out) with the most recent
  // appointment. The file_no follows them; everyone else's copy is cleared.
  let owner = primary;
  for (const g of [primary, ...splitGroups]) if (latestApptTime(g) > latestApptTime(owner)) owner = g;

  // Dates owned by more than one person are ambiguous for consultation/lab moves.
  const dateOwners = new Map(); // dateISO -> Set(keys)
  for (const a of appts) {
    const d = a.appointment_date ? new Date(a.appointment_date).toISOString().slice(0, 10) : null;
    if (!d) continue;
    if (!dateOwners.has(d)) dateOwners.set(d, new Set());
    dateOwners.get(d).add(personKey(a));
  }
  const sharedDates = new Set([...dateOwners].filter(([, s]) => s.size > 1).map(([d]) => d));

  const moves = [];
  for (const g of splitGroups) {
    const apptIds = g.appts.map((a) => a.id);
    const gDatesAll = [
      ...new Set(
        g.appts
          .map((a) => (a.appointment_date ? new Date(a.appointment_date).toISOString().slice(0, 10) : null))
          .filter(Boolean),
      ),
    ];
    const exclusiveDates = gDatesAll.filter((d) => !sharedDates.has(d));
    const ambiguousDates = gDatesAll.filter((d) => sharedDates.has(d));
    moves.push({
      group: g,
      apptIds,
      exclusiveDates,
      ambiguousDates,
      name: titleCase(g.name),
      sex: mapSex(g.sex),
      phone: commonPhone(g),
      age: g.ages.length ? g.ages[g.ages.length - 1] : null,
      familyMemberId: g.familyMemberId,
      isOwner: g === owner,
    });
  }
  if (moves.length === 0) return null;

  return {
    patient,
    ownerIsPrimary: owner === primary,
    primary: { name: titleCase(primary.name), sex: mapSex(primary.sex), key: primary.key },
    moves,
  };
}

// Count how many rows a move would touch (for the dry-run report). Uses the same
// predicates the apply path uses.
async function countMove(client, patientId, m) {
  const apptIds = m.apptIds;
  const q = async (sql, params) => (await client.query(sql, params)).rows[0].n;
  const inAppt = apptIds.length ? apptIds : [-1];
  const exDates = m.exclusiveDates.length ? m.exclusiveDates : ["1900-01-01"];
  const appts = apptIds.length;
  const labsByAppt = await q(
    `SELECT COUNT(*)::int n FROM lab_results WHERE appointment_id = ANY($1)`,
    [inAppt],
  );
  const activeVisits = await q(
    `SELECT COUNT(*)::int n FROM active_visits WHERE appointment_id = ANY($1)`,
    [inAppt],
  );
  const consults = await q(
    `SELECT COUNT(*)::int n FROM consultations WHERE patient_id = $1 AND visit_date = ANY($2::date[])`,
    [patientId, exDates],
  );
  const labsByDate = await q(
    `SELECT COUNT(*)::int n FROM lab_results
      WHERE patient_id = $1 AND appointment_id IS NULL AND test_date = ANY($2::date[])`,
    [patientId, exDates],
  );
  return { appts, labsByAppt, activeVisits, consults, labsByDate };
}

async function applyMove(client, patientId, m) {
  // Reuse an existing patient row for this person if the fixed sync already
  // created one (matched by health_id); else create a new row.
  let newId = null;
  if (m.familyMemberId) {
    const { rows } = await client.query(
      `SELECT id FROM patients WHERE health_id = $1 AND id <> $2 LIMIT 1`,
      [m.familyMemberId, patientId],
    );
    if (rows[0]) newId = rows[0].id;
  }
  if (!newId) {
    // file_no is left NULL here; it is assigned to the current UHID owner after
    // all moves so the previous owner's copy can be cleared in the same pass.
    const { rows } = await client.query(
      `INSERT INTO patients (name, sex, phone, age, health_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [m.name, m.sex, m.phone, m.age, m.familyMemberId],
    );
    newId = rows[0].id;
  }

  const apptIds = m.apptIds.length ? m.apptIds : [-1];
  const exDates = m.exclusiveDates.length ? m.exclusiveDates : ["1900-01-01"];

  // Definitive moves (by appointment_id).
  await client.query(`UPDATE appointments SET patient_id = $1 WHERE id = ANY($2)`, [newId, apptIds]);
  await client.query(`UPDATE lab_results SET patient_id = $1 WHERE appointment_id = ANY($2)`, [
    newId,
    apptIds,
  ]);
  await client.query(`UPDATE active_visits SET patient_id = $1 WHERE appointment_id = ANY($2)`, [
    newId,
    apptIds,
  ]);

  // Consultations on dates owned EXCLUSIVELY by this person, + their children.
  const { rows: consRows } = await client.query(
    `SELECT id FROM consultations WHERE patient_id = $1 AND visit_date = ANY($2::date[])`,
    [patientId, exDates],
  );
  const consIds = consRows.map((r) => r.id);
  if (consIds.length) {
    await client.query(`UPDATE consultations SET patient_id = $1 WHERE id = ANY($2)`, [
      newId,
      consIds,
    ]);
    for (const tbl of CONSULTATION_CHILDREN) {
      await client.query(`UPDATE ${tbl} SET patient_id = $1 WHERE consultation_id = ANY($2)`, [
        newId,
        consIds,
      ]);
    }
  }

  // Lab results with no appointment link, on exclusive dates.
  await client.query(
    `UPDATE lab_results SET patient_id = $1
      WHERE patient_id = $2 AND appointment_id IS NULL AND test_date = ANY($3::date[])`,
    [newId, patientId, exDates],
  );

  return newId;
}

async function main() {
  console.log(
    `\n=== split-reassigned-uhids — ${APPLY ? "APPLY (writing)" : "DRY-RUN"} ${
      ONLY_FILE_NO ? `[file_no ${ONLY_FILE_NO}]` : INCLUDE_NAME ? "[sex+name collisions]" : "[sex collisions]"
    } ===\n`,
  );

  const ids = await findCollidingPatientIds();
  console.log(`Candidate patient rows: ${ids.length}\n`);

  const totals = { patients: 0, newRows: 0, appts: 0, labs: 0, consults: 0, ambiguousDates: 0 };
  const client = await pool.connect();
  try {
    for (const pid of ids) {
      const plan = await planForPatient(pid);
      if (!plan) continue;
      totals.patients++;

      console.log(
        `patient #${plan.patient.id} "${plan.patient.name}" (${plan.patient.sex || "?"}) file_no=${plan.patient.file_no}`,
      );
      console.log(`  keep as primary: "${plan.primary.name}" (${plan.primary.sex || "?"})`);

      for (const m of plan.moves) {
        const c = await countMove(client, plan.patient.id, m);
        console.log(
          `  split OUT → "${m.name}" (${m.sex || "?"}) ${m.isOwner ? "[current UHID owner]" : ""}` +
            `\n      appts=${c.appts} labs(byAppt)=${c.labsByAppt} activeVisits=${c.activeVisits}` +
            ` consults=${c.consults} labs(byDate)=${c.labsByDate}` +
            (m.ambiguousDates.length
              ? `\n      ⚠ MANUAL REVIEW — shared dates left in place: ${m.ambiguousDates.join(", ")}`
              : ""),
        );
        totals.appts += c.appts;
        totals.labs += c.labsByAppt + c.labsByDate;
        totals.consults += c.consults;
        totals.ambiguousDates += m.ambiguousDates.length;
      }

      if (APPLY) {
        try {
          await client.query("BEGIN");
          for (const m of plan.moves) {
            const newId = await applyMove(client, plan.patient.id, m);
            totals.newRows++;
            console.log(`      → wrote patient #${newId}`);
            // Hand the UHID to the current owner. file_no is unique among
            // current owners, so clear it from the original row FIRST, then set
            // it on the new row.
            if (m.isOwner && !plan.ownerIsPrimary) {
              await client.query(
                `UPDATE patients SET file_no = NULL, updated_at = NOW() WHERE id = $1`,
                [plan.patient.id],
              );
              await client.query(`UPDATE patients SET file_no = $1, updated_at = NOW() WHERE id = $2`, [
                plan.patient.file_no,
                newId,
              ]);
            }
          }
          // Normalize the primary row's name/sex to the clean primary identity.
          await client.query(
            `UPDATE patients SET name = $1, sex = COALESCE($2, sex), updated_at = NOW() WHERE id = $3`,
            [plan.primary.name, plan.primary.sex, plan.patient.id],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          console.error(`  ✗ FAILED patient #${plan.patient.id}: ${e.message} — rolled back`);
        }
      }
      console.log("");
    }
  } finally {
    client.release();
  }

  console.log("=== TOTALS ===");
  console.log(
    `patients split=${totals.patients} newRows=${totals.newRows} appts=${totals.appts} ` +
      `labs=${totals.labs} consults=${totals.consults} ambiguousDates(left)=${totals.ambiguousDates}`,
  );
  if (!APPLY) console.log("\nDRY-RUN only. Re-run with --apply to write these changes.");
  await pool.end();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
