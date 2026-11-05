import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { query } from "../helpers/db.mjs";
import { newTag, today } from "./opd-fixture.mjs";

const MONTH = "2021-03";
const FROM = `${MONTH}-01`;
const TO = `${MONTH}-31`;
const tag = newTag();
const NOTE = `opd-dash-page-${tag}`;
const docA = `Dr. Page A ${tag}`;
const docB = `Dr. Page, B ${tag}`;
const PATH = "/reports/opd-dashboard";
let now;

async function book(patient, doctor, day, visitType, status, timeSlot = null) {
  await query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name,
                               appointment_date, time_slot, visit_type, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      patient.id,
      patient.name,
      patient.file_no,
      patient.phone ?? null,
      doctor,
      day,
      timeSlot,
      visitType,
      status,
      NOTE,
    ],
  );
}

const custom = (extra = "") =>
  `${PATH}?range=custom&from=${FROM}&to=${TO}&doctor=${encodeURIComponent(docA)}${extra}`;
const open = (page, url) =>
  gotoReady(page, url, () => page.getByRole("heading", { name: "OPD dashboard" }));

test.describe.serial("R04 OPD dashboard page", () => {
  test.beforeAll(async () => {
    now = await today();
    const p = PATIENTS;
    await book(p.general, docA, `${MONTH}-02`, "New Patient", "completed", "09:30");
    await book(p.senior, docA, `${MONTH}-02`, "Follow-Up", "completed", "10:00");
    await book(p.cghsPaid, docA, `${MONTH}-03`, "Follow-Up", "checkedin", "10:00");
    await book(p.senior, docA, `${MONTH}-05`, "Follow-Up", "no_show");
    await book(p.pensioner, docA, `${MONTH}-08`, "Follow-Up", "scheduled");
    await book(p.general, docB, `${MONTH}-09`, "Follow-Up", "completed", "16:00");
    await book(p.senior, docA, "2021-02-10", "Follow-Up", "completed", "09:00");
    await book(p.general, docA, now, "Follow-Up", "scheduled", "10:00");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE notes = $1`, [NOTE]);
  });

  test("1. presets write the link, and a reload keeps the view", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, PATH);
    await expect(page.getByRole("button", { name: "This month" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Last 30 days" }).click();
    await expect(page).toHaveURL(/range=last_30/);
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page).toHaveURL(/group=week/);
    await page.reload();
    await expect(page.getByRole("button", { name: "Last 30 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Custom" }).click();
    await expect(page.getByLabel("From")).toBeVisible();
  });

  test("2. tiles and the funnel show the numbers and open the right patients", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, custom());
    const tiles = page.getByRole("region", { name: "Headline figures" });
    await expect(tiles.getByRole("link", { name: /^Visits: 3/ })).toBeVisible();
    await expect(tiles.getByRole("link", { name: /^Completed: 2/ })).toBeVisible();
    await expect(tiles.getByRole("link", { name: /^Did not come: 1/ })).toContainText(
      "1 not updated",
    );
    await expect(tiles.getByRole("link", { name: /^Pending today/ })).toHaveCount(0);
    await tiles.getByRole("link", { name: /^Did not come/ }).click();
    await expect(page).toHaveURL(/\/visits\?.*state=did_not_come/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Did not come");
    const rows = page.getByRole("table", { name: "Visits" }).getByRole("row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("No-show");
    await page.getByRole("link", { name: "Back to OPD dashboard" }).click();
    await expect(page).toHaveURL(new RegExp(`from=${FROM}`));
    await expect(page.getByRole("heading", { name: "OPD dashboard" })).toBeVisible();
  });

  test("3. the table under the trend links to one period's patients", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, custom("&group=week"));
    await page.getByRole("region", { name: "Visits by week" }).getByText("Show as table").click();
    const table = page.getByRole("table", { name: "Visits by period" });
    await table.getByRole("link").first().click();
    await expect(page).toHaveURL(/bucket_start=2021-03-01/);
    await expect(page.getByRole("table", { name: "Visits" }).getByRole("row")).toHaveCount(5);
  });

  test("4. consultants: picking several, a comma in a name, chips and Clear filters", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await open(page, `${PATH}?range=custom&from=${FROM}&to=${TO}`);
    await page.getByRole("button", { name: "All consultants" }).click();
    await page.getByLabel("Search consultants").fill(tag);
    await page.getByLabel(new RegExp(`Page A ${tag}`)).check();
    await page.getByLabel(new RegExp(`Page, B ${tag}`)).check();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("button", { name: "2 selected" })).toBeVisible();
    const tiles = page.getByRole("region", { name: "Headline figures" });
    await expect(tiles.getByRole("link", { name: /^Visits: 4/ })).toBeVisible();
    await expect(page).toHaveURL(/doctor=.*doctor=/);
    await page.getByRole("button", { name: `Remove ${docB}` }).click();
    await expect(tiles.getByRole("link", { name: /^Visits: 3/ })).toBeVisible();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByRole("button", { name: "All consultants" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
    await expect(page.getByRole("button", { name: "This month" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
  });

  test("5. the type chart keeps every type and its links carry the type", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, custom("&type=new"));
    const types = page.getByRole("region", { name: "Patient type" });
    await expect(types.getByRole("link", { name: "Follow-up" })).toBeVisible();
    await types.getByRole("link", { name: /^New/ }).click();
    await expect(page).toHaveURL(/type=new/);
    await expect(page.getByRole("table", { name: "Visits" }).getByRole("row")).toHaveCount(2);
  });

  test("6. today shows Pending and a same-weekday comparison", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, `${PATH}?range=today&doctor=${encodeURIComponent(docA)}`);
    const tiles = page.getByRole("region", { name: "Headline figures" });
    await expect(tiles.getByRole("link", { name: /^Pending today: 1/ })).toBeVisible();
    await expect(tiles.getByRole("link", { name: /^Visits/ })).toContainText(/Last \w+: 0/);
  });

  test("7. empty, bad and failed views say what happened", async ({ page }) => {
    await loginAs(page, "admin");
    await open(
      page,
      `${PATH}?range=custom&from=2020-01-01&to=2020-01-02&doctor=${encodeURIComponent(docA)}`,
    );
    await expect(page.getByText(/No appointments match these filters over/)).toBeVisible();
    await page.goto(`${PATH}?range=custom&from=2026-13-45&to=2026-01-01`);
    await expect(page.getByRole("alert")).toContainText("Choose a valid start date.");
    await page.goto(`${PATH}?range=custom&from=2021-03-01&to=2999-01-01`);
    await expect(page.getByRole("alert")).toContainText("The end date can't be after today.");
    await page.route("**/api/reports/opd/dashboard**", (route) =>
      route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await page.goto(custom());
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 20000 });
    await page.unroute("**/api/reports/opd/dashboard**");
    await page.goto(
      `${PATH}/visits?from=${FROM}&to=${TO}&doctor=${encodeURIComponent(docA)}&state=nonsense&type=bad&page=999`,
    );
    await expect(page.getByRole("heading", { level: 1 })).toContainText("All booked");
    await expect(page.getByText(/^Showing 1–/)).toBeVisible();
    await page.getByLabel("Search").fill("no-such-patient-zz");
    await expect(page.getByText(/No visits match/)).toBeVisible();
  });

  test("7b. the dashboard and the Live Dashboard tab link to each other", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, custom());
    await page.getByRole("link", { name: "Today's clinical view" }).click();
    await expect(page).toHaveURL(/\/opd\?tab=dashboard/);
    await page.getByRole("link", { name: /Trends and consultants/ }).click();
    await expect(page.getByRole("heading", { name: "OPD dashboard" })).toBeVisible();
  });

  test("7c. a patient opens in a new tab and always the one clicked, whoever is already open", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await loginAs(page, "admin");
    await gotoReady(
      page,
      `${PATH}/visits?from=${FROM}&to=${TO}&state=completed&doctor=${encodeURIComponent(docA)}`,
      () => page.getByRole("table", { name: "Visits" }),
    );
    const list = page.url();
    for (const patient of [PATIENTS.general, PATIENTS.senior]) {
      const [tab] = await Promise.all([
        page.context().waitForEvent("page"),
        page
          .getByRole("table", { name: "Visits" })
          .getByRole("link", { name: patient.name, exact: true })
          .click(),
      ]);
      await expect(tab.locator("body")).toContainText(patient.name, { timeout: 40000 });
      const other = patient === PATIENTS.general ? PATIENTS.senior : PATIENTS.general;
      await expect(tab.locator("body")).not.toContainText(other.name);
      await tab.close();
    }
    expect(page.url()).toBe(list);
  });

  test("7d. an empty column can't be opened, and the trend line skips part periods", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await open(page, custom("&group=day"));
    await page.getByRole("region", { name: "Visits by day" }).getByText("Show as table").click();
    const table = page.getByRole("table", { name: "Visits by period" });
    await expect(table.getByRole("row", { name: /^1 Mar/ }).getByRole("link")).toHaveCount(0);
    await expect(table.getByRole("row", { name: /^2 Mar/ }).getByRole("link")).toHaveCount(1);
    const box = await page
      .getByRole("region", { name: "Visits by day" })
      .locator(".recharts-wrapper")
      .boundingBox();
    await page.mouse.click(box.x + 48, box.y + box.height / 2);
    await page.waitForTimeout(300);
    expect(page.url()).not.toContain("/visits");
  });

  test("7e. filter controls never overlap, at any width, and Reset works", async ({ page }) => {
    await loginAs(page, "admin");
    for (const width of [1920, 1366, 1100, 1024, 900, 768, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      for (const url of [`${PATH}?range=last_12_weeks`, custom("&type=all&group=week")]) {
        await open(page, url);
        const clashes = await page.evaluate(() => {
          const items = [...document.querySelectorAll(".brep-filters > *")];
          const boxes = items.map((el) => el.getBoundingClientRect());
          const inner = [
            ...document.querySelectorAll(".brep-filters select, .brep-filters button"),
          ];
          const found = [];
          inner.forEach((a, i) => {
            const x = a.getBoundingClientRect();
            inner.slice(i + 1).forEach((b) => {
              const y = b.getBoundingClientRect();
              if (
                x.left < y.right - 1 &&
                y.left < x.right - 1 &&
                x.top < y.bottom - 1 &&
                y.top < x.bottom - 1
              ) {
                found.push(`${a.textContent.slice(0, 20)} / ${b.textContent.slice(0, 20)}`);
              }
            });
          });
          return { found, wide: boxes.some((b) => b.right > window.innerWidth) };
        });
        expect(clashes, `${width} ${url}`).toEqual({ found: [], wide: false });
      }
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${PATH}$`));
    }
  });

  test("7f. Refresh shows it is working, skips the cache and says when it updated", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await open(page, custom());
    await expect(page.locator(".sd-showing")).toContainText("Updated");
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const asked = [];
    await page.route("**/api/reports/opd/dashboard**", async (route) => {
      asked.push(route.request().url());
      await held;
      await route.continue();
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((url) => url.includes("fresh=1"))).toBe(true);
    release();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(page.locator(".sd-showing")).toContainText("Updated");
  });

  test("7g. closing the consultant picker throws away what wasn't applied", async ({ page }) => {
    await loginAs(page, "admin");
    await open(page, `${PATH}?range=custom&from=${FROM}&to=${TO}`);
    const button = page.locator(".fpop__btn");
    for (const close of [
      () => page.keyboard.press("Escape"),
      () => page.getByRole("button", { name: "Close", exact: true }).click(),
      () => button.click(),
    ]) {
      await button.click();
      await page.getByLabel("Search consultants").fill(tag);
      await page.locator(".opd-picker input[type=checkbox]").first().check();
      await close();
      await expect(page.locator(".fpop")).toHaveCount(0);
      expect(page.url()).not.toContain("doctor=");
      await button.click();
      await expect(page.getByLabel("Search consultants")).toHaveValue("");
      await expect(page.locator(".opd-picker input[type=checkbox]:checked")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
  });

  test("7h. nothing overlaps or runs off screen, and phone links are easy to tap", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await loginAs(page, "admin");
    const views = [
      custom("&type=all"),
      `${PATH}/visits?from=${FROM}&to=${TO}&state=booked&type=all&doctor=${encodeURIComponent(docA)}`,
    ];
    for (const width of [1366, 1024, 768, 480, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const url of views) {
        await page.goto(url);
        await page.locator(".opd-dash .flow-card").first().waitFor();
        await page.locator(".opd-dash table, .opd-tile").first().waitFor();
        const found = await page.evaluate(() => {
          const root = document.querySelector(".opd-dash");
          const shown = (el) => {
            const r = el.getBoundingClientRect();
            const head = el.closest("thead");
            const hidden =
              head &&
              (getComputedStyle(head).clip !== "auto" ||
                getComputedStyle(head).clipPath !== "none" ||
                head.getBoundingClientRect().height <= 1);
            return (
              r.width > 1 &&
              r.height > 1 &&
              !hidden &&
              !el.closest("details:not([open]) > :not(summary)")
            );
          };
          const controls = ["A", "BUTTON", "SELECT", "INPUT", "SUMMARY"];
          const nodes = [
            ...root.querySelectorAll("a,button,select,input,summary,h1,h2,td,th,p,span,strong"),
          ]
            .filter(shown)
            .filter(
              (el) =>
                controls.includes(el.tagName) || (!el.childElementCount && el.textContent.trim()),
            );
          const overlaps = [];
          nodes.forEach((a, i) => {
            const x = a.getBoundingClientRect();
            nodes.slice(i + 1).forEach((b) => {
              if (a.contains(b) || b.contains(a)) return;
              const y = b.getBoundingClientRect();
              const w = Math.min(x.right, y.right) - Math.max(x.left, y.left);
              const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
              if (w > 2 && h > 2)
                overlaps.push(`${a.textContent.slice(0, 18)} / ${b.textContent.slice(0, 18)}`);
            });
          });
          const small =
            innerWidth < 700
              ? [...root.querySelectorAll("a,button,select,input,summary")]
                  .filter(shown)
                  .filter((el) => el.getBoundingClientRect().height < 20)
                  .map((el) => el.textContent.slice(0, 18))
              : [];
          return {
            overlaps: overlaps.slice(0, 5),
            small: small.slice(0, 5),
            wide: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(found, `${width} ${url}`).toEqual({ overlaps: [], small: [], wide: false });
      }
    }
  });

  test("8. phone width has no sideways page scroll, and reception can't open it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "admin");
    await open(page, custom());
    await expect(page.getByRole("region", { name: "Headline figures" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.goto(
      `${PATH}/visits?from=${FROM}&to=${TO}&state=came&doctor=${encodeURIComponent(docA)}`,
    );
    await expect(page.getByRole("table", { name: "Visits" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.context().clearCookies();
    await loginAs(page, "reception");
    await page.goto(PATH);
    await expect(page.getByRole("heading", { name: "OPD dashboard" })).toHaveCount(0);
  });
});
