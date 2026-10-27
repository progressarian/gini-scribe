import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { query } from "../helpers/db.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";

const SHOTS = process.env.SHOT_DIR;
const today = istDate();

test.describe("CRM home: Today and Tasks tabs", () => {
  let users;
  let hospitalId;
  let docs;
  let rajesh;
  let virender;

  test.beforeEach(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    hospitalId = seeded.hospitalId;
    docs = await seedDoctors(hospitalId, [
      {
        full_name: "Dr Due Today",
        mobile: "9844400001",
        area: "Kharar",
        owner: users.rajesh.crmId,
      },
      {
        full_name: "Dr Late One",
        mobile: "9844400002",
        area: "Balongi",
        owner: users.rajesh.crmId,
      },
    ]);
    const followUp = (doctor, due, ago) =>
      query(
        `INSERT INTO crm.tasks (hospital_id, title, owner_id, doctor_id, due_date, kind, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, 'follow_up_visit', $3, now() - $6::interval)`,
        [hospitalId, `Visit ${doctor.full_name}`, users.rajesh.crmId, doctor.id, due, ago],
      );
    await followUp(docs[0], today, "5 days");
    await followUp(docs[1], addDays(today, -3), "10 days");
    await query(
      `INSERT INTO crm.tasks (hospital_id, title, owner_id, doctor_id, due_date, kind, created_by)
       VALUES ($1, 'Send camp brochure', $2, $3, $4, 'promise', $2)`,
      [hospitalId, users.rajesh.crmId, docs[0].id, today],
    );
    rajesh = await crmApi(users.rajesh);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  test("1. Today shows visits due, overdue first; logging the visit moves it to Done today", async ({
    page,
  }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, "/crm/home", () =>
      page.getByRole("button", { name: "Today", exact: true }),
    );
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const due = page.getByRole("region", { name: /Visits due/ });
    await expect(due.locator(".tsk__row").first()).toContainText("Dr Late One");
    await expect(due.locator(".tsk__row").first()).toContainText("3 days overdue");
    await expect(due.locator(".tsk__row").nth(1)).toContainText("Due today");
    await expect(page.getByRole("region", { name: /Tasks due/ })).toContainText(
      "Send camp brochure",
    );
    await expect(page.getByText("No visits logged yet today.")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-rep.png`, fullPage: true });

    await due
      .locator(".tsk__row")
      .filter({ hasText: "Dr Due Today" })
      .getByRole("link", { name: "Log visit" })
      .click();
    await expect(
      page.getByText("Tick this to plan the next visit and get a reminder."),
    ).toBeVisible();
    await expect(page.getByLabel(/Next visit date/)).toHaveCount(0);
    await page.getByLabel("Needs a follow-up").check();
    await expect(page.getByLabel(/Next visit date/)).toBeVisible();
    await expect(page.getByText(/A follow-up task “Visit Dr Due Today” is added/)).toBeVisible();
    await page.getByLabel("Needs a follow-up").uncheck();
    await page.getByRole("button", { name: "Save visit" }).click();
    await expect(page).toHaveURL(/\/crm\/home/);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByRole("region", { name: /Done today/ })).toContainText("Dr Due Today", {
      timeout: 15000,
    });
    await expect(page.getByRole("region", { name: /Visits due/ })).not.toContainText(
      "Dr Due Today",
    );
  });

  test("2. Tasks tab: add a task, mark it done, undo, cancel with a reason", async ({ page }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, "/crm/home", () =>
      page.getByRole("button", { name: "Tasks", exact: true }),
    );
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    const panel = page.getByRole("region", { name: "Tasks" });
    await expect(panel.getByRole("button", { name: /Due now 3/ })).toContainText("1 overdue");

    await panel.getByRole("button", { name: "+ Task" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(
      dialog.getByText("Write what needs doing, like Send the CME invite."),
    ).toBeVisible();
    await dialog.getByLabel("What needs doing").fill("Invite to diabetes CME");
    await dialog.getByLabel("Doctor (optional)").fill("Late");
    await dialog.getByRole("button", { name: /Dr Late One/ }).click();
    await expect(dialog.getByText("Dr Late One")).toBeVisible();
    await dialog.getByLabel("Priority").selectOption("high");
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Task added.")).toBeVisible();

    const row = panel.locator(".tsk__row").filter({ hasText: "Invite to diabetes CME" });
    await expect(row).toContainText("High priority");
    await row.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Marked done: Invite to diabetes CME")).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(
      panel.locator(".tsk__row").filter({ hasText: "Invite to diabetes CME" }),
    ).toBeVisible();

    const again = panel.locator(".tsk__row").filter({ hasText: "Invite to diabetes CME" });
    await again.getByRole("button", { name: "Cancel" }).click();
    const cancel = page.getByRole("dialog");
    await expect(cancel.getByRole("button", { name: "Cancel task" })).toBeDisabled();
    await cancel.getByLabel("Why is it no longer needed?").fill("CME postponed");
    await cancel.getByRole("button", { name: "Cancel task" }).click();
    await panel.getByRole("button", { name: /Done \(30 days\)/ }).click();
    await expect(
      panel.locator(".tsk__row").filter({ hasText: "Invite to diabetes CME" }),
    ).toContainText("Cancelled: CME postponed");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tasks-rep.png`, fullPage: true });
  });

  test("3. Admin: Team today, pick a rep, assign a task to them", async ({ page }) => {
    await loginCrm(page, virender);
    await gotoReady(page, "/crm/home", () =>
      page.getByRole("button", { name: "Today", exact: true }),
    );
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const team = page.getByRole("region", { name: "Team today" });
    const row = team.locator("tr").filter({ hasText: "Rajesh Sharma" });
    await expect(row).toContainText("1");
    await expect(row.locator(".tdy__late").first()).toHaveText("1");
    await row.getByRole("button", { name: "Rajesh Sharma" }).click();
    await expect(page.getByText("Showing Rajesh Sharma's day below.")).toBeVisible();
    await expect(page.getByRole("region", { name: /Visits due/ })).toContainText("Dr Late One");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-admin.png`, fullPage: true });

    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    const panel = page.getByRole("region", { name: "Tasks" });
    await panel.getByRole("button", { name: "+ Task" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("What needs doing").fill("Meet Dr Due Today with brochure");
    await dialog.getByLabel("Assign to").selectOption({ label: "Sandeep Sangroy" });
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Task added.")).toBeVisible();
    await panel.getByLabel("Owner").selectOption({ label: "Sandeep Sangroy" });
    await expect(panel.locator(".tsk__row").filter({ hasText: "Meet Dr Due Today" })).toContainText(
      "Sandeep Sangroy",
    );
  });

  test("4. Phone width: Today and Tasks fit without sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginCrm(page, virender);
    await gotoReady(page, "/crm/home", () =>
      page.getByRole("button", { name: "Today", exact: true }),
    );
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByRole("region", { name: "Team today" })).toContainText("Rajesh Sharma");
    await expect(page.locator(".tdy[aria-busy='false']")).toBeVisible();
    await expect.poll(overflow).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-phone.png`, fullPage: true });
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page.locator(".tsk__row").first()).toBeVisible();
    await expect.poll(overflow).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tasks-phone.png`, fullPage: true });
  });

  test("5. Visits stuck on the device show on home with the reason, and Retry sends them", async ({
    page,
  }) => {
    await loginCrm(page, rajesh);
    const now = Date.now();
    const item = (doctor, visit, status, error) => ({
      visit: {
        id: crypto.randomUUID(),
        doctor_id: doctor.id,
        visit_type: "in_person",
        occurred_at: new Date(now).toISOString(),
        client_created_at: new Date(now).toISOString(),
        ...visit,
      },
      meta: { doctor_name: doctor.full_name, visit_date: today },
      status: "pending",
      attempts: 3,
      queued_at: now,
      last_error: error,
      last_status: status,
      next_attempt_at: now + 10 * 60 * 1000,
    });
    const queue = [
      item(docs[0], { status: "completed" }, 500, "Log visit failed"),
      item(docs[1], { status: "not_visited" }, 400, "Choose Completed or Doctor unavailable."),
    ];
    await page.addInitScript((q) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("crm.visitQueue.v1", JSON.stringify(q));
        sessionStorage.setItem("seeded", "1");
      }
    }, queue);
    await gotoReady(page, "/crm/home", () => page.getByText("2 visits not saved yet"));
    const panel = page.locator(".pvq");
    await expect(panel).toContainText("Dr Due Today");
    await expect(panel).toContainText("The server could not save it.");
    await expect(panel).toContainText("Choose Completed or Doctor unavailable.");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pending-visits.png`, fullPage: true });

    await panel.getByRole("button", { name: "Retry now" }).click();
    await expect(panel).toContainText("1 visit not saved yet");
    await expect(panel).toContainText("1 visit saved.");
    await expect(panel).not.toContainText("Dr Due Today");
    await expect(panel).toContainText("Dr Late One");
    await expect
      .poll(
        async () =>
          (
            await query(`SELECT count(*)::int AS n FROM crm.visits WHERE doctor_id = $1`, [
              docs[0].id,
            ])
          ).rows[0].n,
      )
      .toBe(1);

    const stuck = panel.locator("li").filter({ hasText: "Dr Late One" });
    await stuck.getByRole("button", { name: "Remove" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("It was never saved");
    await confirm.getByRole("button", { name: "Remove visit" }).click();
    await expect(panel).toContainText("Removed the unsaved visit to Dr Late One.");
    await expect(panel.getByRole("link", { name: "Log it again" })).toHaveAttribute(
      "href",
      new RegExp(`/crm/visit/${docs[1].id}`),
    );
    await expect(page.locator(".rep__pending")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("crm.visitQueue.v1") || "[]").length,
      ),
    ).toBe(0);
  });

  test("6. The open tab survives a refresh, the CRM link and coming back from a doctor", async ({
    page,
  }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, "/crm/home", () =>
      page.getByRole("button", { name: "Tasks", exact: true }),
    );
    const active = () => page.locator(".rep__tab--on").first();
    await expect(active()).toContainText("To visit");

    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=tasks/);
    await page.reload();
    await expect(active()).toContainText("Tasks");
    await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();

    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.locator(".tsk__row").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/crm\/doctor\//);
    await page.goBack();
    await expect(active()).toContainText("Today");

    await page.getByRole("link", { name: /CRM/ }).first().click();
    await expect(page).toHaveURL(/\/crm\/home$/);
    await expect(active()).toContainText("Today");

    await page.goto("/crm/home?tab=removals");
    await expect(active()).toContainText("To visit");
  });
});
