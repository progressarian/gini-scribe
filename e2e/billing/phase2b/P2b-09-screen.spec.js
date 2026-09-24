import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { ERROR_COLUMN } from "../../../server/services/billing/importColumns.js";
import {
  admin,
  cleanUp,
  db,
  newTag,
  readWorkbook,
  recAdmin,
  seed,
  sessions,
  upload,
  workbook,
} from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B09");
const PAGE = "/settings/bulk-import";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ITEMS = 55;
const file = (name) => `${p}-${name}.xlsx`;
const MAIN = file("main");
let mainId = null;

const itemCode = (i) => `${P}-I${String(i).padStart(2, "0")}`;

const mainSheets = () => ({
  Groups: [
    { group_code: `${P}-G0`, name: `Renamed 0 ${T}` },
    { group_code: `${P}-G1`, name: `Renamed 1 ${T}` },
    { group_code: `${P}-G2`, name: `Renamed 2 ${T}` },
    { group_code: `${P}-G3`, name: `Group 3 ${T}` },
    { group_code: `${P}-BG`, name: `Group 4 ${T}` },
    { group_code: `${P}-NG`, name: `New ${T}` },
  ],
  Subgroups: [
    { subgroup_code: `${P}-BS`, group_code: `${P}-BG`, name: `Bad sub ${T}` },
    { subgroup_code: `${P}-NS`, group_code: `${P}-NG`, name: `New sub ${T}` },
  ],
  Items: Array.from({ length: ITEMS }, (_, i) => ({
    item_code: itemCode(i),
    name: `Item ${i} ${T}`,
    subgroup_code: `${P}-NS`,
    base_price: 100 + i,
    kind: "other",
  })),
});

const oneNewGroup = (suffix) => ({
  Groups: [{ group_code: `${P}-X${suffix}`, name: `Extra ${suffix} ${T}` }],
});

const renameOne = (suffix) => ({
  Groups: [{ group_code: `${P}-G3`, name: `Renamed 3 ${suffix} ${T}` }],
});

const picker = (page) => page.getByLabel("Filled-in template (.xlsx)", { exact: true });
const card = (page) => page.getByRole("region", { name: /^Import( report)?$/ });
const chips = (page) => page.getByRole("group", { name: "Show rows", exact: true });
const chip = (page, name) => chips(page).getByRole("button", { name: new RegExp(`^${name} · `) });
const table = (page) => page.getByRole("table", { name: "Import rows", exact: true });
const bodyRows = (page) => table(page).locator("tbody tr");
const rowOf = (page, key) =>
  bodyRows(page).filter({
    has: page.getByText(key, { exact: true }),
  });
const pager = (page) => page.getByRole("navigation", { name: "Row pages", exact: true });
const search = (page) => card(page).getByLabel("Search", { exact: true });
const sheetPicker = (page) => card(page).getByLabel("Sheet", { exact: true });
const urlParam = (page, key) => new URL(page.url()).searchParams.get(key);

const sessionRows = async (id) =>
  (
    await query(
      `SELECT row_key, status, decision, outcome FROM billing_import_rows WHERE session_id = $1`,
      [id],
    )
  ).rows;
const decisionOf = async (id, key) =>
  (await sessionRows(id)).find((r) => r.row_key === key)?.decision;

async function openPage(page, role = "reception_admin", search = "") {
  await loginAs(page, role);
  await gotoReady(page, `${PAGE}${search}`, () => picker(page));
}

async function openSession(page, id, role = "reception_admin", extra = "") {
  await openPage(page, role, `?session=${id}${extra}`);
  await expect(card(page)).toBeVisible();
}

