import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ExcelJS from "exceljs";
import { buildTestEnv, repoRoot } from "../setup/testEnv.mjs";
import { seedCrmStaff, seedDoctors, crmApi, resetCrm } from "../helpers/crm.mjs";
import { one, query } from "../helpers/db.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";

const json = async (res) => ({ status: res.status(), body: await res.json() });
const today = istDate();

test.describe("CRM tasks and Today: follow-ups from visits, manual tasks, team view", () => {
  let users;
  let hospitalId;
  let rajesh;
  let sandeep;
  let virender;
  let docs;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const s = await seedCrmStaff();
    users = s.users;
    hospitalId = s.hospitalId;
    docs = await seedDoctors(hospitalId, [
      { full_name: "Dr Task One", mobile: "9833300001", area: "Kharar", owner: users.rajesh.crmId },
      { full_name: "Dr Task Two", mobile: "9833300002", area: "Kharar", owner: users.rajesh.crmId },
      {
        full_name: "Dr Task Three",
        mobile: "9833300003",
        area: "Kharar",
        owner: users.rajesh.crmId,
      },
      {
        full_name: "Dr Task Four",
        mobile: "9833300004",
        area: "Kharar",
        owner: users.rajesh.crmId,
      },
      {
        full_name: "Dr Sandeep Task",
        mobile: "9833300005",
        area: "Sohana",
        owner: users.sandeep.crmId,
      },
    ]);
    rajesh = await crmApi(users.rajesh);
    sandeep = await crmApi(users.sandeep);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  const logVisit = (api, doctor, extra = {}) =>
    api
      .post("/api/crm/visits", {
        data: { id: crypto.randomUUID(), doctor_id: doctor.id, visit_type: "in_person", ...extra },
      })
      .then(json);

  const tasksOf = (doctor) =>
    query(
      `SELECT kind, status, due_date::text AS due_date, cancel_reason, title
         FROM crm.tasks WHERE doctor_id = $1 ORDER BY created_at, id`,
      [doctor.id],
    ).then((r) => r.rows);

  test("1. A visit with a next visit date creates a follow-up; a promise creates a promise task", async () => {
    const next = addDays(today, 5);
    const res = await logVisit(rajesh, docs[0], {
      status: "completed",
      follow_up_required: true,
      next_visit_date: next,
      commitments: "Send the diabetes camp brochure",
    });
    expect(res.status).toBe(200);
    const tasks = await tasksOf(docs[0]);
    expect([...tasks].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      expect.objectContaining({
        kind: "follow_up_visit",
        status: "open",
        due_date: next,
        title: "Visit Dr Task One",
      }),
      expect.objectContaining({
        kind: "promise",
        status: "open",
        due_date: next,
        title: "Send the diabetes camp brochure",
      }),
    ]);
  });

  test("2. A follow-up due today shows in Today; logging the visit closes it; undo reopens it", async () => {
    const doc = docs[1];
    await query(
      `INSERT INTO crm.tasks (hospital_id, title, owner_id, doctor_id, due_date, kind, created_by, created_at)
       VALUES ($1, 'Visit Dr Task Two', $2, $3, $4, 'follow_up_visit', $2, now() - interval '3 days')`,
      [hospitalId, users.rajesh.crmId, doc.id, today],
    );
    let view = await json(await rajesh.get("/api/crm/today"));
    expect(view.body.due.map((t) => t.doctor_name)).toContain("Dr Task Two");
    expect(view.body.team).toBeNull();

    const unavailable = await logVisit(rajesh, doc, { status: "doctor_unavailable" });
    expect((await tasksOf(doc))[0].status).toBe("open");
    await rajesh.post(`/api/crm/visits/${unavailable.body.id}/undo`, { data: {} });

    const visit = await logVisit(rajesh, doc, { status: "completed" });
    expect((await tasksOf(doc))[0].status).toBe("done");
    view = await json(await rajesh.get("/api/crm/today"));
    expect(view.body.due.map((t) => t.doctor_name)).not.toContain("Dr Task Two");
    expect(view.body.done.map((v) => v.full_name)).toContain("Dr Task Two");

    await rajesh.post(`/api/crm/visits/${visit.body.id}/undo`, { data: {} });
    expect((await tasksOf(doc))[0].status).toBe("open");
  });

  test("3. A newer next visit date replaces the open follow-up; a same-day edit moves it", async () => {
    const doc = docs[2];
    const first = addDays(today, 3);
    await query(
      `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at, next_visit_date)
       VALUES ($1, $2, $3, now() - interval '2 days', $4) RETURNING id`,
      [hospitalId, doc.id, users.rajesh.crmId, first],
    );
    await query(
      `INSERT INTO crm.tasks (hospital_id, title, owner_id, doctor_id, due_date, kind, created_by, created_at)
       VALUES ($1, 'Visit Dr Task Three', $2, $3, $4, 'follow_up_visit', $2, now() - interval '2 days')`,
      [hospitalId, users.rajesh.crmId, doc.id, first],
    );
    const later = addDays(today, 10);
    const visit = await logVisit(rajesh, doc, {
      status: "doctor_unavailable",
      follow_up_required: true,
      next_visit_date: later,
    });
    let tasks = await tasksOf(doc);
    expect(tasks.map((t) => [t.status, t.due_date])).toEqual([
      ["cancelled", first],
      ["open", later],
    ]);
    expect(tasks[0].cancel_reason).toBe("Replaced by a newer next visit date");

    const moved = addDays(today, 7);
    await rajesh.put(`/api/crm/visits/${visit.body.id}`, { data: { next_visit_date: moved } });
    tasks = await tasksOf(doc);
    expect(tasks.filter((t) => t.status === "open").map((t) => t.due_date)).toEqual([moved]);

    await rajesh.put(`/api/crm/visits/${visit.body.id}`, { data: { next_visit_date: null } });
    expect((await tasksOf(doc)).filter((t) => t.status === "open")).toHaveLength(0);
  });

  test("4. Sheet uploads create follow-ups and their undo cancels them", async () => {
    const doc = docs[3];
    const next = addDays(today, 4);
    const res = await rajesh.get("/api/crm/visits/sheet.xlsx");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await res.body());
    const sheet = book.getWorksheet("Visits");
    let target = null;
    sheet.eachRow((row, n) => {
      if (n > 1 && row.getCell("A").value === doc.id) target = row;
    });
    target.getCell("J").value = today.split("-").reverse().join("-");
    target.getCell("K").value = "Completed";
    target.getCell("N").value = next.split("-").reverse().join("-");
    const staged = await json(
      await rajesh.post("/api/crm/visits/import/batches?name=tasks.xlsx", {
        data: Buffer.from(await book.xlsx.writeBuffer()),
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    expect(staged.status).toBe(200);
    const id = staged.body.batch.id;
    for (let i = 0; i < 10; i++) {
      const done = await json(await rajesh.post(`/api/crm/visits/import/batches/${id}/commit`));
      expect(done.status).toBe(200);
      if (done.body.counts.ready === 0) break;
    }
    expect((await tasksOf(doc)).map((t) => [t.kind, t.status, t.due_date])).toEqual([
      ["follow_up_visit", "open", next],
    ]);
    await rajesh.post(`/api/crm/visits/import/batches/${id}/undo`);
    expect((await tasksOf(doc))[0]).toMatchObject({
      status: "cancelled",
      cancel_reason: "Visit undone",
    });
  });

  test("5. Manual tasks: validation, done, cancel with reason, reopen within 10 minutes", async () => {
    const bad = await json(await rajesh.post("/api/crm/tasks", { data: { title: "x" } }));
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toMatchObject({
      title: "Write what needs doing, like Send the CME invite.",
      due_date: "Choose a due date.",
    });
    const past = await json(
      await rajesh.post("/api/crm/tasks", {
        data: { title: "Old task", due_date: addDays(today, -1) },
      }),
    );
    expect(past.body.error).toBe("The due date cannot be in the past.");
    const notMine = await json(
      await rajesh.post("/api/crm/tasks", {
        data: { title: "Call him", due_date: today, doctor_id: docs[4].id },
      }),
    );
    expect(notMine.body.error).toBe("Choose a doctor from your list.");

    const made = await json(
      await rajesh.post("/api/crm/tasks", {
        data: {
          title: "Send CME invite",
          due_date: today,
          doctor_id: docs[0].id,
          priority: "high",
          owner_id: users.sandeep.crmId,
        },
      }),
    );
    expect(made.body.owner_id).toBe(users.rajesh.crmId);

    const list = await json(await rajesh.get("/api/crm/tasks"));
    expect(list.body.rows.map((t) => t.title)).toContain("Send CME invite");
    expect(list.body.can_assign).toBe(false);

    expect((await sandeep.post(`/api/crm/tasks/${made.body.id}/done`)).status()).toBe(404);
    expect((await json(await rajesh.post(`/api/crm/tasks/${made.body.id}/done`))).body.status).toBe(
      "done",
    );
    expect((await json(await rajesh.post(`/api/crm/tasks/${made.body.id}/done`))).status).toBe(409);
    expect(
      (await json(await rajesh.post(`/api/crm/tasks/${made.body.id}/reopen`))).body.status,
    ).toBe("open");

    const noReason = await json(
      await rajesh.post(`/api/crm/tasks/${made.body.id}/cancel`, { data: {} }),
    );
    expect(noReason.status).toBe(400);
    await rajesh.post(`/api/crm/tasks/${made.body.id}/cancel`, {
      data: { reason: "Event cancelled" },
    });
    await query(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       UPDATE crm.tasks SET updated_at = now() - interval '11 minutes' WHERE id = '${made.body.id}';
       COMMIT;`,
    );
    const late = await json(await rajesh.post(`/api/crm/tasks/${made.body.id}/reopen`));
    expect(late.status).toBe(409);
    const done = await json(await rajesh.get("/api/crm/tasks?bucket=done"));
    expect(done.body.rows.find((t) => t.id === made.body.id)).toMatchObject({
      status: "cancelled",
      cancel_reason: "Event cancelled",
    });
  });

  test("6. Admin assigns a task to a rep and sees the team in Today", async () => {
    const made = await json(
      await virender.post("/api/crm/tasks", {
        data: {
          title: "Meet Dr Sandeep Task at OPD",
          due_date: today,
          owner_id: users.sandeep.crmId,
        },
      }),
    );
    expect(made.body.owner_id).toBe(users.sandeep.crmId);
    const sandeepTasks = await json(await sandeep.get("/api/crm/tasks"));
    expect(sandeepTasks.body.rows[0]).toMatchObject({
      title: "Meet Dr Sandeep Task at OPD",
      created_by_name: "Virender Satija",
    });
    expect(
      (await json(await rajesh.get("/api/crm/tasks"))).body.rows.map((t) => t.title),
    ).not.toContain("Meet Dr Sandeep Task at OPD");

    const view = await json(await virender.get("/api/crm/today"));
    const names = view.body.team.map((r) => r.full_name);
    expect(names).toEqual(expect.arrayContaining(["Rajesh Sharma", "Sandeep Sangroy"]));
    const raj = view.body.team.find((r) => r.full_name === "Rajesh Sharma");
    expect(raj.visits_today).toBeGreaterThan(0);

    const onlySandeep = await json(await virender.get(`/api/crm/today?rep=${users.sandeep.crmId}`));
    expect(onlySandeep.body.other.map((t) => t.title)).toEqual(["Meet Dr Sandeep Task at OPD"]);
    expect((await rajesh.get(`/api/crm/today?rep=${users.sandeep.crmId}`)).status()).toBe(200);
    const ignored = await json(await rajesh.get(`/api/crm/today?rep=${users.sandeep.crmId}`));
    expect(ignored.body.rep).toBe(users.rajesh.crmId);

    expect((await virender.get("/api/crm/tasks?owner=nope")).status()).toBe(400);
    const all = await json(await virender.get("/api/crm/tasks?bucket=upcoming"));
    expect(all.body.can_assign).toBe(true);
  });

  test("7. Removing a doctor cancels its open tasks", async () => {
    const doc = docs[0];
    await virender.post(`/api/crm/doctors/${doc.id}/removal`, { data: { reason: "duplicate" } });
    const open = (await tasksOf(doc)).filter((t) => t.status === "open");
    expect(open).toHaveLength(0);
    const view = await json(await rajesh.get("/api/crm/today"));
    expect(view.body.due.map((t) => t.doctor_name)).not.toContain("Dr Task One");
    const left = await one(`SELECT count(*)::int AS n FROM crm.tasks WHERE doctor_id = $1`, [
      doc.id,
    ]);
    expect(left.n).toBeGreaterThan(0);
  });

  test("8. Backfill turns each doctor's latest next visit date into one follow-up, once", async () => {
    const [a, b, c] = await seedDoctors(hospitalId, [
      { full_name: "Dr Backfill A", mobile: "9833300011", area: "X", owner: users.rajesh.crmId },
      { full_name: "Dr Backfill B", mobile: "9833300012", area: "X", owner: users.rajesh.crmId },
      { full_name: "Dr Backfill C", mobile: "9833300013", area: "X", owner: users.sandeep.crmId },
    ]);
    const visit = (doc, rep, ago, next) =>
      query(
        `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at, next_visit_date,
                                 follow_up_required)
         VALUES ($1, $2, $3, now() - $4::interval, $5::date, $5::date IS NOT NULL)`,
        [hospitalId, doc.id, rep, ago, next],
      );
    await visit(a, users.rajesh.crmId, "20 days", addDays(today, -5));
    await visit(a, users.rajesh.crmId, "2 days", addDays(today, 6));
    await visit(b, users.rajesh.crmId, "9 days", addDays(today, -2));
    await visit(b, users.rajesh.crmId, "1 day", null);
    await visit(c, users.rajesh.crmId, "4 days", addDays(today, 3));

    const script = path.join(repoRoot, "server", "scripts", "backfill-crm-follow-up-tasks.mjs");
    const run = (...args) =>
      execFileSync("node", [script, ...args], { env: buildTestEnv(), encoding: "utf8" });
    expect(run()).toContain("dry run");
    expect(await tasksOf(a)).toEqual([]);

    const out = run("--apply");
    expect(out).toMatch(/done — \d+ follow-up task\(s\) created/);
    expect((await tasksOf(a)).map((t) => [t.kind, t.status, t.due_date])).toEqual([
      ["follow_up_visit", "open", addDays(today, 6)],
    ]);
    expect(await tasksOf(b)).toEqual([]);
    expect(await tasksOf(c)).toEqual([]);

    run("--apply");
    expect(await tasksOf(a)).toHaveLength(1);

    await logVisit(rajesh, a, { status: "completed" });
    expect((await tasksOf(a))[0].status).toBe("done");
  });

  test("9. The Needs a follow-up box controls it: unticked keeps no date and makes no task", async () => {
    const [doc] = await seedDoctors(hospitalId, [
      { full_name: "Dr Box Rule", mobile: "9833300021", area: "X", owner: users.rajesh.crmId },
    ]);
    const unticked = await logVisit(rajesh, doc, {
      status: "completed",
      follow_up_required: false,
      next_visit_date: addDays(today, 15),
    });
    expect(unticked.status).toBe(200);
    const row = await one(
      `SELECT follow_up_required, next_visit_date FROM crm.visits WHERE id = $1`,
      [unticked.body.id],
    );
    expect(row).toEqual({ follow_up_required: false, next_visit_date: null });
    expect(await tasksOf(doc)).toEqual([]);

    await query(`UPDATE crm.visits SET deleted_at = now() WHERE id = $1`, [unticked.body.id]);
    const early = await logVisit(rajesh, doc, {
      status: "completed",
      follow_up_required: true,
      next_visit_date: today,
    });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe("The next visit date must be after the visit date.");
  });
});
