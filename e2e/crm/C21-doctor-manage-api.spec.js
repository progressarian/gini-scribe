import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, resetCrm } from "../helpers/crm.mjs";
import { one, query } from "../helpers/db.mjs";
import { addDays, istDate, uploadWindow } from "../../server/crm/istPeriods.js";

const json = async (res) => ({ status: res.status(), body: await res.json() });

test.describe("CRM doctors: add, edit, remove with approval, visit form", () => {
  let users;
  let hospitalId;
  let rajesh;
  let sandeep;
  let virender;
  let seeded;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const s = await seedCrmStaff();
    users = s.users;
    hospitalId = s.hospitalId;
    seeded = {
      mine: await seedDoctors(hospitalId, [
        { full_name: "Dr Old Record", area: "Balongi", owner: users.rajesh.crmId },
      ]),
      theirs: await seedDoctors(hospitalId, [
        {
          full_name: "Dr Sandeep Doc",
          area: "Sohana",
          mobile: "9876500001",
          specialty: "BAMS",
          owner: users.sandeep.crmId,
        },
      ]),
    };
    rajesh = await crmApi(users.rajesh);
    sandeep = await crmApi(users.sandeep);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  const add = (api, data) => api.post("/api/crm/doctors", { data }).then(json);

  test("1. A rep adds a doctor: name tidied, owned by the rep, visible only to them", async () => {
    const { status, body } = await add(rajesh, {
      full_name: "DR DR AKHILESH SHARMA",
      mobile: "+91 99880 13613",
      area: "Mataur",
      specialty: "bams",
      owner_id: users.sandeep.crmId,
    });
    expect(status).toBe(200);
    expect(body.full_name).toBe("Dr Akhilesh Sharma");
    expect(body.owner_id).toBe(users.rajesh.crmId);

    const row = await one(
      `SELECT d.full_name, d.mobile, d.specialty, a.executive_id
         FROM crm.doctors d JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
        WHERE d.id = $1`,
      [body.id],
    );
    expect(row).toMatchObject({
      mobile: "9988013613",
      specialty: "Ayurveda (BAMS)",
      executive_id: users.rajesh.crmId,
    });
    expect((await rajesh.get(`/api/crm/doctors/${body.id}`)).status()).toBe(200);
    expect((await sandeep.get(`/api/crm/doctors/${body.id}`)).status()).toBe(404);
  });

  test("2. Add validation: required fields and clear messages", async () => {
    const { status, body } = await add(rajesh, { full_name: "", mobile: "12345" });
    expect(status).toBe(400);
    expect(body.fields).toMatchObject({
      full_name: "Enter the doctor's name.",
      mobile: "Enter a 10-digit mobile number starting 6-9.",
      area: "Enter the area or sector.",
      specialty: "Choose a specialty.",
    });
    const bad = await add(rajesh, {
      full_name: "Dr Valid Name",
      mobile: "9812345678",
      area: "Kharar",
      specialty: "RMP",
      email: "nope",
      pin_code: "12",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.fields.email).toBe("Enter an email like name@example.com.");
    expect(bad.body.fields.pin_code).toBe("Enter a 6-digit PIN code, like 160062.");
  });

  test("3. Mobile already taken: own doctor links to it, another rep's names only the owner", async () => {
    const mine = await add(rajesh, {
      full_name: "Dr Mobile Mine",
      mobile: "9811100001",
      area: "Kharar",
      specialty: "RMP",
    });
    expect(mine.status).toBe(200);
    const again = await add(rajesh, {
      full_name: "Dr Someone Else",
      mobile: "9811100001",
      area: "Kharar",
      specialty: "RMP",
    });
    expect(again.status).toBe(409);
    expect(again.body.doctor_id).toBe(mine.body.id);
    expect(again.body.error).toContain("Dr Mobile Mine");

    const other = await add(rajesh, {
      full_name: "Dr Copy",
      mobile: "9876500001",
      area: "Sohana",
      specialty: "RMP",
    });
    expect(other.status).toBe(409);
    expect(other.body.error).toContain("Sandeep Sangroy");
    expect(other.body.doctor_id).toBeNull();
    expect(other.body.doctor_name).toBeNull();

    const check = await json(await rajesh.get("/api/crm/doctors/check-mobile?mobile=9876500001"));
    expect(check.body).toMatchObject({ valid: true, taken: true, doctor_id: null });
  });

  test("4. Same name and area asks for confirmation, then saves", async () => {
    const data = {
      full_name: "Dr Twin Name",
      mobile: "9811100002",
      area: "Kharar",
      specialty: "RMP",
    };
    expect((await add(rajesh, data)).status).toBe(200);
    const twin = await add(rajesh, { ...data, mobile: "9811100003" });
    expect(twin.status).toBe(409);
    expect(twin.body.code).toBe("similar");
    const confirmed = await add(rajesh, { ...data, mobile: "9811100003", confirm_similar: true });
    expect(confirmed.status).toBe(200);
  });

  test("5. Admin adds for a rep or unassigned", async () => {
    const forSandeep = await add(virender, {
      full_name: "Dr Given To Sandeep",
      mobile: "9811100004",
      area: "Zirakpur",
      specialty: "Physician",
      owner_id: users.sandeep.crmId,
    });
    expect(forSandeep.body.owner_id).toBe(users.sandeep.crmId);
    expect((await sandeep.get(`/api/crm/doctors/${forSandeep.body.id}`)).status()).toBe(200);
    expect((await rajesh.get(`/api/crm/doctors/${forSandeep.body.id}`)).status()).toBe(404);

    const open = await add(virender, {
      full_name: "Dr Nobody Yet",
      mobile: "9811100005",
      area: "Zirakpur",
      specialty: "Physician",
    });
    expect(open.body.owner_id).toBeNull();
    const n = await one(
      `SELECT count(*)::int AS n FROM crm.doctor_assignments WHERE doctor_id = $1`,
      [open.body.id],
    );
    expect(n.n).toBe(0);
  });

  test("6. Edit: change and clear fields, keep required ones, history, stale save, no owner change for reps", async () => {
    const doc = seeded.mine[0];
    const before = await json(await rajesh.get(`/api/crm/doctors/${doc.id}/edit`));
    expect(before.body.doctor.mobile).toBeNull();

    const saved = await json(
      await rajesh.put(`/api/crm/doctors/${doc.id}`, {
        data: {
          mobile: "9811100006",
          address_line: "SCO 12, Main Market",
          city: "Mohali",
          updated_at: before.body.doctor.updated_at,
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.changed.sort()).toEqual(["address_line", "city", "mobile"]);

    const cleared = await json(
      await rajesh.put(`/api/crm/doctors/${doc.id}`, {
        data: { city: "", updated_at: saved.body.updated_at },
      }),
    );
    expect(cleared.body.changed).toEqual(["city"]);

    const noMobile = await json(
      await rajesh.put(`/api/crm/doctors/${doc.id}`, { data: { mobile: "" } }),
    );
    expect(noMobile.status).toBe(400);
    expect(noMobile.body.fields.mobile).toBe("Enter the doctor's 10-digit mobile number.");

    const stale = await json(
      await rajesh.put(`/api/crm/doctors/${doc.id}`, {
        data: { city: "Kharar", updated_at: before.body.doctor.updated_at },
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("Rajesh Sharma");

    const owner = await json(
      await rajesh.put(`/api/crm/doctors/${doc.id}`, { data: { owner_id: users.sandeep.crmId } }),
    );
    expect(owner.status).toBe(403);

    const history = await json(await rajesh.get(`/api/crm/doctors/${doc.id}/history`));
    const fields = history.body.entries.flatMap((e) => e.changes.map((c) => c.field));
    expect(fields).toEqual(expect.arrayContaining(["Mobile", "Address", "City"]));
    expect(fields).not.toContain("updated_at");
    expect(history.body.entries[0].by).toBe("Rajesh Sharma");

    expect(
      (await sandeep.put(`/api/crm/doctors/${doc.id}`, { data: { city: "X" } })).status(),
    ).toBe(404);
  });

  test("7. Editing an older doctor without a mobile does not force one", async () => {
    const [skeleton] = await seedDoctors(hospitalId, [
      { full_name: "Dr Skeleton", area: "Balongi", owner: users.rajesh.crmId },
    ]);
    const res = await json(
      await rajesh.put(`/api/crm/doctors/${skeleton.id}`, { data: { clinic_name: "Care Clinic" } }),
    );
    expect(res.status).toBe(200);
  });

  test("8. Removal: rep requests, duplicate request refused, admin rejects, rep asks again, admin approves", async () => {
    const created = await add(rajesh, {
      full_name: "Dr To Remove",
      mobile: "9811100007",
      area: "Kharar",
      specialty: "RMP",
    });
    const id = created.body.id;
    const task = await one(
      `INSERT INTO crm.tasks (hospital_id, doctor_id, owner_id, title, status, created_by)
       VALUES ($1, $2, $3, 'Call back', 'open', $3) RETURNING id`,
      [hospitalId, id, users.rajesh.crmId],
    );

    const noReason = await json(await rajesh.post(`/api/crm/doctors/${id}/removal`, { data: {} }));
    expect(noReason.status).toBe(400);
    const otherNoNote = await json(
      await rajesh.post(`/api/crm/doctors/${id}/removal`, { data: { reason: "other" } }),
    );
    expect(otherNoNote.body.error).toBe("Write a short note explaining the reason.");

    const req1 = await json(
      await rajesh.post(`/api/crm/doctors/${id}/removal`, { data: { reason: "not_a_doctor" } }),
    );
    expect(req1.body.status).toBe("pending");
    const dup = await json(
      await rajesh.post(`/api/crm/doctors/${id}/removal`, { data: { reason: "duplicate" } }),
    );
    expect(dup.status).toBe(409);

    const page = await json(await rajesh.get(`/api/crm/doctors/${id}`));
    expect(page.body.removal).toMatchObject({ status: "pending", mine: true });

    expect(
      (await rajesh.post(`/api/crm/removal-requests/${req1.body.request.id}/approve`)).status(),
    ).toBe(403);

    const rejectNoNote = await json(
      await virender.post(`/api/crm/removal-requests/${req1.body.request.id}/reject`, { data: {} }),
    );
    expect(rejectNoNote.status).toBe(400);
    await virender.post(`/api/crm/removal-requests/${req1.body.request.id}/reject`, {
      data: { note: "He is a referring chemist, keep him" },
    });
    const afterReject = await json(await rajesh.get(`/api/crm/doctors/${id}`));
    expect(afterReject.body.removal).toMatchObject({
      status: "rejected",
      decision_note: "He is a referring chemist, keep him",
    });

    const req2 = await json(
      await rajesh.post(`/api/crm/doctors/${id}/removal`, {
        data: { reason: "other", note: "Clinic closed" },
      }),
    );
    const list = await json(await virender.get("/api/crm/removal-requests?status=pending"));
    expect(list.body.counts.pending).toBe(1);
    expect(list.body.rows[0]).toMatchObject({
      full_name: "Dr To Remove",
      requested_by_name: "Rajesh Sharma",
      open_tasks: 1,
    });

    const approve = await json(
      await virender.post(`/api/crm/removal-requests/${req2.body.request.id}/approve`),
    );
    expect(approve.body).toMatchObject({ status: "approved", tasks_cancelled: 1 });
    const again = await json(
      await virender.post(`/api/crm/removal-requests/${req2.body.request.id}/approve`),
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("Already approved by Virender Satija");

    expect((await one(`SELECT status FROM crm.tasks WHERE id = $1`, [task.id])).status).toBe(
      "cancelled",
    );
    expect((await rajesh.get(`/api/crm/doctors/${id}`)).status()).toBe(404);
    const home = await json(await rajesh.get("/api/crm/home"));
    expect(home.body.my_doctors.some((d) => d.doctor_id === id)).toBe(false);
    const asAdmin = await json(await virender.get(`/api/crm/doctors/${id}`));
    expect(asAdmin.body.doctor.removed_reason).toBe("other");
  });

  test("9. Cancel own request; admin removes directly; restore; mobile reuse blocks restore", async () => {
    const a = await add(rajesh, {
      full_name: "Dr Cancel Me",
      mobile: "9811100008",
      area: "Kharar",
      specialty: "RMP",
    });
    const req = await json(
      await rajesh.post(`/api/crm/doctors/${a.body.id}/removal`, { data: { reason: "left" } }),
    );
    expect(
      (await sandeep.post(`/api/crm/removal-requests/${req.body.request.id}/cancel`)).status(),
    ).toBe(404);
    const cancel = await json(
      await rajesh.post(`/api/crm/removal-requests/${req.body.request.id}/cancel`),
    );
    expect(cancel.body.status).toBe("cancelled");

    const direct = await json(
      await virender.post(`/api/crm/doctors/${a.body.id}/removal`, {
        data: { reason: "duplicate" },
      }),
    );
    expect(direct.body.status).toBe("removed");
    const removed = await json(await virender.get("/api/crm/removal-requests?status=removed"));
    expect(removed.body.rows.some((r) => r.doctor_id === a.body.id)).toBe(true);
    expect((await rajesh.get("/api/crm/removal-requests?status=removed")).status()).toBe(403);

    const restore = await json(await virender.post(`/api/crm/doctors/${a.body.id}/restore`));
    expect(restore.body).toMatchObject({ status: "restored", owner_name: "Rajesh Sharma" });
    expect((await rajesh.get(`/api/crm/doctors/${a.body.id}`)).status()).toBe(200);

    await virender.post(`/api/crm/doctors/${a.body.id}/removal`, { data: { reason: "left" } });
    const reuse = await add(rajesh, {
      full_name: "Dr New Owner Of Number",
      mobile: "9811100008",
      area: "Kharar",
      specialty: "RMP",
    });
    expect(reuse.status).toBe(200);
    const blocked = await json(await virender.post(`/api/crm/doctors/${a.body.id}/restore`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("Dr New Owner Of Number");
  });

  test("10. Visit form: status, back-dating window, one per day across form and sheet", async () => {
    const { body: doc } = await add(rajesh, {
      full_name: "Dr Visit Form",
      mobile: "9811100009",
      area: "Kharar",
      specialty: "RMP",
    });
    const today = istDate();
    const window = uploadWindow();
    const visit = (extra) =>
      rajesh
        .post("/api/crm/visits", {
          data: { id: crypto.randomUUID(), doctor_id: doc.id, visit_type: "in_person", ...extra },
        })
        .then(json);

    const unavailable = await visit({ status: "doctor_unavailable", outcome: "positive" });
    expect(unavailable.status).toBe(200);
    const stored = await one(`SELECT outcome FROM crm.visits WHERE id = $1`, [unavailable.body.id]);
    expect(stored.outcome).toBe("doctor_unavailable");

    expect((await visit({ status: "completed" })).body.reason).toBe("already_logged_today");

    expect((await visit({ visit_date: addDays(today, 1) })).body.error).toBe(
      "The visit date cannot be in the future.",
    );
    expect((await visit({ visit_date: addDays(window.from, -1) })).status).toBe(400);
    expect((await visit({ status: "not_visited" })).status).toBe(400);

    if (window.from < today) {
      const back = await visit({ status: "completed", visit_date: window.from });
      expect(back.body.duplicate).toBe(false);
      const days = await json(await rajesh.get(`/api/crm/doctors/${doc.id}/visit-days`));
      expect(days.body.days.map((d) => d.day)).toEqual(
        expect.arrayContaining([today, window.from]),
      );
      expect((await visit({ visit_date: window.from })).body.reason).toBe("already_logged_today");
    }
  });

  test("11. Fix a visit: own visit same day; next day only admin with a reason", async () => {
    const { body: doc } = await add(rajesh, {
      full_name: "Dr Fix Visit",
      mobile: "9811100010",
      area: "Kharar",
      specialty: "RMP",
    });
    const id = crypto.randomUUID();
    await rajesh.post("/api/crm/visits", {
      data: { id, doctor_id: doc.id, visit_type: "in_person", status: "completed" },
    });

    const edit = await json(
      await rajesh.put(`/api/crm/visits/${id}`, {
        data: { status: "doctor_unavailable", discussion_notes: "Was in OT" },
      }),
    );
    expect(edit.status).toBe(200);
    expect(edit.body.outcome).toBe("doctor_unavailable");
    expect((await sandeep.put(`/api/crm/visits/${id}`, { data: {} })).status()).toBe(404);

    await query(`UPDATE crm.visits SET created_at = now() - interval '2 days' WHERE id = $1`, [id]);
    const late = await json(await rajesh.post(`/api/crm/visits/${id}/undo`, { data: {} }));
    expect(late.status).toBe(403);
    expect(late.body.error).toContain("only on the day you logged it");

    const adminNoReason = await json(
      await virender.post(`/api/crm/visits/${id}/undo`, { data: {} }),
    );
    expect(adminNoReason.status).toBe(400);
    const adminUndo = await json(
      await virender.post(`/api/crm/visits/${id}/undo`, { data: { reason: "Wrong doctor" } }),
    );
    expect(adminUndo.body.undone).toBe(true);
    const row = await one(`SELECT deleted_at, change_reason FROM crm.visits WHERE id = $1`, [id]);
    expect(row.deleted_at).not.toBeNull();
    expect(row.change_reason).toBe("Wrong doctor");

    const fresh = crypto.randomUUID();
    await rajesh.post("/api/crm/visits", {
      data: { id: fresh, doctor_id: doc.id, visit_type: "in_person", status: "completed" },
    });
    const undo = await json(await rajesh.post(`/api/crm/visits/${fresh}/undo`, { data: {} }));
    expect(undo.body.undone).toBe(true);
  });

  test("12. Form options: specialties for all, staff only for admins", async () => {
    const rep = await json(await rajesh.get("/api/crm/doctors/form-options"));
    expect(rep.body.specialties).toContain("Ayurveda (BAMS)");
    expect(rep.body).toMatchObject({ can_assign: false, staff: [] });
    const lead = await json(await virender.get("/api/crm/doctors/form-options"));
    expect(lead.body.can_assign).toBe(true);
    expect(lead.body.staff.map((s) => s.full_name)).toContain("Sandeep Sangroy");
  });

  test("13. Same-name warning sees through a doubled Dr on imported names", async () => {
    await seedDoctors(hospitalId, [
      { full_name: "DR DR RAJ KUMAR", area: "Mataur", owner: users.rajesh.crmId },
    ]);
    const res = await add(rajesh, {
      full_name: "Raj Kumar",
      mobile: "9811100011",
      area: "mataur",
      specialty: "RMP",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("similar");
  });

  test("14. A cleared doctor leaves the Removed doctors list and cannot be restored", async () => {
    const { body: doc } = await add(virender, {
      full_name: "Dr Cleared Test",
      mobile: "9811100012",
      area: "Kharar",
      specialty: "RMP",
    });
    await virender.post(`/api/crm/doctors/${doc.id}/removal`, {
      data: { reason: "other", note: "Test" },
    });
    await query(`UPDATE crm.doctors SET is_active = false WHERE id = $1`, [doc.id]);
    const removed = await json(await virender.get("/api/crm/removal-requests?status=removed"));
    expect(removed.body.rows.some((r) => r.doctor_id === doc.id)).toBe(false);
    const restore = await json(await virender.post(`/api/crm/doctors/${doc.id}/restore`));
    expect(restore.status).toBe(409);
    expect(restore.body.error).toContain("cleared");
  });
});
