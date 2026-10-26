import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  resetCrm,
  importAll,
  xlsxBuffer,
} from "../helpers/crm.mjs";
import { one, query } from "../helpers/db.mjs";
import { addDays, ddmmyyyy, istDate, uploadWindow } from "../../server/crm/istPeriods.js";

const today = istDate();
const window = uploadWindow();

async function download(api) {
  const res = await api.get("/api/crm/visits/sheet.xlsx");
  expect(res.ok()).toBeTruthy();
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await res.body());
  return book;
}

function rowsOf(sheet) {
  const headers = sheet.getRow(1).values.slice(1);
  const rows = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    rows.push(Object.fromEntries(headers.map((h, i) => [h, row.values[i + 1] ?? ""])));
  });
  return rows;
}

async function upload(api, buffer, name = "visits.xlsx") {
  const res = await api.post(`/api/crm/visits/import/batches?name=${name}`, {
    data: buffer,
    headers: { "Content-Type": "application/octet-stream" },
  });
  return { res, body: await res.json() };
}

async function commitAll(api, id) {
  let summary;
  for (let i = 0; i < 50; i++) {
    const res = await api.post(`/api/crm/visits/import/batches/${id}/commit`);
    expect(res.ok()).toBeTruthy();
    summary = await res.json();
    if (summary.counts.ready === 0) break;
  }
  return summary;
}

async function rows(api, id, state = "all") {
  return (await (await api.get(`/api/crm/visits/import/batches/${id}/rows?state=${state}`)).json())
    .rows;
}

const visitsOf = async (crmId) =>
  (
    await one(
      `SELECT count(*)::int AS n FROM crm.visits WHERE executive_id = $1 AND deleted_at IS NULL`,
      [crmId],
    )
  ).n;

