import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { anonymousApi, apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const LAB_ONLY_DOCTOR = "Dr. Hospital Admin";
const LIST = "/api/billing/counter/patients";
const ARRIVALS = "/api/giniflow/stations/reception/arrivals";

const ARRIVAL_KEYS = [
  "age",
  "alreadyOnFloorAs",
  "assignedDoctorId",
  "assignedDoctorName",
  "assignedSdId",
  "assignedSdName",
  "blockedReason",
  "bookingType",
  "checkedInAt",
  "fileNo",
  "journey",
  "minutesLate",
  "name",
  "orderedServices",
  "patientId",
  "paused",
  "pausedAt",
  "pausedReason",
  "phone",
  "priority",
  "schemeCode",
  "schemeOpdFee",
  "sex",
  "sinceMinutes",
  "slot",
  "status",
  "statusLabel",
  "statusSince",
  "suggestedVisitTypeId",
  "visitId",
  "walkIn",
];

const tag = newTag();
const nameOf = (label) => `P4 ${label} ${tag}`;
let ids;
const visits = {};
let billNo = 0;

const PLAN = {
  FloorEarly: { status: "checked_in", at: "08:00" },
  FloorLate: { status: "checked_in", at: "09:00" },
  Online: { status: "checked_in", at: "09:10", visitType: "Tele Consultation" },
  Samples: { status: "checked_in", at: "09:20", labOnly: true },
  Claim: { status: "checked_in", at: "09:30" },
  Cleared: { status: "checked_in", at: "09:40" },
  DueDraft: { status: "checked_in", at: "09:50" },
  DraftClaim: { status: "checked_in", at: "09:55" },
  ClaimPaid: { status: "checked_in", at: "09:57" },
  CancelledOnly: { status: "checked_in", at: "09:58" },
  Blocked: { status: "checked_in", at: "09:59", blocked: true },
  Dispensed: { status: "dispensed", at: "07:30" },
  Exited: { status: "exited", at: "07:45" },
  Booked: { status: "booked" },
  Confirmed: { status: "confirmed" },
  NoShowDraft: { status: "no_show" },
  NoShowPaid: { status: "no_show" },
  NoShowNone: { status: "no_show" },
  CancelledDue: { status: "cancelled" },
  CancelledClaim: { status: "cancelled" },
};

async function place(label, plan) {
  const made = await extraVisit(ids, label, {
    visitType: plan.visitType || "New Patient",
    doctorId: plan.labOnly ? null : undefined,
  });
  if (plan.labOnly) {
    await query(`UPDATE appointments SET doctor_name = $2, doctor_id = NULL WHERE id = $1`, [
      made.appointment,
      LAB_ONLY_DOCTOR,
    ]);
    await query(`UPDATE giniflow_visits SET assigned_doctor_id = NULL WHERE id = $1`, [made.visit]);
  }
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [
    made.visit,
    plan.status,
  ]);
  if (plan.at) {
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', ($2 || ' ' || $3 || ':00+05:30')::timestamptz)`,
      [made.visit, ids.day, plan.at],
    );
  }
  if (plan.blocked) {
    await query(`UPDATE patients SET is_blocked = TRUE WHERE id = $1`, [made.patient]);
  }
  visits[label] = made;
  return made;
}

