import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { apiAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { buildCatalogTest, buildPatient } from "../../helpers/builders.mjs";
import { buildTestEnv, repoRoot } from "../../setup/testEnv.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const day = (month) => `2031-${month}-${String(1 + (parseInt(tag, 16) % 27)).padStart(2, "0")}`;
const GHM_DAY = day("03");
const FLOOR_DAY = day("04");
const TEST = `P136 Ferritin ${tag}`;
const seed = { appointments: [], patients: [], visits: [] };
const CATEGORY_VALUES = JSON.parse(
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { CATEGORY_VALUES } from "./shared/patientCategories.js"; console.log(JSON.stringify(CATEGORY_VALUES));',
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).stdout,
);

const runSmoke = (script, date) =>
  spawnSync("npm", ["run", "-s", script, "--", date], {
    cwd: path.join(repoRoot, "server"),
    env: buildTestEnv(),
    encoding: "utf8",
  });

const expectAllPass = (result) => {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).not.toContain("FAIL");
  expect(result.stdout).not.toMatch(/Need \d+ appointments/);
  expect(result.stdout).toContain("PASS");
};

test.describe.serial("P1-36 regression checks", () => {
  test.beforeAll(async () => {
    for (let i = 0; i < CATEGORY_VALUES.length + 2; i += 1) {
      const patient = await buildPatient({ name: `P136 GHM ${tag} ${i}` });
      seed.patients.push(patient.id);
      const appt = await one(
        `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type, status)
         VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING id`,
        [patient.id, patient.name, patient.file_no, GHM_DAY, i % 2 ? "Follow-Up" : "New"],
      );
      seed.appointments.push(appt.id);
    }
    seed.test = await buildCatalogTest({ test_name: TEST, price: 350 });
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM giniflow_lab_order_tests WHERE lab_order_id IN
         (SELECT id FROM giniflow_lab_orders WHERE visit_id = ANY($1::uuid[]))`,
      [seed.visits],
    );
    await query(`DELETE FROM giniflow_lab_orders WHERE visit_id = ANY($1::uuid[])`, [seed.visits]);
    await query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [seed.visits]);
    await query(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [seed.appointments]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [seed.patients]);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P136%${tag}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P136%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P136%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P136%${tag}`]);
    if (seed.test) await query(`DELETE FROM giniflow_test_catalog WHERE id = $1`, [seed.test.id]);
  });

  test("1. npm run build is clean", async () => {
    test.setTimeout(240000);
    const result = spawnSync("npm", ["run", "build"], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/built in/);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\berror\b/i);
  });

  test("2. npm run smoke:ghm-categories passes on a seeded day, and restores it", async () => {
    const before = (
      await query(
        `SELECT id, patient_category FROM appointments WHERE id = ANY($1::int[]) ORDER BY id`,
        [seed.appointments],
      )
    ).rows;
    const result = runSmoke("smoke:ghm-categories", GHM_DAY);
    expectAllPass(result);
    for (const value of CATEGORY_VALUES) expect(result.stdout).toContain(`PASS  set ${value}`);
    expect(result.stdout).toContain("PASS  unknown category refused");
    expect(result.stdout).toContain("PASS  list summary carries per-category counts");
    const after = (
      await query(
        `SELECT id, patient_category FROM appointments WHERE id = ANY($1::int[]) ORDER BY id`,
        [seed.appointments],
      )
    ).rows;
    expect(after, "every appointment the script touched is put back").toEqual(before);
  });

  test("3. npm run smoke:ghm-pill-filters passes on the same day", async () => {
    await query(
      `UPDATE appointments SET patient_category = $2, show_no_show = 'Show'
        WHERE id = $1`,
      [seed.appointments[0], "cghs"],
    );
    const result = runSmoke("smoke:ghm-pill-filters", GHM_DAY);
    expectAllPass(result);
    expect(result.stdout).toContain(`${GHM_DAY}: total ${seed.appointments.length}`);
  });

  test("4. the MO screen and reception's payment queue show unchanged prices", async () => {
    const admin = await apiAs("admin");
    const panelPrice = async () =>
      (await (await admin.get("/api/giniflow/stations/mo/test-panels")).json()).tests.find(
        (t) => (t.name ?? t.test_name) === TEST,
      )?.price;
    const book = async () => {
      const patient = await buildPatient({ name: `P136 Floor ${tag} ${seed.visits.length}` });
      seed.patients.push(patient.id);
      const visit = await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
         VALUES ($1, $2, 'arrived') RETURNING id`,
        [patient.id, FLOOR_DAY],
      );
      seed.visits.push(visit.id);
      const ordered = await admin.post(`/api/giniflow/stations/mo/${visit.id}/tests`, {
        data: { urgency: "today", tests: [TEST] },
      });
      expect(ordered.status(), await ordered.text()).toBe(200);
      return visit.id;
    };
    const queuePrice = async (visitId) => {
      const queue = await (
        await admin.get(`/api/giniflow/stations/reception/queue?date=${FLOOR_DAY}`)
      ).json();
      const card = [...queue.pending, ...queue.awaitingSample, ...queue.cleared].find(
        (o) => o.visitId === visitId,
      );
      expect(card, "the order is on reception's queue").toBeTruthy();
      expect(card.tests.map((t) => [t.name, Number(t.price)])).toEqual([[TEST, card.total]]);
      return card.total;
    };

    expect(await panelPrice()).toBe(350);
    const before = await book();
    expect(await queuePrice(before)).toBe(350);

    const master = await apiAs("reception_admin");
    const group = await (
      await master.post("/api/billing/master/groups", {
        data: { code: `P136G_${tag}`, name: `P136 ${tag}` },
      })
    ).json();
    const sub = await (
      await master.post("/api/billing/master/subgroups", {
        data: { group_id: group.id, code: `P136S_${tag}`, name: `P136 sub ${tag}` },
      })
    ).json();
    const item = await master.post("/api/billing/master/items", {
      data: {
        code: `P136I_${tag}`,
        name: TEST,
        subgroup_id: sub.id,
        base_price: 350,
        kind: "test",
        test_catalog_id: seed.test.id,
      },
    });
    expect(item.status()).toBe(201);
    await master.dispose();

    expect(await panelPrice(), "same price once the test is billed from its item").toBe(350);
    const after = await book();
    expect(await queuePrice(after)).toBe(350);
    expect(await queuePrice(before), "the earlier order keeps its price").toBe(350);
    await admin.dispose();
  });
});
