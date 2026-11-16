import { test, expect } from "@playwright/test";
import {
  CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  hasCapability,
  normalizeRole,
} from "../../../shared/permissions.js";
import { STAFF_ROLE_LABELS } from "../../../shared/staffRoles.js";
import { apiAs, anonymousApi, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { PIN } from "../../fixtures/data.mjs";

const BILL = "00000000-0000-0000-0000-000000000000";

test.describe("AU-01 auditor role and access", () => {
  test("1. the role is known, labelled, and holds only the audit capability", () => {
    expect(ROLES.AUDITOR).toBe("auditor");
    expect(normalizeRole(" Auditor ")).toBe("auditor");
    expect(STAFF_ROLE_LABELS.auditor).toBe("Auditor");
    expect(ROLE_CAPABILITIES[ROLES.AUDITOR]).toEqual([CAPABILITIES.BILLING_AUDIT]);
    expect(hasCapability("auditor", CAPABILITIES.BILLING_DESK)).toBe(false);
    expect(hasCapability("reception_admin", CAPABILITIES.BILLING_AUDIT)).toBe(true);
    expect(hasCapability("admin", CAPABILITIES.BILLING_AUDIT)).toBe(true);
    expect(hasCapability("reception", CAPABILITIES.BILLING_AUDIT)).toBe(false);
  });

  test("2. admin creates an auditor who can log in", async () => {
    const admin = await apiAs("admin");
    const created = await admin.post("/api/doctors", {
      data: { name: `E2E AU-01 Auditor ${Date.now()}`, role: "auditor", pin: PIN },
    });
    expect(created.ok()).toBe(true);
    const doctor = await created.json();
    expect(doctor.role).toBe("auditor");
    await admin.dispose();

    const anon = await anonymousApi();
    const login = await anon.post("/api/auth/login", { data: { doctor_id: doctor.id, pin: PIN } });
    expect(login.ok()).toBe(true);
    expect((await login.json()).doctor.role).toBe("auditor");
    await anon.dispose();
  });

  test("3. the auditor reaches the audit report and nothing else", async () => {
    const api = await apiAs("auditor");
    expect((await api.get("/api/billing/audit/bills")).status()).toBe(200);
    expect((await api.get("/api/billing/audit/items")).status()).toBe(200);
    const refused = [
      `/api/billing/bills/${BILL}`,
      `/api/billing/bills/${BILL}/bill.pdf`,
      "/api/billing/master/items",
      "/api/billing/reports",
      "/api/billing/dues-register",
      "/api/billing/claims/pending",
      "/api/billing/dashboard",
      "/api/patients/1",
      "/api/appointments",
    ];
    for (const path of refused) {
      expect((await api.get(path)).status(), path).toBe(403);
    }
    const writes = [
      api.post(`/api/billing/bills/${BILL}/finalise`, { data: {} }),
      api.post(`/api/billing/bills/${BILL}/cancel`, { data: { reason: "x" } }),
      api.post(`/api/billing/bills/${BILL}/payments`, { data: {} }),
      api.post("/api/billing/audit/bills", { data: {} }),
    ];
    for (const response of await Promise.all(writes)) {
      expect([403, 404]).toContain(response.status());
    }
    await api.dispose();
  });

  test("4. admin and reception admin can use the report; reception can not", async () => {
    for (const [role, status] of [
      ["admin", 200],
      ["reception_admin", 200],
      ["reception", 403],
      ["lab", 403],
    ]) {
      const api = await apiAs(role);
      expect((await api.get("/api/billing/audit/bills")).status(), role).toBe(status);
      await api.dispose();
    }
  });

  test("5. the auditor lands on the audit page and the menu offers nothing else", async ({
    page,
  }) => {
    await loginAs(page, "auditor");
    await gotoReady(page, "/", () => page.getByRole("heading", { name: "Billing audit" }));
    await expect(page).toHaveURL(/\/billing\/audit/);
    await expect(page.getByRole("tab", { name: "Bills" })).toHaveAttribute("aria-selected", "true");
    await page.goto("/billing/dues");
    await expect(page).not.toHaveURL(/\/billing\/dues/);
    await page.goto("/giniflow/station/billing");
    await expect(page).not.toHaveURL(/\/giniflow\/station\/billing/);
  });
});
