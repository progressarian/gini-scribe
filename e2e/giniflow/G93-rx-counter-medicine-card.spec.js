import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { buildCard } = await import("../../server/services/giniflow/medicineCard.js");
const { buildMedicineCardHtml, groupForPrint } =
  await import("../../server/services/giniflow/medicineCardPdf.js");

const tag = newTag();
let ids;
const made = {};

async function med(patientId, name, extra = {}) {
  await query(
    `INSERT INTO medications (patient_id, name, dose, frequency, when_to_take, composition,
                              for_diagnosis, instructions, external_doctor, is_active)
     VALUES ($1, $2, $3, $4, $5::when_to_take_pill[], $6, $7, $8, $9, true)`,
    [
      patientId,
      name,
      extra.dose ?? "1 tab",
      extra.frequency ?? "OD",
      extra.when ?? null,
      extra.composition ?? null,
      extra.forDiagnosis ?? null,
      extra.instructions ?? null,
      extra.external ?? null,
    ],
  );
}

const html = async (patient, extra = {}) =>
  buildMedicineCardHtml({
    patient,
    card: await buildCard(patient.id, db),
    printedAt: "15 Oct 2026",
    doctorName: "Dr Test",
    ...extra,
  });

test.describe.serial("G93 the Rx counter prints the medicine card", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made.full = await extraVisit(ids, "CardFull", { healthray: false });
    made.empty = await extraVisit(ids, "CardEmpty", { healthray: false });
    made.long = await extraVisit(ids, "CardLong", { healthray: false });
    const p = made.full.patient;
    await med(p, `Glycomet ${tag}`, {
      frequency: "BD",
      when: ["After breakfast", "After dinner"],
      composition: "Metformin + Glimepiride",
      forDiagnosis: ["Diabetes"],
      instructions: "Take after food",
    });
    await med(p, `Rosuvas ${tag}`, { when: ["After dinner"] });
    await med(p, `Thyronorm ${tag}`, { when: ["Fasting"] });
    await med(p, `Unset ${tag}`, { dose: null });
    await med(p, `Outside ${tag}`, { when: ["At bedtime"], external: "Dr Cardio" });
    for (let i = 1; i <= 25; i += 1) {
      await med(made.long.patient, `Very long medicine name number ${i} extended release ${tag}`, {
        when: ["After breakfast"],
        composition: "A rather long composition text that should wrap on the printed card",
      });
    }
  });

  test.afterAll(async () => {
    await query(`DELETE FROM medications WHERE name LIKE $1`, [`%${tag}`]);
    await tearDown(ids);
  });

  test("1. a twice-a-day medicine is printed under each of its times, in clock order", async () => {
    const groups = groupForPrint(await buildCard(made.full.patient, db));
    expect(groups.map((g) => g.label)).toEqual([
      "Empty Stomach",
      "After Breakfast",
      "After Dinner",
      "Bedtime",
      "Timing not set",
    ]);
    const names = (label) =>
      groups.find((g) => g.label === label).medicines.map((m) => m.name.replace(` ${tag}`, ""));
    expect(names("After Breakfast")).toEqual(["Glycomet"]);
    expect(names("After Dinner").sort()).toEqual(["Glycomet", "Rosuvas"]);
    expect(names("Timing not set")).toEqual(["Unset"]);
  });

  test("2. the card names the patient and every detail, with no blanks leaking through", async () => {
    const patient = {
      id: made.full.patient,
      name: `P4 CardFull ${tag}`,
      file_no: "F-93",
      age: 58,
      sex: "M",
    };
    const page = await html(patient, { nextVisit: "2026-11-15" });
    const body = page.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(body).toContain(`P4 CardFull ${tag}`);
    expect(body).toContain("F-93");
    expect(body).toContain("Medicine card");
    expect(body).toContain("Metformin + Glimepiride · for Diabetes");
    expect(body).toContain("ⓘ Take after food");
    expect(body).toContain("Not from Gini · Dr Cardio");
    expect(body).toContain("Next visit: <b>Sun, 15 Nov, 2026</b>");
    expect(body).toMatch(/class="mc-count">2</);
    expect(body).not.toMatch(/undefined|>null</);
    const empty = await html({ id: made.empty.patient, name: "Empty" });
    expect(empty).toContain("No active medicines on record.");
  });

  test("3. a long list keeps each medicine whole across pages", async () => {
    const page = await html({ id: made.long.patient, name: "Long" });
    expect(page).toContain("break-inside:avoid");
    expect((page.match(/class="mc-med"/g) || []).length).toBe(25);
  });

  test("4. the counter can print it; a role without Rx printing cannot; an unknown visit is 404", async () => {
    const get = async (role, visit) => {
      const api = await apiAs(role);
      try {
        const res = await api.get(`/api/giniflow/stations/rx/${visit}/medicine-card.pdf`);
        return {
          status: res.status(),
          type: res.headers()["content-type"],
          body: await res.body(),
        };
      } finally {
        await api.dispose();
      }
    };
    const ok = await get("coordinator", made.full.visit);
    expect(ok.status).toBe(200);
    expect(ok.type).toContain("application/pdf");
    expect(ok.body.subarray(0, 4).toString()).toBe("%PDF");
    expect((await get("lab", made.full.visit)).status).toBe(403);
    expect((await get("coordinator", "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const doctor = await apiAs("admin");
    try {
      const res = await doctor.get(
        `/api/giniflow/stations/doctor/${made.full.visit}/medicine-card.pdf`,
      );
      expect(res.status()).toBe(200);
    } finally {
      await doctor.dispose();
    }
  });

  test("5. the Rx counter has a Print medicine card button that opens the card", async ({
    page,
  }) => {
    await query(`UPDATE giniflow_visits SET current_status = 'rx_pending' WHERE id = ANY($1)`, [
      [made.full.visit, made.empty.visit],
    ]);
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/rx");
    await page.getByText(`P4 CardFull ${tag}`).first().click();
    const button = page.getByRole("button", { name: "🖨 Print medicine card" });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByText(`Medicine card — P4 CardFull ${tag}`).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByText(`P4 CardEmpty ${tag}`).first().click();
    await expect(page.getByRole("button", { name: "🖨 Print medicine card" })).toBeDisabled();
  });
});