test.describe("CRM visit sheet: download, upload, undo", () => {
  let users;
  let hospitalId;
  let mine;
  let theirs;
  let rajesh;
  let sandeep;
  let virender;

  test.beforeEach(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    hospitalId = seeded.hospitalId;
    mine = await seedDoctors(hospitalId, [
      {
        full_name: "Dr Asha Kapoor",
        mobile: "9811100001",
        area: "Phase 7",
        owner: users.rajesh.crmId,
      },
      {
        full_name: "Dr Balraj Singh",
        mobile: "9811100002",
        area: "Kharar",
        owner: users.rajesh.crmId,
      },
      { full_name: "Dr Chetan Rao", mobile: null, area: "Sector 70", owner: users.rajesh.crmId },
      { full_name: "Dr Same Name", mobile: null, area: "Phase 3", owner: users.rajesh.crmId },
      { full_name: "Dr Same Name", mobile: null, area: "Phase 5", owner: users.rajesh.crmId },
    ]);
    theirs = await seedDoctors(hospitalId, [
      { full_name: "Dr Other Rep", mobile: "9811100099", owner: users.sandeep.crmId },
    ]);
    rajesh = await crmApi(users.rajesh);
    sandeep = await crmApi(users.sandeep);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  test("1. Download has my doctors only, my counts and a hidden Doctor ID", async () => {
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at)
       VALUES ($1, $2, $3, now())`,
      [hospitalId, mine[0].id, users.rajesh.crmId],
    );
    const book = await download(rajesh);
    const sheet = book.getWorksheet("Visits");
    const list = rowsOf(sheet);
    expect(list.map((r) => r["Doctor ID"]).sort()).toEqual(mine.map((d) => d.id).sort());
    expect(sheet.getColumn(1).hidden).toBe(true);
    const asha = list.find((r) => r["Doctor ID"] === mine[0].id);
    expect(asha).toMatchObject({ Today: 1, "This week": 1, "This month": 1 });
    expect(asha["Last visit"]).toBe(ddmmyyyy(today));
    const summary = rowsOf(book.getWorksheet("Summary"))[0];
    expect(summary).toMatchObject({
      Rep: "Rajesh Sharma",
      "Visits today": 1,
      "Assigned doctors": 5,
      "Not visited this month": 4,
    });
  });

  test("2. Upload the filled sheet, preview, commit, home counts rise", async () => {
    const book = await download(rajesh);
    const sheet = book.getWorksheet("Visits");
    sheet.getRow(2).getCell("J").value = new Date(`${today}T00:00:00Z`);
    sheet.getRow(2).getCell("K").value = "Completed";
    sheet.getRow(3).getCell("J").value = ddmmyyyy(today);
    sheet.getRow(3).getCell("K").value = "Doctor unavailable";
    sheet.getRow(3).getCell("M").value = "Positive";
    sheet.getRow(4).getCell("K").value = "Not visited";
    const { res, body } = await upload(rajesh, Buffer.from(await book.xlsx.writeBuffer()));
    expect(res.ok()).toBeTruthy();
    expect(body.counts).toMatchObject({
      total: 5,
      ready: 2,
      not_visited: 1,
      not_filled: 2,
      failed: 0,
    });
    const unavailable = (await rows(rajesh, body.batch.id, "ready")).find(
      (r) => r.visit_status === "doctor_unavailable",
    );
    expect(unavailable.visit_outcome).toBe("doctor_unavailable");
    expect(unavailable.flags[0]).toMatch(/outcome was set to Doctor unavailable/);

    const before = (await (await rajesh.get("/api/crm/home?lists=0")).json()).performance;
    const done = await commitAll(rajesh, body.batch.id);
    expect(done.counts).toMatchObject({ imported: 2, ready: 0 });
    expect(done.can_undo).toBe(true);
    const after = (await (await rajesh.get("/api/crm/home?lists=0")).json()).performance;
    expect(after.visits_today - before.visits_today).toBe(2);
    expect(after.unique_doctors_month - before.unique_doctors_month).toBe(2);
    const stored = await one(
      `SELECT count(*) FILTER (WHERE source = 'sheet' AND import_batch_id = $1)::int AS n,
              bool_and(occurred_at <= now()) AS not_future
         FROM crm.visits WHERE executive_id = $2`,
      [body.batch.id, users.rajesh.crmId],
    );
    expect(stored).toEqual({ n: 2, not_future: true });
  });

  test("3. Already logged: app visit, repeat in the file, and a re-upload", async () => {
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at)
       VALUES ($1, $2, $3, now())`,
      [hospitalId, mine[0].id, users.rajesh.crmId],
    );
    const sheet = await xlsxBuffer([
      { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      { "Doctor ID": mine[1].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      { "Doctor ID": mine[1].id, "Visit date": ddmmyyyy(today), Status: "Doctor unavailable" },
    ]);
    const first = await upload(rajesh, sheet);
    expect(first.body.counts).toMatchObject({ ready: 1, already_logged: 2 });
    await commitAll(rajesh, first.body.batch.id);
    const again = await upload(rajesh, sheet);
    expect(again.body.counts).toMatchObject({ ready: 0, already_logged: 3 });
    expect(await visitsOf(users.rajesh.crmId)).toBe(2);
  });

  test("4. Another rep's doctor, future, bad date, early date and bad status fail", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": theirs[0].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
        { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(addDays(today, 1)), Status: "Completed" },
        { "Doctor ID": mine[1].id, "Visit date": "yesterday", Status: "Completed" },
        {
          "Doctor ID": mine[2].id,
          "Visit date": ddmmyyyy(addDays(window.from, -1)),
          Status: "Completed",
        },
        { "Doctor ID": mine[2].id, "Visit date": ddmmyyyy(today), Status: "Maybe" },
        {
          "Doctor ID": mine[2].id,
          "Visit date": ddmmyyyy(today),
          Status: "Completed",
          "Visit type": "Pigeon",
        },
      ]),
    );
    expect(body.counts).toMatchObject({ failed: 6, ready: 0 });
    const reasons = (await rows(rajesh, body.batch.id, "failed")).map((r) => r.fail_reason);
    expect(reasons).toEqual([
      "This doctor is not assigned to you, or was removed from the CRM.",
      "Visit date is in the future.",
      "Visit date must be a date like 21-10-2026.",
      `Only visits from ${ddmmyyyy(window.from)} to today can be uploaded (this month and this week).`,
      "Status must be Completed, Doctor unavailable or Not visited.",
      "Choose a visit type from the list.",
    ]);
  });

  test("5. Name-only sheet: unique names match, a shared name asks to pick", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { Doctor: "chetan rao", "Visit date": ddmmyyyy(today), Status: "done" },
        { Doctor: "Dr Same Name", "Visit date": ddmmyyyy(today), Status: "Completed" },
        {
          Doctor: "Dr Same Name",
          Area: "Phase 5",
          "Visit date": ddmmyyyy(today),
          Status: "Completed",
        },
        { Doctor: "Dr Nobody", "Visit date": ddmmyyyy(today), Status: "Completed" },
        {
          Doctor: "",
          Mobile: "+91 98111 00002",
          "Visit date": ddmmyyyy(today),
          Status: "Completed",
        },
      ]),
    );
    const list = await rows(rajesh, body.batch.id);
    expect(list.map((r) => [r.visit_state, r.doctor_match])).toEqual([
      ["ready", "name"],
      ["failed", null],
      ["ready", "name"],
      ["failed", null],
      ["ready", "mobile"],
    ]);
    expect(list[1].fail_reason).toBe(
      "More than one of your doctors is called Dr Same Name. Pick the doctor.",
    );
    expect(list[2].matched_doctor_id).toBe(mine[4].id);
  });

  test("6. Retry a fixed failed row; failed.xlsx has the Reason column", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { Doctor: "Dr Same Name", "Visit date": ddmmyyyy(today), Status: "Completed" },
        { Doctor: "Dr Chetan Rao", "Visit date": "32-13-2026", Status: "Completed" },
      ]),
    );
    const file = await rajesh.get(`/api/crm/visits/import/batches/${body.batch.id}/failed.xlsx`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await file.body());
    const failed = rowsOf(book.worksheets[0]);
    expect(failed.map((r) => r.Reason)).toEqual([
      "More than one of your doctors is called Dr Same Name. Pick the doctor.",
      "Visit date must be a date like 21-10-2026.",
    ]);

    const picker = await (await rajesh.get("/api/crm/visits/doctors?q=same")).json();
    expect(picker.map((d) => d.id).sort()).toEqual([mine[3].id, mine[4].id].sort());
    const res = await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/retry`, {
      data: {
        rows: [
          { row_number: 2, doctor_id: mine[3].id },
          { row_number: 3, visit_date: today },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const retried = await res.json();
    expect(retried.counts).toMatchObject({ imported: 2, failed: 0 });
    const bad = await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/retry`, {
      data: { rows: [{ row_number: 2, doctor_id: theirs[0].id }] },
    });
    expect(bad.status()).toBe(409);
  });

  test("7. A rep cannot read, commit or undo another rep's upload", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
    );
    const id = body.batch.id;
    for (const api of [sandeep, virender]) {
      expect((await api.get(`/api/crm/visits/import/batches/${id}/summary`)).status()).toBe(404);
      expect((await api.post(`/api/crm/visits/import/batches/${id}/commit`)).status()).toBe(404);
      expect((await api.post(`/api/crm/visits/import/batches/${id}/undo`)).status()).toBe(404);
    }
    expect((await rajesh.get(`/api/crm/visits/import/batches/not-a-uuid/summary`)).status()).toBe(
      404,
    );
    expect(await visitsOf(users.rajesh.crmId)).toBe(0);
  });

  test("8. A visit at 00:30 IST counts as today", async () => {
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at)
       VALUES ($1, $2, $3, ($4::date + time '00:30') AT TIME ZONE 'Asia/Kolkata')`,
      [hospitalId, mine[0].id, users.rajesh.crmId, today],
    );
    const home = await (await rajesh.get("/api/crm/home?lists=0")).json();
    expect(home.performance.visits_today).toBe(1);
    expect(home.todays_visits.map((v) => v.doctor_id)).toEqual([mine[0].id]);
  });

  test("9. Undo the same day removes only that upload's visits", async () => {
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at)
       VALUES ($1, $2, $3, now())`,
      [hospitalId, mine[0].id, users.rajesh.crmId],
    );
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": mine[1].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
        { "Doctor ID": mine[2].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
    );
    await commitAll(rajesh, body.batch.id);
    expect(await visitsOf(users.rajesh.crmId)).toBe(3);
    const list = await (await rajesh.get("/api/crm/visits/import/batches")).json();
    expect(list[0]).toMatchObject({ id: body.batch.id, imported: 2, can_undo: true });
    const undo = await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/undo`);
    expect(undo.ok()).toBeTruthy();
    expect((await undo.json()).undone).toBe(2);
    expect(await visitsOf(users.rajesh.crmId)).toBe(1);
    expect(
      (await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/undo`)).status(),
    ).toBe(409);
    expect(
      (await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/commit`)).status(),
    ).toBe(409);
  });

  test("10. Undo is refused after midnight IST", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": mine[1].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
    );
    await commitAll(rajesh, body.batch.id);
    await query(
      `UPDATE crm.import_batches SET created_at = now() - interval '1 day' WHERE id = $1`,
      [body.batch.id],
    );
    const undo = await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/undo`);
    expect(undo.status()).toBe(409);
    expect((await undo.json()).error).toBe("An upload can only be undone on the day it was made.");
    expect(await visitsOf(users.rajesh.crmId)).toBe(1);
  });

  test("11. Two commits of the same file at once insert each visit once", async () => {
    const sheet = await xlsxBuffer(
      mine
        .slice(0, 3)
        .map((d) => ({ "Doctor ID": d.id, "Visit date": ddmmyyyy(today), Status: "Completed" })),
    );
    const a = await upload(rajesh, sheet, "a.xlsx");
    const b = await upload(rajesh, sheet, "b.xlsx");
    await Promise.all([commitAll(rajesh, a.body.batch.id), commitAll(rajesh, b.body.batch.id)]);
    expect(await visitsOf(users.rajesh.crmId)).toBe(3);
    const states = [
      ...(await rows(rajesh, a.body.batch.id)),
      ...(await rows(rajesh, b.body.batch.id)),
    ].map((r) => r.visit_state);
    expect(states.filter((s) => s === "imported")).toHaveLength(3);
    expect(states.filter((s) => s === "already_logged")).toHaveLength(3);
  });

  test("12. Upload and doctor-import batch ids cannot cross over", async () => {
    const visits = await upload(
      virender,
      await xlsxBuffer([
        { Doctor: "Dr Nobody", "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
    );
    expect(
      (await virender.get(`/api/crm/import/batches/${visits.body.batch.id}/summary`)).status(),
    ).toBe(404);
    expect(
      (await virender.post(`/api/crm/import/batches/${visits.body.batch.id}/commit`)).status(),
    ).toBe(404);
    const doctors = await importAll(
      virender,
      [{ "Full name": "Dr Fresh Import", Mobile: "9811100555" }],
      "d.xlsx",
    );
    expect(
      (await virender.get(`/api/crm/visits/import/batches/${doctors.id}/summary`)).status(),
    ).toBe(404);
  });

  test("13. An app visit after a sheet visit the same day is skipped, and the queue drains", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
    );
    await commitAll(rajesh, body.batch.id);
    const res = await rajesh.post("/api/crm/visits", {
      data: {
        id: crypto.randomUUID(),
        doctor_id: mine[0].id,
        occurred_at: new Date().toISOString(),
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ duplicate: true, reason: "already_logged_today" });
    const other = await rajesh.post("/api/crm/visits", {
      data: { id: crypto.randomUUID(), doctor_id: mine[1].id },
    });
    expect(await other.json()).toMatchObject({ duplicate: false });
    expect(await visitsOf(users.rajesh.crmId)).toBe(2);
  });

  test("14. Head of growth summary has a row per rep plus the team total", async () => {
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at)
       VALUES ($1, $2, $3, now()), ($1, $4, $5, now())`,
      [hospitalId, mine[0].id, users.rajesh.crmId, theirs[0].id, users.sandeep.crmId],
    );
    const book = await download(virender);
    const summary = rowsOf(book.getWorksheet("Summary")).filter((r) => r.Rep);
    const byRep = Object.fromEntries(summary.map((r) => [r.Rep, r]));
    expect(byRep["Rajesh Sharma"]).toMatchObject({ "Visits today": 1, "Assigned doctors": 5 });
    expect(byRep["Sandeep Sangroy"]).toMatchObject({ "Visits today": 1, "Assigned doctors": 1 });
    expect(byRep["Team total"]["Visits today"]).toBe(2);
    expect(rowsOf(book.getWorksheet("Visits"))[0].Doctor).toMatch(/No doctors are assigned to you/);
  });

  test("15. A sheet without the visit columns is refused with a clear message", async () => {
    const { res, body } = await upload(rajesh, await xlsxBuffer([{ Doctor: "Dr Asha Kapoor" }]));
    expect(res.status()).toBe(400);
    expect(body.error).toMatch(/needs a “Visit date” and a “Status” column/);
    const junk = await upload(rajesh, Buffer.from("not a spreadsheet at all"));
    expect(junk.res.status()).toBe(400);
  });

  test("16. CSV: blank rows keep row numbers, dates read day-first, Dr.Name matches", async () => {
    const csv = [
      "Doctor,Visit date,Status",
      `Dr.Asha Kapoor,${ddmmyyyy(today)},Completed`,
      ",,",
      `Balraj Singh,${today.slice(8)}/${today.slice(5, 7)}/${today.slice(0, 4)},Completed`,
      "Dr Chetan Rao,03/04/2026,Completed",
    ].join("\n");
    const { body } = await upload(rajesh, Buffer.from(csv), "visits.csv");
    const list = await rows(rajesh, body.batch.id);
    expect(list.map((r) => [r.row_number, r.visit_state])).toEqual([
      [2, "ready"],
      [4, "ready"],
      [5, today >= "2026-04-03" && window.from <= "2026-04-03" ? "ready" : "failed"],
    ]);
    expect(list[0].matched_doctor_id).toBe(mine[0].id);
    expect(list[2].visit_date).toBe("2026-04-03");
  });

  test("17. The sheet's date rule uses TODAY(), so an old download still accepts today", async () => {
    const book = await download(rajesh);
    const cell = book.getWorksheet("Visits").getCell("J2");
    expect(cell.dataValidation).toMatchObject({
      type: "custom",
      errorStyle: "warning",
      formulae: ["AND(ISNUMBER(J2),J2<=TODAY())"],
    });
    expect(cell.numFmt).toBe("dd-mm-yyyy");
  });

  test("18. An upload that did not finish reading is hidden and cannot be imported", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
    );
    await query(`UPDATE crm.import_batches SET status = 'failed' WHERE id = $1`, [body.batch.id]);
    const list = await (await rajesh.get("/api/crm/visits/import/batches")).json();
    expect(list.map((b) => b.id)).not.toContain(body.batch.id);
    const commit = await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/commit`);
    expect(commit.status()).toBe(409);
    expect((await commit.json()).error).toBe(
      "This upload did not finish reading. Upload the sheet again.",
    );
    expect(await visitsOf(users.rajesh.crmId)).toBe(0);
  });

  test("19. Download file names are safe for the header", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { Doctor: "Dr Nobody", "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
      encodeURIComponent('bad"name\r\nX-Injected: 1.xlsx'),
    );
    const res = await rajesh.get(`/api/crm/visits/import/batches/${body.batch.id}/failed.xlsx`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="[\w.\- ]+"$/);
    expect(res.headers()["x-injected"]).toBeUndefined();
  });

  test("20. A row with several problems lists them all at once", async () => {
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { Doctor: "Dr Nobody", "Visit date": "soon", Status: "Maybe", Outcome: "Great" },
      ]),
    );
    const [row] = await rows(rajesh, body.batch.id, "failed");
    expect(row.fail_reason).toBe(
      [
        "Status must be Completed, Doctor unavailable or Not visited.",
        "No doctor of yours is called Dr Nobody. Pick the doctor.",
        "Visit date must be a date like 21-10-2026.",
        "Choose an outcome from the list.",
      ].join(" "),
    );
  });

  test("21. Next visit date marks a follow-up; bad dates fail and can be fixed", async () => {
    const d = today;
    const { body } = await upload(
      rajesh,
      await xlsxBuffer([
        { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(d), Status: "Completed" },
        {
          "Doctor ID": mine[1].id,
          "Visit date": ddmmyyyy(d),
          Status: "Completed",
          "Next visit date": ddmmyyyy(addDays(d, 7)),
        },
        {
          "Doctor ID": mine[2].id,
          "Visit date": ddmmyyyy(d),
          Status: "Completed",
          "Next visit date": "whenever",
        },
        {
          "Doctor ID": mine[4].id,
          "Visit date": ddmmyyyy(d),
          Status: "Completed",
          "Next visit date": ddmmyyyy(d),
        },
        {
          "Doctor ID": mine[3].id,
          "Visit date": ddmmyyyy(d),
          Status: "Completed",
          "Next visit date": ddmmyyyy(addDays(d, 400)),
        },
      ]),
    );
    const list = await rows(rajesh, body.batch.id);
    expect(list.map((r) => [r.visit_state, r.follow_up_required, r.next_visit_date])).toEqual([
      ["ready", false, null],
      ["ready", true, addDays(d, 7)],
      ["failed", false, null],
      ["failed", false, null],
      ["failed", false, null],
    ]);
    expect(list.slice(2).map((r) => r.fail_reason)).toEqual([
      "Next visit date must be a date like 21-10-2026.",
      "Next visit date must be after the visit date.",
      "Next visit date must be within a year of the visit.",
    ]);

    await commitAll(rajesh, body.batch.id);
    const stored = await query(
      `SELECT doctor_id, follow_up_required, next_visit_date::text AS next_visit_date
         FROM crm.visits WHERE import_batch_id = $1`,
      [body.batch.id],
    );
    const byDoctor = Object.fromEntries(stored.rows.map((r) => [r.doctor_id, r]));
    expect(byDoctor[mine[0].id]).toMatchObject({
      follow_up_required: false,
      next_visit_date: null,
    });
    expect(byDoctor[mine[1].id]).toMatchObject({
      follow_up_required: true,
      next_visit_date: addDays(d, 7),
    });

    const res = await rajesh.post(`/api/crm/visits/import/batches/${body.batch.id}/retry`, {
      data: {
        rows: [
          { row_number: 5, next_visit: addDays(d, 14) },
          { row_number: 6, next_visit: null },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).counts.imported).toBe(4);
    const fixed = await query(
      `SELECT doctor_id, follow_up_required, next_visit_date::text AS n FROM crm.visits
        WHERE doctor_id = ANY($1::uuid[])`,
      [[mine[2].id, mine[4].id, mine[3].id]],
    );
    const fixedBy = Object.fromEntries(fixed.rows.map((r) => [r.doctor_id, r]));
    expect(fixedBy[mine[4].id]).toMatchObject({ follow_up_required: true, n: addDays(d, 14) });
    expect(fixedBy[mine[3].id]).toMatchObject({ follow_up_required: false, n: null });
    expect(fixedBy[mine[2].id]).toBeUndefined();
  });

  test("22. The sheet has a Next visit date column with a date rule and no Needs follow-up", async () => {
    const book = await download(rajesh);
    const sheet = book.getWorksheet("Visits");
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      "Doctor ID",
      "Doctor",
      "Specialty",
      "Area",
      "Mobile",
      "Last visit",
      "Today",
      "This week",
      "This month",
      "Visit date",
      "Status",
      "Visit type",
      "Outcome",
      "Next visit date",
      "Notes",
    ]);
    expect(sheet.getCell("N2").dataValidation.formulae).toEqual(["AND(ISNUMBER(N2),N2>J2)"]);
    expect(sheet.getCell("N2").numFmt).toBe("dd-mm-yyyy");
    expect(book.getWorksheet("Lists").getColumn(4).values.filter(Boolean)).toEqual([]);
  });

  test("23. Recent uploads list only uploads that imported a visit", async () => {
    const sheet = await xlsxBuffer([
      { "Doctor ID": mine[0].id, "Visit date": ddmmyyyy(today), Status: "Completed" },
    ]);
    await upload(rajesh, sheet, "previewed-only.xlsx");
    const discarded = await upload(rajesh, sheet, "discarded.xlsx");
    await query(`UPDATE crm.import_batches SET status = 'cancelled' WHERE id = $1`, [
      discarded.body.batch.id,
    ]);
    await upload(
      rajesh,
      await xlsxBuffer([
        { Doctor: "Dr Nobody", "Visit date": ddmmyyyy(today), Status: "Completed" },
      ]),
      "all-failed.xlsx",
    );
    const undone = await upload(rajesh, sheet, "undone.xlsx");
    await commitAll(rajesh, undone.body.batch.id);
    await rajesh.post(`/api/crm/visits/import/batches/${undone.body.batch.id}/undo`);
    const list = await (await rajesh.get("/api/crm/visits/import/batches")).json();
    expect(list.map((b) => b.file_name)).toEqual(["undone.xlsx"]);
    expect(list[0]).toMatchObject({ status: "cancelled", imported: 1, can_undo: false });
  });
});