async function bill(label, { status, payable = 0, paid = 0, claim = 0, claimStatus = "none" }) {
  const { visit, patient } = visits[label];
  const numbered = status !== "draft";
  billNo += 1;
  const settlement =
    claimStatus === "cleared"
      ? (
          await one(
            `INSERT INTO claim_settlements (payer_name, received_on, reference, amount)
             VALUES ($1, $2::date, $3, $4) RETURNING id`,
            [`CGHS ${tag}`, ids.day, `P4C09-${billNo}`, claim],
          )
        ).id
      : null;
  return one(
    `INSERT INTO bills (patient_id, visit_id, status, bill_no, series, fy, finalised_at,
                        cancelled_at, cancel_reason, actual_amount, patient_payable, paid_amount,
                        claim_amount, claim_status, claim_settlement_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      patient,
      visit,
      status,
      numbered ? `${ids.prefix}C9${billNo}` : null,
      numbered ? "MAIN" : null,
      numbered ? ids.fy : null,
      numbered ? new Date() : null,
      status === "cancelled" ? new Date() : null,
      status === "cancelled" ? "P4C-09 fixture" : null,
      payable + claim,
      payable,
      paid,
      claim,
      claimStatus,
      settlement,
    ],
  );
}

const final = (extra) => ({ status: "final", ...extra });

async function list(role = "reception", q = tag) {
  const api = await apiAs(role);
  const response = await api.get(LIST, { params: { q } });
  const body = response.ok() ? await response.json() : null;
  await api.dispose();
  return { status: response.status(), body };
}

const names = (rows) => rows.map((row) => row.name);
const everyone = (body) => [...body.toBill, ...body.billed, ...body.waiting];
const rowOf = (body, label) => everyone(body).find((row) => row.name === nameOf(label));

const counter = (page) =>
  gotoReady(page, "/giniflow/station/billing", () =>
    page.getByRole("searchbox", { name: "Search today's patients" }),
  );
const patientList = (page) => page.getByRole("complementary", { name: "Today's patients" });
const rowButton = (page, label) => patientList(page).getByRole("button", { name: nameOf(label) });
const notArrivedToggle = (page) =>
  patientList(page).getByRole("button", { name: /^Nothing to bill yet/ });

test.describe.serial("P4C-09 billing counter patient list", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    for (const [label, plan] of Object.entries(PLAN)) await place(label, plan);
    await bill("FloorEarly", { status: "draft" });
    await bill("Claim", final({ payable: 0, claim: 700, claimStatus: "pending" }));
    await bill("Cleared", final({ payable: 0, claim: 700, claimStatus: "cleared" }));
    await bill("DueDraft", final({ payable: 400, paid: 100 }));
    await bill("DueDraft", { status: "draft" });
    await bill("DraftClaim", { status: "draft" });
    await bill("DraftClaim", final({ payable: 0, claim: 500, claimStatus: "pending" }));
    await bill("ClaimPaid", final({ payable: 200, paid: 200 }));
    await bill("ClaimPaid", final({ payable: 0, claim: 500, claimStatus: "pending" }));
    await bill("CancelledOnly", { status: "cancelled", payable: 300 });
    await bill("Blocked", final({ payable: 300 }));
    await bill("Dispensed", final({ payable: 500, paid: 200 }));
    await bill("Exited", final({ payable: 600, paid: 600 }));
    await bill("NoShowDraft", { status: "draft", payable: 200 });
    await bill("NoShowPaid", final({ payable: 300, paid: 300 }));
    await bill("CancelledDue", final({ payable: 250 }));
    await bill("CancelledClaim", final({ payable: 0, claim: 900, claimStatus: "pending" }));
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. patients who owe money come first, earliest arrival first", async () => {
    const { body } = await list();
    const toBill = names(body.toBill);
    expect(toBill[0]).toBe(nameOf("DueDraft"));
    expect(toBill.slice(1).sort()).toEqual(["NoShowDraft", "CancelledDue"].map(nameOf).sort());
  });

  test("2. settled, claimed and finished patients sit below as billed today / exited", async () => {
    const { body } = await list();
    expect(names(body.billed)).toEqual(
      ["Dispensed", "Exited", "Claim", "Cleared", "DraftClaim", "ClaimPaid"].map(nameOf),
    );
    expect(body.billed.find((row) => row.name === nameOf("Dispensed")).hints.due).toBe(30000);
  });

  test("3. arrived patients with nothing to bill, then those not arrived, are listed apart", async () => {
    const { body } = await list();
    const waiting = names(body.waiting);
    expect(waiting.slice(0, 5)).toEqual(
      ["FloorEarly", "FloorLate", "Online", "Samples", "CancelledOnly"].map(nameOf),
    );
    expect(waiting.slice(5).sort()).toEqual(["Booked", "Confirmed", "Patient"].map(nameOf).sort());
    expect(names([...body.toBill, ...body.billed])).not.toContain(nameOf("Booked"));
  });

  test("4. a no-show or cancel with nothing to pay, or only a paid or claimed bill, does not show", async () => {
    const { body } = await list();
    const all = names(everyone(body));
    expect(all).not.toContain(nameOf("NoShowPaid"));
    expect(all).not.toContain(nameOf("NoShowNone"));
    expect(all).not.toContain(nameOf("CancelledClaim"));
  });

  test("5. a blocked patient never shows, even with money due", async () => {
    for (const q of [tag, ""]) {
      const { body } = await list("reception", q);
      const all = names(everyone(body));
      expect(all).toContain(nameOf("FloorLate"));
      expect(all).not.toContain(nameOf("Blocked"));
    }
  });

  test("6. a Tele visit is marked online, and only that one", async () => {
    const { body } = await list();
    expect(rowOf(body, "Online").online).toBe(true);
    expect(rowOf(body, "FloorLate").online).toBe(false);
  });

  test("7. a samples-only patient shows once arrived even while the floor hides them", async () => {
    const hidden = await one(
      `SELECT value FROM giniflow_floor_settings WHERE key = 'hide_lab_only_patients'`,
    );
    const { body } = await list();
    expect(rowOf(body, "Samples")?.samplesOnly).toBe(true);
    expect(rowOf(body, "FloorLate").samplesOnly).toBe(false);
    const api = await apiAs("reception");
    const arrivals = await (await api.get(ARRIVALS, { params: { q: tag } })).json();
    await api.dispose();
    const onReception = names([...arrivals.expected, ...arrivals.onFloor]);
    expect(onReception.includes(nameOf("Samples"))).toBe(hidden?.value === false);
  });

  test("8. each row carries its bill state", async () => {
    const { body } = await list();
    const state = (label) => rowOf(body, label).bill;
    expect(state("FloorLate")).toEqual({ state: "none", due: 0 });
    expect(state("FloorEarly")).toEqual({ state: "draft", due: 0 });
    expect(state("Dispensed")).toEqual({ state: "due", due: 30000 });
    expect(state("Exited")).toEqual({ state: "paid", due: 0 });
    expect(state("Claim")).toEqual({ state: "claim_pending", due: 0 });
    expect(state("Cleared")).toEqual({ state: "claim_cleared", due: 0 });
    expect(state("CancelledOnly")).toEqual({ state: "none", due: 0 });
    expect(state("CancelledDue")).toEqual({ state: "due", due: 25000 });
  });

  test("9. with several bills the most urgent wins: due, then draft, then CGHS pending", async () => {
    const { body } = await list();
    expect(rowOf(body, "DueDraft").bill).toEqual({ state: "due", due: 30000 });
    expect(rowOf(body, "DraftClaim").bill.state).toBe("draft");
    expect(rowOf(body, "ClaimPaid").bill.state).toBe("claim_pending");
  });

  test("10. search finds a patient who has not arrived", async () => {
    const { body } = await list("reception", `F4Booked-${tag}`);
    expect(names(body.waiting)).toEqual([nameOf("Booked")]);
    expect(body.toBill).toEqual([]);
    expect(body.billed).toEqual([]);
  });

  test("11. the desk roles read the list; roles without the billing desk are refused", async () => {
    for (const role of ["reception", "reception_admin", "admin"]) {
      expect((await list(role)).status, role).toBe(200);
    }
    for (const role of ["coordinator", "lab", "banshali"]) {
      expect((await list(role)).status, role).toBe(403);
    }
    const anonymous = await anonymousApi();
    expect((await anonymous.get(LIST)).status()).toBe(403);
    await anonymous.dispose();
  });

  test("12. reception's Arrivals list is unchanged for the same patients", async () => {
    const api = await apiAs("reception");
    const response = await api.get(ARRIVALS, { params: { q: tag } });
    const arrivals = await response.json();
    await api.dispose();
    expect(response.status()).toBe(200);
    expect(Object.keys(arrivals).sort()).toEqual(
      ["counts", "date", "expected", "notComing", "onFloor", "query", "serverTime"].sort(),
    );
    const hidden =
      (await one(`SELECT value FROM giniflow_floor_settings WHERE key = 'hide_lab_only_patients'`))
        ?.value !== false;
    expect(names(arrivals.expected)).toEqual(["Booked", "Confirmed", "Patient"].map(nameOf));
    expect(names(arrivals.onFloor)).toEqual(
      [
        "FloorEarly",
        "FloorLate",
        "Online",
        ...(hidden ? [] : ["Samples"]),
        "Claim",
        "Cleared",
        "DueDraft",
        "DraftClaim",
        "ClaimPaid",
        "CancelledOnly",
        "Dispensed",
        "Exited",
      ].map(nameOf),
    );
    expect(names(arrivals.notComing).sort()).toEqual(
      ["NoShowDraft", "NoShowPaid", "NoShowNone", "CancelledDue", "CancelledClaim"]
        .map(nameOf)
        .sort(),
    );
    for (const row of [...arrivals.expected, ...arrivals.onFloor, ...arrivals.notComing]) {
      expect(Object.keys(row).sort()).toEqual(ARRIVAL_KEYS);
    }
  });

  test("13. the badges show on the counter's rows", async ({ page }) => {
    await loginAs(page, "reception");
    await counter(page);
    await page.getByRole("searchbox", { name: "Search today's patients" }).fill(tag);
    const badges = {
      Online: "Online",
      Samples: "Samples only",
      FloorLate: "No bill",
      FloorEarly: "Draft",
      Dispensed: "₹300 due",
      Exited: "Paid",
      Claim: "CGHS pending",
      Cleared: "Cleared",
    };
    for (const [label, text] of Object.entries(badges)) {
      await expect(rowButton(page, label)).toContainText(text);
    }
    await expect(rowButton(page, "FloorLate")).not.toContainText("Online");
    await expect(rowButton(page, "FloorLate")).not.toContainText("Samples only");
  });

  test("14. the nothing-to-bill section starts collapsed and opens and closes on click", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await counter(page);
    const toggle = notArrivedToggle(page);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(rowButton(page, "Booked")).toBeHidden();
    await expect(rowButton(page, "FloorLate")).toBeHidden();
    await expect(rowButton(page, "Dispensed")).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(rowButton(page, "Booked")).toBeVisible();
    await expect(rowButton(page, "Confirmed")).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(rowButton(page, "Booked")).toBeHidden();
  });

  test("15. a search opens the section on the patient who has not arrived", async ({ page }) => {
    await loginAs(page, "reception");
    await counter(page);
    const search = page.getByRole("searchbox", { name: "Search today's patients" });
    await search.fill(`F4Booked-${tag}`);
    await expect(rowButton(page, "Booked")).toBeVisible();
    await expect(notArrivedToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(notArrivedToggle(page)).toContainText("1");
    await rowButton(page, "Booked").click();
    await expect(page).toHaveURL(new RegExp(`visit=${visits.Booked.visit}`));
    await search.fill("");
    await expect(notArrivedToggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("16. the to-bill list runs by arrival with the billed patients below it", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await counter(page);
    await page.getByRole("searchbox", { name: "Search today's patients" }).fill(tag);
    await expect(rowButton(page, "Dispensed")).toBeVisible();
    const order = await patientList(page)
      .locator(".bc-list__body .bc-row .bc-row__name, .bc-list__body .bc-group")
      .allInnerTexts();
    const at = (text) =>
      order.findIndex((entry) =>
        entry
          .replace(/^[▾▸]\s*/, "")
          .toLowerCase()
          .startsWith(text.toLowerCase()),
      );
    expect(at(nameOf("DueDraft"))).toBeLessThan(at(nameOf("NoShowDraft")));
    expect(at(nameOf("NoShowDraft"))).toBeLessThan(at("Billed today"));
    expect(at("Billed today")).toBeLessThan(at(nameOf("Dispensed")));
    expect(at(nameOf("Dispensed"))).toBeLessThan(at(nameOf("Exited")));
    expect(at(nameOf("Exited"))).toBeLessThan(at(nameOf("Claim")));
  });

  test("17. a role without the billing desk cannot open the counter", async ({ page }) => {
    await loginAs(page, "coordinator");
    await page.goto("/giniflow/station/billing");
    await expect(page).not.toHaveURL(/giniflow\/station\/billing/);
  });
});
