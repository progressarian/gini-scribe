import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const mo = await import("../../server/services/giniflow/moStation.js");
const collect = await import("../../server/services/careFollowups/collect.js");
const actions = await import("../../server/services/careFollowups/actions.js");
const match = await import("../../server/services/careFollowups/match.js");

const db = getPool();
const tag = newTag();
const coord = { actorId: USERS.coordinator.id };
let ids;
const patients = [];

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const setSince = (day) =>
  query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ('care_followups_since', to_jsonb($1::text), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [day],
  );

const patientVisit = async (label) => {
  const made = await extraVisit(ids, label, { healthray: false });
  patients.push(made.patient);
  return made;
};

const itemsOf = async (patient) =>
  (
    await query(
      `SELECT source, source_key, kind, target, availability, matched_doctor_id, matched_specialty,
              matched_tests, ordered_on::text AS ordered_on, due_on::text AS due_on, status,
              outcome_reason, id
         FROM care_followups WHERE patient_id = $1 ORDER BY source, target`,
      [patient],
    )
  ).rows;

const floorReferral = (made, specialty, extra = {}) =>
  one(
    `INSERT INTO giniflow_referrals (visit_id, patient_id, specialty, to_doctor, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      made.visit,
      made.patient,
      specialty,
      extra.to ?? null,
      extra.reason ?? "Review",
      USERS.admin.id,
    ],
  );

test.describe.serial("CF01 care follow-ups: collecting the worklist", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await setSince(ids.day);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM care_followups WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM referrals WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM giniflow_referrals WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM lab_results WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM app_kv WHERE key = 'care_followups_since'`);
    await tearDown(ids);
  });

  test("1. nothing older than the go-live date is collected", async () => {
    const made = await patientVisit("CfOld");
    await query(`UPDATE giniflow_visits SET visit_date = visit_date - 1 WHERE id = $1`, [
      made.visit,
    ]);
    await query(`UPDATE appointments SET appointment_date = appointment_date - 1 WHERE id = $1`, [
      made.appointment,
    ]);
    await floorReferral(made, "Ophthalmology");
    await query(
      `INSERT INTO referrals (patient_id, doctor_name, speciality, reason, appointment_id)
       VALUES ($1, 'Dr Somebody', 'Cardiology', 'Old', $2)`,
      [made.patient, made.appointment],
    );
    await collect.collectFollowups({ db });
    expect(await itemsOf(made.patient)).toEqual([]);
  });

  test("2. each referral makes one item; next-visit tests are not collected", async () => {
    const made = await patientVisit("CfAll");
    await floorReferral(made, "Ophthalmology", { reason: "Retina check" });
    await floorReferral(made, "Endocrinology", { to: "Dr E2E Rahul" });
    await query(
      `INSERT INTO referrals (patient_id, doctor_name, speciality, reason, appointment_id)
       VALUES ($1, 'Dr E2E Banshali', 'Endocrinology', 'Insulin start', $2),
              ($1, 'Dr Outside', 'Oncology', 'Lump', $2)`,
      [made.patient, made.appointment],
    );
    await mo.orderTests(
      made.visit,
      { urgency: "next_visit", tests: [ids.looseName, ids.abiName], actorId: USERS.admin.id },
      db,
    );
    const due = addDays(ids.day, 30);
    await query(
      `UPDATE appointments
          SET healthray_investigations = $2::jsonb, healthray_follow_up = $3::jsonb
        WHERE id = $1`,
      [
        made.appointment,
        JSON.stringify([ids.looseName, "Mystery Panel"]),
        JSON.stringify({ date: due, notes: "Fasting" }),
      ],
    );

    const first = await collect.collectFollowups({ db });
    expect(first.since).toBe(ids.day);
    const items = await itemsOf(made.patient);
    const by = (source, pred = () => true) => items.filter((i) => i.source === source && pred(i));

    expect(by("gf_referral")).toHaveLength(2);
    expect(by("gf_referral", (i) => i.target === "Ophthalmology")[0]).toMatchObject({
      kind: "specialty",
      matched_specialty: "Ophthalmology",
      ordered_on: ids.day,
    });
    expect(by("gf_referral", (i) => i.target.startsWith("Endocrinology"))[0]).toMatchObject({
      kind: "consultant",
      matched_doctor_id: CONSULTANTS.rahul.id,
      availability: "in_house",
    });

    expect(by("rx_referral")).toHaveLength(2);
    expect(by("rx_referral", (i) => i.target.includes("Banshali"))[0]).toMatchObject({
      kind: "consultant",
      matched_doctor_id: CONSULTANTS.banshali.id,
      availability: "in_house",
    });
    expect(by("rx_referral", (i) => i.target.includes("Oncology"))[0]).toMatchObject({
      kind: "specialty",
      matched_specialty: "Oncology",
      availability: "not_available",
    });

    expect(items).toHaveLength(4);
    expect(items.some((i) => ["lab_test", "machine_test"].includes(i.kind))).toBe(false);
    expect(first.sources).not.toHaveProperty("next_visit_order");
    expect(first.sources).not.toHaveProperty("hr_follow_up");
  });

  test("3. collecting again adds nothing and keeps the coordinator's outcome", async () => {
    const made = await patientVisit("CfTwice");
    await floorReferral(made, "Cardiology");
    await collect.collectFollowups({ db });
    const [item] = await itemsOf(made.patient);
    await actions.closeWith(item.id, { status: "declined", reason: "Going elsewhere" }, coord, db);
    const again = await collect.collectFollowups({ db });
    expect(again.sources.gf_referral.added).toBe(0);
    const after = await itemsOf(made.patient);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "declined", outcome_reason: "Going elsewhere" });
  });

  test("4. availability matching: aliases and unknown wording", async () => {
    const catalog = { people: [], consultantSpecialties: new Set(["Endocrinology"]) };
    expect(match.matchReferral(catalog, { specialty: "DM Endo" })).toMatchObject({
      matchedSpecialty: "Endocrinology",
      availability: "in_house",
    });
    expect(match.matchReferral(catalog, { reason: "see the eye OPD" })).toMatchObject({
      matchedSpecialty: "Ophthalmology",
      availability: "not_available",
    });
    expect(match.matchReferral(catalog, { reason: "as discussed" }).availability).toBe("unknown");
  });

  test("5. a later booking marks the referral booked, and the completed visit marks it done", async () => {
    const made = await patientVisit("CfAuto");
    await floorReferral(made, "Endocrinology", { to: "Dr E2E Banshali" });
    await collect.collectFollowups({ db });
    const items = await itemsOf(made.patient);
    const person = items.find((i) => i.source === "gf_referral");

    const later = await one(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, doctor_name, visit_type, status)
       VALUES ($1, $2, $3, $4::date, $5, 'Follow Up', 'scheduled') RETURNING id`,
      [
        made.patient,
        `P4 CfAuto ${tag}`,
        `F4CfAuto-${tag}`,
        addDays(ids.day, 7),
        CONSULTANTS.banshali.name,
      ],
    );
    await collect.autoProgress(db);
    expect((await itemsOf(made.patient)).find((i) => i.id === person.id).status).toBe("booked");

    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [later.id]);
    await collect.autoProgress(db);
    expect((await itemsOf(made.patient)).find((i) => i.id === person.id).status).toBe("done");
    const events = await query(
      `SELECT kind, to_status FROM care_followup_events WHERE followup_id = $1 ORDER BY id`,
      [person.id],
    );
    expect(events.rows).toEqual([
      { kind: "auto", to_status: "booked" },
      { kind: "auto", to_status: "done" },
    ]);
  });

  test("6. a removed referral closes its item", async () => {
    const made = await patientVisit("CfGone");
    const ref = await floorReferral(made, "Neurology");
    await collect.collectFollowups({ db });
    await query(`DELETE FROM giniflow_referrals WHERE id = $1`, [ref.id]);
    await collect.autoProgress(db);
    const items = await itemsOf(made.patient);
    expect(items.map((i) => [i.source, i.status, i.outcome_reason])).toEqual([
      ["gf_referral", "closed", "Referral removed at source"],
    ]);
  });

  test("7. history can't be edited or deleted", async () => {
    const made = await patientVisit("CfLock");
    await floorReferral(made, "Dermatology");
    await collect.collectFollowups({ db });
    const [item] = await itemsOf(made.patient);
    await actions.logCall(item.id, { call_status: "busy" }, coord, db);
    const update = await query(
      `UPDATE care_followup_events SET note = 'x' WHERE followup_id = $1`,
      [item.id],
    ).catch((e) => e);
    expect(String(update.message)).toContain("append-only");
    const del = await query(`DELETE FROM care_followup_events WHERE followup_id = $1`, [
      item.id,
    ]).catch((e) => e);
    expect(String(del.message)).toContain("append-only");
  });

  test("8. a referral written in the HealthRay note is collected once, and only real referrals", async () => {
    const made = await patientVisit("CfNote");
    const note = [
      "DIAGNOSIS",
      "TYPE 2 DM",
      "",
      "TREATMENT",
      "TAB COSPIAQ M 25/1000 BEFORE BREAKFAST",
      "ADVISED CONSULT WITH RHEUMATOLOGIST FOR HIP PAIN",
      "REFER TO DR E2E BANSHALI (FOR SUGARS)",
      "ONLINE CONSULT WITHIN 1 MONTH",
    ].join("\n");
    await query(`UPDATE appointments SET healthray_clinical_notes = $2 WHERE id = $1`, [
      made.appointment,
      note,
    ]);
    const later = await one(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_name, healthray_clinical_notes)
       SELECT patient_id, patient_name, file_no, appointment_date + 1, visit_type, doctor_name, $2
         FROM appointments WHERE id = $1 RETURNING id`,
      [made.appointment, note],
    );
    const dry = await collect.collectFollowups({ db, dryRun: true });
    expect(dry.sources.hr_note_referral.added).toBeGreaterThanOrEqual(1);
    expect(await itemsOf(made.patient)).toHaveLength(0);

    await collect.collectFollowups({ db });
    const items = (await itemsOf(made.patient)).filter((i) => i.source === "hr_note_referral");
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.target === "Dr E2E Banshali")).toMatchObject({
      kind: "consultant",
      matched_doctor_id: CONSULTANTS.banshali.id,
      availability: "in_house",
    });
    items.splice(
      items.findIndex((i) => i.target === "Dr E2E Banshali"),
      1,
    );
    expect(items[0]).toMatchObject({
      kind: "specialty",
      target: "Rheumatologist",
      matched_specialty: "Rheumatology",
      ordered_on: ids.day,
      status: "open",
    });
    const detail = await one(`SELECT detail FROM care_followups WHERE id = $1`, [items[0].id]);
    expect(detail.detail).toBe("ADVISED CONSULT WITH RHEUMATOLOGIST FOR HIP PAIN");

    await collect.collectFollowups({ db });
    expect(
      (await itemsOf(made.patient)).filter((i) => i.source === "hr_note_referral"),
    ).toHaveLength(2);
    await query(`DELETE FROM appointments WHERE id = $1`, [later.id]);
  });
});
