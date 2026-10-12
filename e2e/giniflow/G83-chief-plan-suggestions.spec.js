import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const suggestions = await import("../../server/services/giniflow/planSuggestions.js");
const { pendingProposalCount } = await import("../../server/services/giniflow/finalize.js");

const tag = newTag();
const CHIEF = CONSULTANTS.rahul.id;
const DOCTOR = CONSULTANTS.banshali.id;
let ids;

async function atChiefDesk(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE giniflow_visits SET current_status = 'with_sd', assigned_sd_id = $2 WHERE id = $1`,
    [made.visit, CHIEF],
  );
  return made.visit;
}

const carePlan = (visit) =>
  one(
    `SELECT advice, treatment, lifestyle, goals, next_visit_date::text AS next_visit_date,
            next_visit_interval
       FROM giniflow_care_plans WHERE visit_id = $1`,
    [visit],
  );

const byField = async (visit) =>
  Object.fromEntries((await suggestions.listSuggestions(visit, db)).map((s) => [s.field, s]));

test.describe.serial("G83 the Chief Endocrinologist suggests advice and care plan", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the Chief's suggestions save per field, update in place and withdraw when cleared", async () => {
    const visit = await atChiefDesk("SugSave");
    await suggestions.saveSuggestion(visit, "advice", "Walk 30 minutes", CHIEF, db);
    await suggestions.saveSuggestion(visit, "advice", "Walk 30 minutes\nAvoid sugar", CHIEF, db);
    await suggestions.saveSuggestion(visit, "treatment", "Start metformin", CHIEF, db);
    await suggestions.saveSuggestion(visit, "treatment", "", CHIEF, db);

    const list = await byField(visit);
    expect(list.advice).toMatchObject({
      value: "Walk 30 minutes\nAvoid sugar",
      status: "proposed",
    });
    expect(list.treatment).toBeUndefined();
    const { n } = await one(
      `SELECT count(*)::int AS n FROM giniflow_plan_suggestions WHERE visit_id = $1 AND field = 'advice'`,
      [visit],
    );
    expect(n).toBe(1);
  });

  test("2. accept adds to the consultant's plan, edit keeps the Chief's words, dismiss changes nothing", async () => {
    const visit = await atChiefDesk("SugDecide");
    await query(
      `INSERT INTO giniflow_care_plans (visit_id, advice, goals)
       VALUES ($1, 'Walk 30 minutes', '[{"test":"HbA1c","target":"<7","unit":"%"}]'::jsonb)`,
      [visit],
    );
    await suggestions.saveSuggestion(visit, "advice", "Walk 30 minutes\nAvoid sugar", CHIEF, db);
    await suggestions.saveSuggestion(
      visit,
      "goals",
      [
        { test: "HbA1c", target: "<7", unit: "%" },
        { test: "LDL", target: "<100", unit: "mg/dL" },
      ],
      CHIEF,
      db,
    );
    await suggestions.saveSuggestion(visit, "next_visit", { interval: "6 weeks" }, CHIEF, db);
    await suggestions.saveSuggestion(visit, "lifestyle", "Sleep 8 hours", CHIEF, db);
    const list = await byField(visit);

    await suggestions.decideSuggestion(list.advice.id, { status: "accepted" }, DOCTOR, db);
    await suggestions.decideSuggestion(list.goals.id, { status: "accepted" }, DOCTOR, db);
    await suggestions.decideSuggestion(
      list.next_visit.id,
      { status: "edited", value: { interval: "8 weeks" } },
      DOCTOR,
      db,
    );
    await suggestions.decideSuggestion(
      list.lifestyle.id,
      { status: "dismissed", note: "Already discussed" },
      DOCTOR,
      db,
    );

    const plan = await carePlan(visit);
    expect(plan.advice).toBe("Walk 30 minutes\nAvoid sugar");
    expect(plan.goals.map((g) => g.test)).toEqual(["HbA1c", "LDL"]);
    expect(plan.next_visit_interval).toBe("8 weeks");
    expect(plan.lifestyle).toBeNull();

    const decided = await byField(visit);
    expect(decided.next_visit).toMatchObject({
      status: "edited",
      value: { interval: "6 weeks" },
      editedValue: { interval: "8 weeks" },
    });
    expect(decided.lifestyle).toMatchObject({ status: "dismissed", note: "Already discussed" });
    await expect(
      suggestions.saveSuggestion(visit, "advice", "Something else", CHIEF, db),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("3. only the Chief who has the patient, and only while they are at the desk", async () => {
    const visit = await atChiefDesk("SugAccess");
    await expect(
      suggestions.saveSuggestion(visit, "advice", "Walk", USERS.coordinator.id, db),
    ).rejects.toMatchObject({ status: 403 });
    await query(`UPDATE giniflow_visits SET current_status = 'ready_for_doctor' WHERE id = $1`, [
      visit,
    ]);
    await expect(
      suggestions.saveSuggestion(visit, "advice", "Walk", CHIEF, db),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("4. an undecided suggestion holds Finish consultation", async () => {
    const visit = await atChiefDesk("SugFinish");
    await suggestions.saveSuggestion(visit, "advice", "Avoid sugar", CHIEF, db);
    expect(await pendingProposalCount(visit, db)).toBe(1);
    const [only] = await suggestions.listSuggestions(visit, db);
    await suggestions.decideSuggestion(only.id, { status: "dismissed" }, DOCTOR, db);
    expect(await pendingProposalCount(visit, db)).toBe(0);
  });

  test("5. the stations' API saves and decides suggestions, and refuses the wrong role", async () => {
    const visit = await atChiefDesk("SugApi");
    const admin = await apiAs("admin");
    const saved = await admin.put(`/api/giniflow/stations/mo/${visit}/suggestions/advice`, {
      data: { value: "Avoid sugar" },
    });
    expect(saved.status()).toBe(200);
    const listed = await admin.get(`/api/giniflow/stations/doctor/${visit}/suggestions`);
    const [first] = (await listed.json()).suggestions;
    const decided = await admin.patch(`/api/giniflow/stations/doctor/suggestions/${first.id}`, {
      data: { status: "accepted" },
    });
    expect(decided.status()).toBe(200);
    await admin.dispose();

    const reception = await apiAs("reception");
    expect(
      (
        await reception.put(`/api/giniflow/stations/mo/${visit}/suggestions/advice`, {
          data: { value: "x" },
        })
      ).status(),
    ).toBe(403);
    await reception.dispose();
  });

  test("6. the Chief types a suggestion and the consultant accepts it into their advice", async ({
    page,
  }) => {
    const made = await extraVisit(ids, "SugScreen", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'vitals_done' WHERE id = $1`, [
      made.visit,
    ]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '20 minutes'),
              ($1, 'vitals_done', 'vitals', NOW() - interval '5 minutes')`,
      [made.visit],
    );

    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/mo", () =>
      page.getByText(`P4 SugScreen ${tag}`).first(),
    );
    await page.getByText(`P4 SugScreen ${tag}`).first().click();
    const chief = page.locator(".dp-sec").filter({ hasText: "📝 Suggest advice & care plan" });
    await chief.getByRole("textbox", { name: /^Advice/ }).fill("Avoid sugary drinks");
    await expect(chief.getByText("Suggested", { exact: true })).toBeVisible();

    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
      made.visit,
    ]);
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () =>
      page.getByRole("region", { name: "Chief Endocrinologist suggestions" }),
    );
    const strip = page.getByRole("region", { name: "Chief Endocrinologist suggestions" });
    await expect(strip).toContainText("Avoid sugary drinks");
    await strip.getByRole("button", { name: "Accept" }).click();
    await expect(strip).toContainText("Advice: Accepted");
    await expect(page.getByLabel("General advice")).toHaveValue(/Avoid sugary drinks/);
  });
});
