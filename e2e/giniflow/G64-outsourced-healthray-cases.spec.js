import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/receptionStation.js");
const items = await import("../../server/services/billing/serviceItems.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const hold = await import("../../server/services/giniflow/testsHold.js");
const { listOutsidePending } = await import("../../server/services/giniflow/outsidePending.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.64", role: "admin" };
let ids;
let seq = 0;
const visits = {};
const cases = {};

async function labCase(visit, tests, { daysAgo = 0, source = null } = {}) {
  seq += 1;
  const caseNo = `G64-${tag}-${seq}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json,
                            case_source)
     VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date - $7::int, 'Registered', $8::jsonb, $9)`,
    [
      caseNo,
      980000 + seq,
      visit.patient,
      visit.appointment,
      tests,
      ids.day,
      daysAgo,
      JSON.stringify({ case_status: "Registered", patient: { healthray_uid: null } }),
      source,
    ],
  );
  await query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
     VALUES ($1, 'sample_taken', 'lab', $2)`,
    [caseNo, USERS.lab.id],
  );
  return caseNo;
}

const refusal = (promise) => promise.then(() => null).catch((error) => error);

const caseOnQueue = async (caseNo, room = "collection") => {
  const data = await lab.getLabQueue(ids.day, null, db, { room });
  return (data.healthray || [])
    .flatMap((row) => row.caseList || [])
    .find((c) => c.caseNo === caseNo);
};

const pendingKeys = async () =>
  (await listOutsidePending({ q: tag }, db)).rows.map((row) => `${row.status}:${row.caseNo}`);

test.describe.serial("G64 outsourced HealthRay cases are sent out and listed", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await items.updateItem(ids.hba1c, { is_outsourced: true }, admin, db);
    visits.today = await extraVisit(ids, "CaseOut");
    visits.old = await extraVisit(ids, "CaseOld");
    cases.outside = await labCase(visits.today, [ids.hba1cName]);
    cases.inHouse = await labCase(visits.today, [ids.looseName]);
    cases.hrOutsource = await labCase(visits.old, [`External panel ${tag}`], {
      daysAgo: 2,
      source: "outsource",
    });
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no LIKE $1`, [`G64-${tag}-%`]);
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`G64-${tag}-%`]);
    await tearDown(ids);
  });

  test("1. both collected cases hold the patient before anything is sent", async () => {
    expect((await hold.getTestsHold(visits.today.visit, db)).count).toBe(2);
  });

  test("2. the collection room offers Send to outside lab only on the outsourced case", async () => {
    const outside = await caseOnQueue(cases.outside);
    expect(outside.outsourced).toBe(true);
    expect(outside.nextAction).toEqual({
      action: "sent_outside",
      label: "📮 Mark sent to outside lab",
    });
    const inHouse = await caseOnQueue(cases.inHouse);
    expect(inHouse.outsourced).toBe(false);
    expect(inHouse.nextAction?.action).not.toBe("sent_outside");
  });

  test("3. only an outsourced, collected case can be sent, and only by the collection room", async () => {
    const notOutsourced = await refusal(
      lab.markCaseSentOutside(cases.inHouse, { room: "collection" }, db),
    );
    expect(notOutsourced?.status).toBe(409);
    const byBench = await refusal(
      lab.markCaseSentOutside(cases.outside, { room: "processing" }, db),
    );
    expect(byBench?.status).toBe(403);
    const sent = await lab.markCaseSentOutside(
      cases.outside,
      { room: "collection", actorId: USERS.lab.id },
      db,
    );
    expect(sent.unchanged).toBe(false);
    expect(
      (await lab.markCaseSentOutside(cases.outside, { room: "collection" }, db)).unchanged,
    ).toBe(true);
  });

  test("4. once sent, the case no longer holds the patient and reads Sent to outside lab", async () => {
    expect((await hold.getTestsHold(visits.today.visit, db)).count).toBe(1);
    const outside = await caseOnQueue(cases.outside);
    expect(outside.sentOutside).toBe(true);
    expect(outside.nextAction).toBeNull();
    expect(outside.stage.label).toBe("📮 Sent to outside lab");
  });

  test("5. the pending list carries outsourced cases from any day, never in-house ones", async () => {
    expect(await pendingKeys()).toEqual([
      `collected:${cases.hrOutsource}`,
      `sent:${cases.outside}`,
    ]);
    const old = (await listOutsidePending({ q: tag }, db)).rows[0];
    expect(old).toMatchObject({ kind: "case", daysWaiting: 2, status: "collected" });
  });

  test("6. lab staff send and upload through the API; an in-house case is refused", async () => {
    const api = await apiAs("lab");
    const sent = await api.post(`/api/giniflow/stations/lab/case/${cases.hrOutsource}/sent-outside`, {
      data: {},
    });
    expect(sent.status()).toBe(200);
    const body = {
      base64: Buffer.from("%PDF-1.4").toString("base64"),
      fileName: "r.pdf",
      mediaType: "application/pdf",
    };
    const inHouse = await api.post(
      `/api/giniflow/stations/lab/case/${cases.inHouse}/outside-report`,
      { data: body },
    );
    expect(inHouse.status()).toBe(409);
    const outside = await api.post(
      `/api/giniflow/stations/lab/case/${cases.outside}/outside-report`,
      { data: body },
    );
    expect([200, 503]).toContain(outside.status());
    await api.dispose();
    expect(await pendingKeys()).toEqual([
      `sent:${cases.hrOutsource}`,
      `sent:${cases.outside}`,
    ]);
  });

  test("7. the panel lists the cases and a returned report clears them", async ({ page }) => {
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    const panel = page.getByRole("region", { name: "Outside reports pending" });
    await panel.getByLabel("Search outside reports").fill(tag);
    const table = panel.getByRole("table", { name: "Outside reports pending" });
    await expect(table.getByRole("row").filter({ hasText: `CaseOld ${tag}` })).toContainText(
      "2 days",
    );
    await expect(table.getByRole("row").filter({ hasText: `CaseOut ${tag}` })).toContainText(
      "Sent to outside lab",
    );

    await query(`UPDATE lab_cases SET pdf_storage_path = 'x/report.pdf' WHERE case_no = $1`, [
      cases.outside,
    ]);
    await query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role) VALUES ($1, 'report_uploaded', 'lab')`,
      [cases.hrOutsource],
    );
    expect(await pendingKeys()).toEqual([]);
    await page.reload();
    await panel.getByLabel("Search outside reports").fill(tag);
    await expect(panel.getByText("No outside reports match these filters.")).toBeVisible();
  });
});
