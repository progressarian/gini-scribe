import { test, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { rupees } from "../../../src/components/billing/format.js";
import { PRICES, ensureSeries, newDayTag, seedDay, tearDownDay } from "./p438-floor-day.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newDayTag();
let day;

const COUNTER = "/giniflow/station/billing";
const RECEPTION = "/giniflow/station/reception";
const REQUESTS = "/settings/desk-requests";

const region = (page, name) => page.getByRole("region", { name, exact: true });
const header = (page) => region(page, "Patient");
const lines = (page) => page.getByRole("table", { name: "Bill lines" });
const addItems = (page) => region(page, "Add items");
const codes = (page) => region(page, "Discount codes");
const pad = (page) => region(page, "Totals and payment");
const actions = (page) => region(page, "Bill actions");
const myRequests = (page) => region(page, "My requests");
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const total = (page, label) =>
  page
    .getByRole("table", { name: "Totals" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) })
    .getByRole("cell");
const lineRow = (page, name) => lines(page).getByRole("row").filter({ hasText: name });
const blockers = (page) => page.getByRole("list", { name: "Before this bill can be made final" });

const billOf = (visitId, status = null) =>
  one(
    `SELECT id, bill_no, status, scheme_code, claim_status, patient_payable::float AS payable,
            paid_amount::float AS paid, claim_amount::float AS claim
       FROM bills WHERE visit_id = $1 AND bill_type = 'invoice'
        AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [visitId, status],
  );

const orderOf = (visitId, testName) =>
  one(
    `SELECT o.id, o.payment_status, o.sample_status, o.amount_total::float AS total,
            o.amount_paid::float AS paid
       FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND t.test_name = $2
      ORDER BY o.created_at DESC LIMIT 1`,
    [visitId, testName],
  );

async function pdfText(response) {
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  const document = await getDocument({ data: new Uint8Array(await response.body()) }).promise;
  const pages = [];
  for (let at = 1; at <= document.numPages; at += 1) {
    const content = await (await document.getPage(at)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n").replace(/\s+/g, " ");
}

async function openCounter(page, visitId) {
  await gotoReady(page, `${COUNTER}?visit=${visitId}`, () => actions(page));
}

async function pickPatient(page, patient) {
  await page
    .getByRole("complementary", { name: "Today's patients" })
    .getByRole("button", { name: new RegExp(patient.name) })
    .click();
  await expect(header(page).getByRole("heading", { name: patient.name })).toBeVisible();
  await expect(actions(page)).toBeVisible();
}

async function orderTests(visitId, tests) {
  const admin = await apiAs("admin");
  const response = await admin.post(`/api/giniflow/stations/doctor/${visitId}/tests`, {
    data: { urgency: "today", tests },
  });
  expect(response.status(), await response.text()).toBe(200);
  await admin.dispose();
}

async function checkIn(page, patient) {
  const search = page.getByPlaceholder("Search today — name, file no or phone");
  await search.fill(patient.name);
  const row = page.locator(".ar-row").filter({ hasText: patient.name });
  await row.getByRole("button", { name: /Arrived/ }).click();
  const panel = page.getByRole("dialog", { name: "Check in" });
  await panel
    .getByRole("button", { name: /Check in/ })
    .first()
    .click();
  await expect(panel).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [patient.visit]))
          .current_status,
    )
    .toBe("checked_in");
}

async function pay(page, rows) {
  for (const [index, row] of rows.entries()) {
    if (index > 0) await pad(page).getByRole("button", { name: "Split payment" }).click();
    await pad(page).getByLabel("Mode").nth(index).selectOption(row.mode);
    await pad(page).getByLabel("Amount").nth(index).fill(String(row.amount));
    if (row.reference) await pad(page).getByLabel("Reference").nth(index).fill(row.reference);
  }
  await takePayment(page);
}

async function takePayment(page) {
  await pad(page)
    .getByRole("button", { name: /^Take payment/ })
    .click();
  const taken = pad(page).getByText("Payment taken.");
  const refused = pad(page).locator(".bc-err");
  await expect(taken.or(refused)).toBeVisible();
  if (await refused.count()) throw new Error(`Payment refused: ${await refused.innerText()}`);
}

async function finalise(page) {
  await ensureSeries(day);
  const [pdf] = await Promise.all([
    page.context().waitForEvent("page"),
    actions(page).getByRole("button", { name: "Finalise & print" }).click(),
  ]);
  await expect(actions(page).getByRole("button", { name: "Finalise & print" })).toHaveCount(0);
  await pdf.waitForURL(/\/bill\.pdf/, { waitUntil: "commit" });
  const url = pdf.url();
  await pdf.close();
  return url;
}

async function chooseCategory(page, label) {
  await header(page).getByLabel("Category").selectOption({ label });
  await header(page).getByRole("button", { name: "Confirm category" }).click();
}

async function answerRequest(admin, subject, fill) {
  await gotoReady(admin, REQUESTS, () =>
    admin.getByRole("heading", { name: "Waiting for an answer" }),
  );
  await admin.getByRole("button", { name: subject }).click();
  await fill(admin.getByRole("dialog"));
  await expect(admin.getByRole("dialog")).toHaveCount(0);
}

test.describe.serial("P4-38 floor trial rehearsal", () => {
  test.beforeAll(async () => {
    day = await seedDay(tag);
    day.shiftIds = [];
  });

  test.afterAll(async () => {
    await tearDownDay(day);
  });

  test("one OPD session at the Billing Counter, every case on the checklist", async ({
    browser,
  }) => {
    test.setTimeout(10 * 60 * 1000);
    const gen = day.patients.gen;
    const paid = day.patients.paid;
    const ref = day.patients.ref;
    const pens = day.patients.pens;
    const later = day.patients.later;
    const cancel = day.patients.cancel;

    const deskContext = await browser.newContext();
    const desk = await deskContext.newPage();
    await loginAs(desk, "reception");
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await loginAs(admin, "reception_admin");

    await test.step("before the day: nothing on the roster or the day's tests is unpriced", async () => {
      const views = admin.getByRole("group", { name: "Services view" });
      await gotoReady(admin, "/settings/services", () =>
        views.getByRole("button", { name: /^Not priced/ }),
      );
      await views.getByRole("button", { name: /^Not priced/ }).click();
      await admin.getByLabel("Search this list").fill(tag);
      const unpriced = admin.getByRole("table", { name: "Tests without an item" });
      await expect(unpriced).toContainText(day.tests.loose);
      await expect(unpriced).not.toContainText(day.tests.hba1c);
      await expect(unpriced).not.toContainText(day.tests.lipid);

      await admin.getByRole("tab", { name: /Consultants without a fee/ }).click();
      for (const doctor of ["Dr E2E Rahul", "Dr E2E Beant"]) {
        await admin.getByLabel("Search this list").fill(doctor);
        await expect(admin.getByRole("tabpanel")).not.toContainText(doctor);
      }
    });

    await test.step("start: the shift opens with the counted opening cash", async () => {
      await gotoReady(desk, COUNTER, () => tab(desk, "Shift"));
      await tab(desk, "Shift").click();
      const shift = region(desk, "Shift");
      const opening = shift.getByLabel("Opening cash");
      const closing = shift.getByRole("button", { name: "Close shift" });
      await expect(opening.or(closing)).toBeVisible();
      if (await closing.count()) {
        throw new Error(
          "The reception fixture user already has an open shift — another run holds it, or an earlier run left it open",
        );
      }
      await shift.getByLabel("Opening cash").fill("2000");
      await shift.getByRole("button", { name: "Open shift" }).click();
      await expect(shift.getByRole("row", { name: /Expected in the drawer/ })).toContainText(
        rupees(2000),
      );
      const open = await one(
        `SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL`,
        [USERS.reception.id],
      );
      day.shiftIds.push(open.id);
    });

    await test.step("reception checks the day's patients in on Arrivals", async () => {
      const reception = await deskContext.newPage();
      await gotoReady(reception, RECEPTION, () => reception.getByRole("tab", { name: /Arrivals/ }));
      await reception.getByRole("tab", { name: /Arrivals/ }).click();
      for (const patient of [gen, paid, ref, pens, later, cancel])
        await checkIn(reception, patient);

      await orderTests(gen.visit, [day.tests.hba1c]);
      await orderTests(gen.visit, [day.tests.loose]);
      await orderTests(pens.visit, [day.tests.hba1c]);
      await orderTests(later.visit, [day.tests.hba1c]);

      await reception.getByPlaceholder("Search today — name, file no or phone").fill(gen.name);
      const [counter] = await Promise.all([
        deskContext.waitForEvent("page"),
        reception
          .locator(".ar-row")
          .filter({ hasText: gen.name })
          .getByRole("link", { name: "Bill", exact: true })
          .click(),
      ]);
      await expect(counter).toHaveURL(new RegExp(`visit=${gen.visit}`));
      await expect(header(counter).getByRole("heading", { name: gen.name })).toBeVisible();
      await counter.close();
      await reception.close();
    });

    await test.step("General: the doctor's consultation and the MO's tests, a discount code, split payment", async () => {
      await openCounter(desk, gen.visit);
      await expect(header(desk).locator(".bc-head__cat")).toHaveText("General");
      await expect(header(desk).getByLabel("Category")).toHaveValue("");
      await expect(lineRow(desk, `Consultation Dr Rahul New ${tag}`)).toContainText(
        rupees(PRICES.rahulNew),
      );
      await expect(lineRow(desk, `HbA1c ${tag}`)).toContainText(rupees(PRICES.hba1c));
      await expect(region(desk, "Ordered tests with no price")).toContainText(day.tests.loose);

      await codes(desk).getByLabel("Discount code").fill(`NOPE${day.T}`);
      await codes(desk).getByRole("button", { name: "Apply code" }).click();
      await expect(codes(desk).locator(".bc-err")).toContainText(`NOPE${day.T}`);

      await codes(desk).getByLabel("Discount code").fill(day.code);
      await codes(desk).getByRole("button", { name: "Apply code" }).click();
      await expect(codes(desk).getByText(`${day.code} applied`)).toBeVisible();
      await expect(codes(desk)).toContainText(day.codeName);
      const gross = PRICES.rahulNew + PRICES.hba1c;
      const payable = gross * 0.9;
      await expect(total(desk, "Discount")).toHaveText(rupees(gross * 0.1));
      await expect(total(desk, "Patient payable")).toHaveText(rupees(payable));

      await pad(desk).getByLabel("Mode").selectOption("upi");
      await pad(desk).getByLabel("Amount").fill("1000");
      await expect(pad(desk).getByRole("button", { name: /^Take payment/ })).toBeDisabled();
      await expect(
        pad(desk).getByText("Add the reference for each card or UPI payment."),
      ).toBeVisible();
      await pad(desk).getByLabel("Reference").fill(`UPI${day.T}01`);
      await pad(desk).getByRole("button", { name: "Split payment" }).click();
      await pad(desk).getByLabel("Mode").nth(1).selectOption("cash");
      await pad(desk)
        .getByLabel("Amount")
        .nth(1)
        .fill(String(payable - 1000));
      await takePayment(desk);
      await expect(total(desk, "Balance")).toHaveText(rupees(0));

      const hba1c = await orderOf(gen.visit, day.tests.hba1c);
      expect(hba1c.payment_status).not.toBe("pending");
      expect(hba1c.sample_status).not.toBe("payment_pending");
      expect((await orderOf(gen.visit, day.tests.loose)).sample_status).toBe("payment_pending");

      const pdfUrl = await finalise(desk);
      expect(pdfUrl).toContain("/bill.pdf");
      const bill = await billOf(gen.visit, "final");
      day.genBill = bill;
      await expect(region(desk, "Bill lines")).toContainText(bill.bill_no);
      await expect(actions(desk).getByRole("button", { name: "Cancel unpaid bill" })).toHaveCount(
        0,
      );

      const text = await pdfText(await desk.request.get(pdfUrl));
      expect(text).toContain(bill.bill_no);
      expect(text).toContain(gen.name);
      expect(text).toContain(`Consultation Dr Rahul New ${tag}`);
      expect(text).toContain("Patient payable ₹ 1,305.00");
      expect(text).toContain("Balance ₹ 0.00");

      const receipt = await actions(desk)
        .getByRole("link", { name: "Print receipt" })
        .getAttribute("href");
      const receiptText = await pdfText(await desk.request.get(receipt));
      expect(receiptText).toContain(bill.bill_no);
      expect(receiptText).toContain(`UPI${day.T}01`);
    });

    await test.step("Second bill: a test ordered after finalise is offered on a new draft", async () => {
      await orderTests(gen.visit, [day.tests.lipid]);
      const offer = desk.getByRole("button", { name: "Open the new draft bill" });
      await expect(offer).toBeVisible({ timeout: 30000 });
      await offer.click();
      await expect(region(desk, "Bill lines").getByRole("heading")).toHaveText("This bill · draft");
      await expect(lineRow(desk, `Lipid profile ${tag}`)).toContainText(rupees(PRICES.lipid));
      await expect(lineRow(desk, `Consultation Dr Rahul New ${tag}`)).toHaveCount(0);
      await expect(region(desk, "Earlier bills on this visit")).toContainText(day.genBill.bill_no);
      await pay(desk, [{ mode: "cash", amount: PRICES.lipid }]);
      await finalise(desk);
      const second = await billOf(gen.visit, "final");
      expect(second.bill_no).not.toBe(day.genBill.bill_no);
      expect((await orderOf(gen.visit, day.tests.lipid)).sample_status).not.toBe("payment_pending");
    });

    await test.step("CGHS Paid: one tap to the sub-category, the card masked, the patient's half paid by card", async () => {
      await pickPatient(desk, paid);
      await expect(header(desk)).toContainText("Suggested from this patient's booking:");
      await header(desk)
        .getByRole("button", { name: `CGHS ${tag} › Paid` })
        .click();
      await expect(header(desk).locator(".bc-head__cat")).toHaveText(`CGHS ${tag} › Paid`);
      await header(desk).getByLabel("Card number").fill("CGHS-40011234");
      await header(desk).getByRole("button", { name: "Save numbers" }).click();
      await expect(header(desk).getByLabel("Card number")).toHaveAttribute("placeholder", /1234$/);
      await expect(header(desk).getByLabel("Card number")).not.toHaveAttribute(
        "placeholder",
        "CGHS-40011234",
      );
      await expect(total(desk, "Patient payable")).toHaveText(rupees(PRICES.beantFollowUp / 2));
      await expect(total(desk, "Claimed")).toHaveText(rupees(PRICES.beantFollowUp / 2));
      await pay(desk, [{ mode: "card", amount: PRICES.beantFollowUp / 2, reference: "SLIP 7781" }]);
      await finalise(desk);
      const bill = await billOf(paid.visit, "final");
      expect(bill.claim_status).toBe("pending");
      await expect(actions(desk).getByText("CGHS pending")).toBeVisible();
    });

    await test.step("CGHS Referral: number and scan asked for, and finalise refused without them", async () => {
      await pickPatient(desk, ref);
      await chooseCategory(desk, "Referral");
      await expect(header(desk).locator(".bc-head__cat")).toHaveText(`CGHS ${tag} › Referral`);
      await expect(blockers(desk)).toContainText("Enter the referral number first.");
      await expect(blockers(desk)).toContainText("Attach the referral letter first.");
      await expect(actions(desk).getByRole("button", { name: "Finalise & print" })).toBeDisabled();

      const bill = await billOf(ref.visit, "draft");
      const api = await apiAs("reception");
      const early = await api.post(`/api/billing/bills/${bill.id}/finalise`, {
        data: {
          version: (await one(`SELECT version FROM bills WHERE id = $1`, [bill.id])).version,
        },
      });
      expect(early.status()).toBe(409);
      expect((await early.json()).error).toMatch(/referral/i);
      await api.dispose();

      await header(desk).getByLabel("Referral number").fill("REF/2026/5521");
      await header(desk).getByRole("button", { name: "Save numbers" }).click();
      await expect(blockers(desk)).not.toContainText("Enter the referral number first.");
      await desk.route("**/api/documents/*/upload-file", (route) =>
        route.fulfill({ json: { success: true, storage_path: "rehearsal/referral.pdf" } }),
      );
      await header(desk)
        .getByLabel(/Referral scan/)
        .setInputFiles({
          name: "referral.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
        });
      await expect(header(desk).getByText("Referral scan (on file)")).toBeVisible();
      await expect(blockers(desk)).toHaveCount(0);
      await expect(total(desk, "Patient payable")).toHaveText(rupees(0));
      await finalise(desk);
      expect((await billOf(ref.visit, "final")).claim_status).toBe("pending");
    });

    await test.step("Pensioner: nothing to pay, Finalise & print, CGHS pending, and the test starts unpaid", async () => {
      await pickPatient(desk, pens);
      await header(desk)
        .getByRole("button", { name: `CGHS ${tag} › Pensioner` })
        .click();
      await expect(total(desk, "Patient payable")).toHaveText(rupees(0));
      await expect(pad(desk).getByText("No payment is needed on this bill.")).toBeVisible();
      await expect(actions(desk).getByRole("button", { name: "Finalise & print" })).toBeEnabled();
      expect((await orderOf(pens.visit, day.tests.hba1c)).sample_status).toBe("payment_pending");
      await finalise(desk);
      await expect(actions(desk).getByText("CGHS pending")).toBeVisible();
      expect((await orderOf(pens.visit, day.tests.hba1c)).sample_status).not.toBe(
        "payment_pending",
      );
    });

    await test.step("Bill again: a second dressing waits for an admin, then goes on once", async () => {
      await pickPatient(desk, later);
      const search = addItems(desk).getByLabel("Search items");
      await search.fill(`Dressing ${tag}`);
      const results = addItems(desk).getByRole("list", { name: "Item search results" });
      await expect(results.getByRole("listitem")).toHaveCount(1);
      await results.getByRole("button", { name: "Add", exact: true }).click();
      await expect(lineRow(desk, `Dressing ${tag}`)).toHaveCount(1);
      await results.getByRole("button", { name: "Ask admin to bill again" }).click();
      await desk.getByRole("dialog").getByRole("textbox").fill(`Second wound dressed ${tag}`);
      await desk.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
      await expect(
        addItems(desk).getByText(`Asked an admin to bill Dressing ${tag} again.`),
      ).toBeVisible();

      await answerRequest(admin, `Approve billing Dressing ${tag} again`, async (dialog) => {
        await dialog.getByLabel("Note for the desk", { exact: true }).fill("Two wounds, fine");
        await dialog.getByRole("button", { name: "Approve request", exact: true }).click();
      });

      const approved = myRequests(desk)
        .getByRole("listitem")
        .filter({ hasText: `Dressing ${tag}` });
      await expect(approved.getByRole("button", { name: "Add to bill" })).toBeVisible({
        timeout: 30000,
      });
      await approved.getByRole("button", { name: "Add to bill" }).click();
      await expect(lineRow(desk, `Dressing ${tag}`)).toHaveCount(2);
      await expect(approved.getByRole("button", { name: "Add to bill" })).toHaveCount(0, {
        timeout: 30000,
      });
    });

    await test.step("New item: nothing found, requested, created by the admin with a price, added", async () => {
      const wanted = `Nebulisation ${tag}`;
      await addItems(desk).getByLabel("Search items").fill(wanted);
      await addItems(desk).getByRole("button", { name: "Request new item" }).click();
      const form = addItems(desk).getByRole("form", { name: "Request a new item" });
      await expect(form.getByLabel("Item name")).toHaveValue(wanted);
      await form.getByLabel("Group").fill(`OPD ${tag}`);
      await form.getByLabel("Why is it needed?").fill(`Given in the minor OT ${tag}`);
      await form.getByRole("button", { name: "Send request" }).click();
      await expect(addItems(desk).getByText("Asked an admin to create that item.")).toBeVisible();

      await answerRequest(admin, `Create item for ${wanted}`, async (dialog) => {
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(wanted);
        await dialog.getByLabel("Code", { exact: true }).fill(`FT-NEB-${tag}`);
        await dialog.getByLabel("Subgroup", { exact: true }).selectOption(String(day.subgroup));
        await dialog.getByLabel("Kind", { exact: true }).selectOption("procedure");
        await dialog.getByLabel("Price (₹)", { exact: true }).fill(String(PRICES.newItem));
        await dialog.getByRole("button", { name: "Create item and approve" }).click();
      });

      const approved = myRequests(desk).getByRole("listitem").filter({ hasText: wanted });
      await expect(approved.getByRole("button", { name: "Add to bill" })).toBeVisible({
        timeout: 30000,
      });
      await approved.getByRole("button", { name: "Add to bill" }).click();
      await expect(lineRow(desk, wanted)).toContainText(rupees(PRICES.newItem));
    });

    await test.step("Pay later: final with a balance, on the Dues tab, paid from there in cash", async () => {
      const owed = PRICES.rahulFollowUp + 2 * PRICES.dressing + PRICES.newItem + PRICES.hba1c;
      await expect(total(desk, "Patient payable")).toHaveText(rupees(owed));
      await pad(desk).getByLabel("Pay later").check();
      await finalise(desk);
      const bill = await billOf(later.visit, "final");
      expect(bill.paid).toBe(0);
      expect((await orderOf(later.visit, day.tests.hba1c)).sample_status).toBe("payment_pending");

      await tab(desk, "Dues").click();
      await region(desk, "Dues")
        .getByRole("button", { name: `Take payment on bill ${bill.bill_no}` })
        .click();
      await pay(desk, [{ mode: "cash", amount: owed }]);
      await tab(desk, "Dues").click();
      await expect(
        region(desk, "Dues").getByRole("row").filter({ hasText: bill.bill_no }),
      ).toHaveCount(0);
      expect((await orderOf(later.visit, day.tests.hba1c)).sample_status).not.toBe(
        "payment_pending",
      );
    });

    await test.step("Cancel: an unpaid final bill cancels with a reason; a paid one cannot", async () => {
      await pickPatient(desk, cancel);
      await pad(desk).getByLabel("Pay later").check();
      await finalise(desk);
      await actions(desk).getByRole("button", { name: "Cancel unpaid bill" }).click();
      await desk.getByRole("dialog").getByRole("textbox").fill("Patient left before paying");
      await desk.getByRole("dialog").getByRole("button", { name: "Cancel bill" }).click();
      await expect(desk.getByRole("dialog")).toHaveCount(0);
      expect((await billOf(cancel.visit)).status).toBe("cancelled");

      await pickPatient(desk, gen);
      await region(desk, "Earlier bills on this visit")
        .getByRole("button", { name: `Open bill ${day.genBill.bill_no}` })
        .click();
      await expect(region(desk, "Bill lines").getByRole("heading")).toHaveText(
        `This bill · ${day.genBill.bill_no}`,
      );
      await expect(actions(desk).getByRole("link", { name: "Print receipt" })).toBeVisible();
      await expect(actions(desk).getByRole("button", { name: "Cancel unpaid bill" })).toHaveCount(
        0,
      );

      const api = await apiAs("reception");
      const refused = await api.post(`/api/billing/bills/${day.genBill.id}/cancel`, {
        data: { reason: "Try to cancel a paid bill" },
      });
      expect(refused.status()).toBe(409);
      await api.dispose();
    });

    await test.step("End: the shift closes on the counted cash and shows the difference", async () => {
      const cash = await one(
        `SELECT COALESCE(SUM(amount), 0)::float AS cash FROM payments
          WHERE shift_id = $1 AND mode = 'cash' AND direction = 'in'`,
        [day.shiftIds[0]],
      );
      const expected = 2000 + cash.cash;
      await tab(desk, "Shift").click();
      const shift = region(desk, "Shift");
      await expect(shift.getByRole("row", { name: /Expected in the drawer/ })).toContainText(
        rupees(expected),
      );
      await shift.getByLabel("Counted cash").fill(String(expected - 50));
      await expect(shift.getByText(`Difference ${rupees(-50)}`)).toBeVisible();
      await shift.getByRole("button", { name: "Close shift" }).click();
      await desk.getByRole("button", { name: "Close the shift" }).click();
      await expect(shift.getByText(/Shift closed/)).toContainText(`difference ${rupees(-50)}`);
    });

    await deskContext.close();
    await adminContext.close();
  });
});