async function livePlan(id) {
  const api = await apiAs("reception_admin");
  const response = await api.get(`/api/billing/import/sessions/${id}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  await api.dispose();
  return body.live.plan;
}

const planLines = (plan) => [
  `${plan.save} ${plan.save === 1 ? "row" : "rows"} will be saved — new rows, and the changes you chose to override`,
  `${plan.keep} ${plan.keep === 1 ? "row" : "rows"} will be kept as they are in Scribe, not saved — ${plan.undecided} of them undecided`,
  `${plan.failed} failed ${plan.failed === 1 ? "row" : "rows"} will be skipped — nothing from them is saved`,
  `${plan.unchanged} ${plan.unchanged === 1 ? "row" : "rows"} already ${plan.unchanged === 1 ? "matches" : "match"} Scribe — nothing to do`,
];

test.describe.serial("P2b-09 import screen", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    await cleanUp(P, p);
    await seed(
      {
        Groups: Array.from({ length: 5 }, (_, i) => ({
          group_code: `${P}-G${i}`,
          name: `Group ${i} ${T}`,
        })),
      },
      file("base"),
    );
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. upload creates a session: file, uploader, expiry, counts and chips", async ({
    page,
  }) => {
    await openPage(page);
    await picker(page).setInputFiles({
      name: MAIN,
      mimeType: XLSX_TYPE,
      buffer: await workbook(mainSheets()),
    });
    await expect(card(page)).toBeVisible({ timeout: 30_000 });
    mainId = urlParam(page, "session");
    expect(mainId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(card(page)).toContainText(MAIN);
    await expect(card(page)).toContainText(`Uploaded by ${USERS.reception_admin.name}`);
    await expect(card(page)).toContainText("Open until");
    await expect(
      page.getByRole("list", { name: "All rows", exact: true }).getByRole("listitem"),
    ).toHaveText([`${ITEMS + 2} ready`, "3 needs override", "2 failed", "1 unchanged"]);
    await expect(chips(page).getByRole("button")).toHaveText([
      `All · ${ITEMS + 8}`,
      `Ready · ${ITEMS + 2}`,
      "Needs override · 3",
      "Failed · 2",
      "Unchanged · 1",
    ]);
    await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
    await expect(bodyRows(page)).toHaveCount(50);
    await expect(pager(page)).toContainText(`Page 1 of 2 · rows 1–50 of ${ITEMS + 8}`);
    expect((await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`${P}-NG`])).rows).toEqual(
      [],
    );
  });

  test("2. each chip filters, paging is on the server, and the filter lives in the URL", async ({
    page,
  }) => {
    await openSession(page, mainId);
    const asked = [];
    page.on("request", (request) => {
      if (request.url().includes(`/sessions/${mainId}/rows`)) asked.push(new URL(request.url()));
    });

    await chip(page, "Ready").click();
    await expect(chip(page, "Ready")).toHaveAttribute("aria-pressed", "true");
    expect(urlParam(page, "status")).toBe("ready");
    await expect(bodyRows(page)).toHaveCount(50);
    await expect(pager(page)).toContainText(`Page 1 of 2 · rows 1–50 of ${ITEMS + 2}`);
    await pager(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(pager(page)).toContainText(`Page 2 of 2 · rows 51–${ITEMS + 2} of ${ITEMS + 2}`);
    await expect(bodyRows(page)).toHaveCount(ITEMS + 2 - 50);
    expect(urlParam(page, "page")).toBe("2");
    expect(asked.some((u) => u.searchParams.get("page") === "2")).toBe(true);

    await chip(page, "Failed").click();
    expect(urlParam(page, "page")).toBeNull();
    await expect(bodyRows(page)).toHaveCount(2);
    await expect(table(page)).not.toContainText("Ready");

    await chip(page, "Unchanged").click();
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(rowOf(page, `${P}-G3`)).toContainText("Unchanged");

    await chip(page, "Needs override").click();
    await expect(bodyRows(page)).toHaveCount(3);
    await page.reload();
    await expect(chip(page, "Needs override")).toHaveAttribute("aria-pressed", "true");
    await expect(bodyRows(page)).toHaveCount(3);

    await chip(page, "All").click();
    await sheetPicker(page).selectOption("Subgroups");
    expect(urlParam(page, "sheet")).toBe("Subgroups");
    await expect(bodyRows(page)).toHaveCount(2);
    await expect(chips(page).getByRole("button")).toHaveText([
      "All · 2",
      "Ready · 1",
      "Needs override · 0",
      "Failed · 1",
      "Unchanged · 0",
    ]);

    await sheetPicker(page).selectOption("");
    await search(page).fill(`${P}-I0`);
    await expect.poll(() => urlParam(page, "q")).toBe(`${P}-I0`);
    await expect(bodyRows(page)).toHaveCount(10);
    await expect(pager(page)).toContainText("Page 1 of 1 · rows 1–10 of 10");
  });

  test("3. a changed row shows old → new; Override, Keep and Undo per row", async ({ page }) => {
    await openSession(page, mainId, "reception_admin", "&status=override");
    await expect(bodyRows(page)).toHaveCount(3);
    const g0 = rowOf(page, `${P}-G0`);
    await expect(g0).toContainText(`name: Group 0 ${T} → Renamed 0 ${T}`);
    await expect(g0).toContainText("Needs override");
    await expect(g0).toContainText("Undecided — will be kept");

    await g0.getByRole("button", { name: "Override Groups row 2", exact: true }).click();
    await expect(g0).toContainText("Override — will be saved");
    await expect(
      g0.getByRole("button", { name: "Override Groups row 2", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await decisionOf(mainId, `${P}-G0`)).toBe("override");

    const g1 = rowOf(page, `${P}-G1`);
    await g1.getByRole("button", { name: "Keep Groups row 3", exact: true }).click();
    await expect(g1).toContainText("Keep — stays as it is");
    await expect.poll(() => decisionOf(mainId, `${P}-G1`)).toBe("keep");

    await g0.getByRole("button", { name: "Undo decision on Groups row 2", exact: true }).click();
    await expect(g0).toContainText("Undecided — will be kept");
    await expect(
      g0.getByRole("button", { name: "Undo decision on Groups row 2", exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => decisionOf(mainId, `${P}-G0`)).toBe("pending");
  });

  test("4. Override all decides only the rows matching the current filter", async ({ page }) => {
    await openSession(page, mainId, "reception_admin", "&status=override");
    await search(page).fill(`${P}-G2`);
    await expect(bodyRows(page)).toHaveCount(1);
    const bulk = page.getByRole("group", { name: "Decide every row shown", exact: true });
    await expect(bulk).toContainText("1 row matching this view needs an override · 1 undecided");
    await bulk.getByRole("button", { name: "Override all", exact: true }).click();
    await expect(rowOf(page, `${P}-G2`)).toContainText("Override — will be saved");
    await expect.poll(() => decisionOf(mainId, `${P}-G2`)).toBe("override");
    expect(await decisionOf(mainId, `${P}-G0`)).toBe("pending");
    expect(await decisionOf(mainId, `${P}-G1`)).toBe("keep");

    await chip(page, "Ready").click();
    await expect(bulk).toHaveCount(0);
  });

  test("5. a failed row gives its reason in words and jumps to the row it depends on", async ({
    page,
  }) => {
    await openSession(page, mainId, "reception_admin", "&status=failed");
    const child = rowOf(page, `${P}-BS`);
    await expect(child).toContainText("Depends on Groups row 6, which failed");
    await child.getByRole("link", { name: `Go to Groups row 6 (${P}-BG)`, exact: true }).click();
    expect(urlParam(page, "sheet")).toBe("Groups");
    expect(urlParam(page, "q")).toBe(`${P}-BG`);
    expect(urlParam(page, "status")).toBeNull();
    const parent = rowOf(page, `${P}-BG`);
    await expect(parent).toHaveAttribute("aria-current", "true");
    await expect(parent).toContainText("Failed");
    await expect(parent).toContainText(/already exists/);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card(page).getByRole("button", { name: "Download failed rows", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${p}-main - errors.xlsx`);
    const wb = await readWorkbook(fs.readFileSync(await download.path()));
    const ws = wb.getWorksheet("Subgroups");
    const col = ws.getRow(1).values.slice(1).indexOf(ERROR_COLUMN) + 1;
    expect(String(ws.getRow(2).getCell(col).value)).toContain("Depends on Groups row 6");
  });

  test("6. the commit confirmation states live.plan, then the result and the outcome view", async ({
    page,
  }) => {
    await openSession(page, mainId);
    const plan = await livePlan(mainId);
    expect(plan).toEqual({
      save: ITEMS + 3,
      keep: 2,
      undecided: 1,
      failed: 2,
      unchanged: 1,
    });
    await expect(card(page)).toContainText(
      `If you commit now: ${plan.save} saved · ${plan.keep} kept, not saved (${plan.undecided} undecided) · ${plan.failed} failed, skipped · ${plan.unchanged} unchanged.`,
    );

    await card(page).getByRole("button", { name: "Commit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Commit ${MAIN}?`, exact: true });
    await expect(
      dialog.getByRole("list", { name: "What will happen" }).getByRole("listitem"),
    ).toHaveText(planLines(plan));
    await expect(dialog).toContainText("1 change you haven't decided will be kept, not saved");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`${P}-NG`])).rows).toEqual(
      [],
    );

    await card(page).getByRole("button", { name: "Commit", exact: true }).click();
    await dialog.getByRole("button", { name: `Yes, save ${plan.save} rows`, exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    const done = page.getByRole("status").filter({
      has: page.getByRole("heading", { name: `Imported ${MAIN}`, exact: true }),
    });
    await expect(
      done.getByRole("list", { name: "What happened" }).getByRole("listitem"),
    ).toHaveText([
      `${ITEMS + 3} saved`,
      "2 kept as they were — not changed",
      "2 failed — skipped",
      "1 unchanged",
    ]);
    await expect(page.getByRole("heading", { name: "Import report", exact: true })).toBeVisible();
    await expect(chips(page).getByRole("button")).toHaveText([
      `All · ${ITEMS + 8}`,
      `Saved · ${ITEMS + 3}`,
      "Kept · 2",
      "Failed · 2",
      "Unchanged · 1",
    ]);
    await expect(table(page).getByRole("columnheader", { name: "Outcome" })).toBeVisible();
    await expect(card(page).getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: /^Override / })).toHaveCount(0);

    await chip(page, "Kept").click();
    await expect(bodyRows(page)).toHaveCount(2);
    expect(urlParam(page, "outcome")).toBe("kept");

    const names = (
      await query(`SELECT code, name FROM service_groups WHERE code LIKE $1 ORDER BY code`, [
        `${P}-%`,
      ])
    ).rows;
    expect(names).toEqual([
      { code: `${P}-G0`, name: `Group 0 ${T}` },
      { code: `${P}-G1`, name: `Group 1 ${T}` },
      { code: `${P}-G2`, name: `Renamed 2 ${T}` },
      { code: `${P}-G3`, name: `Group 3 ${T}` },
      { code: `${P}-G4`, name: `Group 4 ${T}` },
      { code: `${P}-NG`, name: `New ${T}` },
    ]);
    expect(
      (await query(`SELECT count(*)::int AS n FROM service_items WHERE code LIKE $1`, [`${P}-I%`]))
        .rows[0].n,
    ).toBe(ITEMS);
    const outcomes = await sessionRows(mainId);
    expect(outcomes.every((r) => r.outcome)).toBe(true);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Import report", exact: true })).toBeVisible();
    await expect(chip(page, "Kept")).toHaveAttribute("aria-pressed", "true");
    await expect(bodyRows(page)).toHaveCount(2);
  });

  test("7. an expired import says so and offers a fresh upload; a 410 mid-way is explained", async ({
    page,
  }) => {
    const stale = await upload(renameOne("a"), file("stale"), recAdmin);
    await query(
      `UPDATE billing_import_sessions
          SET uploaded_at = NOW() - interval '25 hours', expires_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [stale.id],
    );
    await openSession(page, stale.id);
    await expect(card(page).getByRole("alert")).toContainText("This import expired on");
    await expect(
      card(page).getByRole("button", { name: "Upload a fresh file", exact: true }),
    ).toBeVisible();
    await expect(card(page).getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: /^Override / })).toHaveCount(0);

    const late = await upload(renameOne("b"), file("late"), recAdmin);
    await openSession(page, late.id, "reception_admin", "&status=override");
    await query(
      `UPDATE billing_import_sessions
          SET uploaded_at = NOW() - interval '25 hours', expires_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [late.id],
    );
    await rowOf(page, `${P}-G3`)
      .getByRole("button", { name: "Override Groups row 2", exact: true })
      .click();
    await expect(
      card(page).getByRole("alert").filter({
        hasText: "This import expired 24 hours after it was uploaded; upload the file again",
      }),
    ).toBeVisible();
    await expect(card(page)).toContainText("This import expired on");
    await expect(card(page).getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);

    await openSession(page, "00000000-0000-4000-8000-000000000000");
    await expect(card(page).getByRole("alert")).toContainText(
      "That import session no longer exists",
    );
    await expect(
      card(page).getByRole("button", { name: "Upload a fresh file", exact: true }),
    ).toBeVisible();
  });

  test("8. not your import: look only; a 403 and a 409 are shown in the server's words", async ({
    page,
  }) => {
    const theirs = await upload(renameOne("c"), file("theirs"), admin);
    await openSession(page, theirs.id, "reception_admin", "&status=override");
    await expect(card(page).getByRole("note")).toContainText(
      `Not your import: only ${USERS.admin.name} or an admin can decide, commit or abandon it.`,
    );
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(rowOf(page, `${P}-G3`)).toContainText(`→ Renamed 3 c ${T}`);
    await expect(card(page).getByRole("button", { name: /^Override / })).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Abandon", exact: true })).toHaveCount(0);

    const mine = await upload(renameOne("d"), file("mine"), recAdmin);
    await openSession(page, mine.id, "reception_admin", "&status=override");
    const refusal = "Only the person who uploaded this file, or an admin, can change this import";
    await page.route(`**/api/billing/import/sessions/${mine.id}/decisions`, (route) =>
      route.fulfill({ status: 403, json: { error: refusal } }),
    );
    await rowOf(page, `${P}-G3`)
      .getByRole("button", { name: "Keep Groups row 2", exact: true })
      .click();
    await expect(card(page).getByRole("alert")).toHaveText(refusal);
    await page.unroute(`**/api/billing/import/sessions/${mine.id}/decisions`);

    const other = await upload(
      { Groups: [...renameOne("e").Groups, ...oneNewGroup("e").Groups] },
      file("other"),
      recAdmin,
    );
    await openSession(page, other.id, "reception_admin", "&status=override");
    const stale = rowOf(page, `${P}-G3`);
    await expect(stale).toContainText("Undecided — will be kept");
    const done = await sessions.commitSession(other.id, { ctx: recAdmin }, db);
    await stale.getByRole("button", { name: "Override Groups row 2", exact: true }).click();
    await expect(card(page).getByRole("alert")).toHaveText(
      `This import is already saved (import ${done.importId}); its rows are kept as that import's report`,
    );
    await expect(page.getByRole("heading", { name: "Import report", exact: true })).toBeVisible();
  });

  test("9. Abandon asks first, then removes the import and saves nothing", async ({ page }) => {
    const gone = await upload(oneNewGroup("f"), file("gone"), recAdmin);
    await openSession(page, gone.id);
    await card(page).getByRole("button", { name: "Abandon", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: `Abandon ${file("gone")}?` });
    await expect(confirm).toContainText("Nothing from it is saved to Scribe");
    await confirm.getByRole("button", { name: "Keep working", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(urlParam(page, "session")).toBe(gone.id);

    await card(page).getByRole("button", { name: "Abandon", exact: true }).click();
    await confirm.getByRole("button", { name: "Abandon import", exact: true }).click();
    await expect(card(page)).toHaveCount(0);
    expect(urlParam(page, "session")).toBeNull();
    const left = (
      await query(`SELECT status FROM billing_import_sessions WHERE id = $1`, [gone.id])
    ).rows;
    expect(left.every((r) => r.status === "abandoned")).toBe(true);
    expect((await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`${P}-Xf`])).rows).toEqual(
      [],
    );
  });

  test("10. at 390px the page never scrolls sideways; the table scrolls in its own box", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSession(page, mainId, "reception_admin", "&outcome=failed");
    await expect(bodyRows(page)).toHaveCount(2);
    const box = table(page).locator("xpath=..");
    expect(
      await box.evaluate((el) => ({
        over: el.scrollWidth > el.clientWidth,
        css: getComputedStyle(el).overflowX,
      })),
    ).toEqual({ over: true, css: "auto" });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0);

    const open = await upload(renameOne("g"), file("phone"), recAdmin);
    await openSession(page, open.id, "reception_admin", "&status=override");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
  });
});
