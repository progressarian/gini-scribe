import { test, expect } from "@playwright/test";
import {
  ROLES,
  ROLE_CAPABILITIES,
  normalizeRole,
  hasCapability,
  CAPABILITIES,
} from "../../../shared/permissions.js";
import { apiAs, anonymousApi, userFor } from "../../helpers/auth.mjs";
import { PIN } from "../../fixtures/data.mjs";

const NEW_USER = "E2E P1-01 Reception Admin";

test.describe("P1-01 reception_admin role", () => {
  test("1. the role is known and keeps reception's access", () => {
    expect(ROLES.RECEPTION_ADMIN).toBe("reception_admin");
    expect(normalizeRole("reception_admin")).toBe("reception_admin");
    expect(normalizeRole(" Reception_Admin ")).toBe("reception_admin");
    expect(ROLE_CAPABILITIES[ROLES.RECEPTION_ADMIN]).toEqual(ROLE_CAPABILITIES[ROLES.RECEPTION]);
    expect(ROLE_CAPABILITIES[ROLES.RECEPTION_ADMIN]).not.toBe(ROLE_CAPABILITIES[ROLES.RECEPTION]);
    expect(hasCapability("reception_admin", CAPABILITIES.ADMIN)).toBe(false);
  });

  test("2. admin creates a reception_admin user who can log in", async () => {
    const admin = await apiAs("admin");
    const created = await admin.post("/api/doctors", {
      data: { name: NEW_USER, role: "reception_admin", pin: PIN },
    });
    expect(created.ok()).toBe(true);
    const doctor = await created.json();
    expect(doctor.role).toBe("reception_admin");
    await admin.dispose();

    const anon = await anonymousApi();
    const login = await anon.post("/api/auth/login", {
      data: { doctor_id: doctor.id, pin: PIN },
    });
    expect(login.ok()).toBe(true);
    const body = await login.json();
    expect(body.doctor.role).toBe("reception_admin");

    const me = await anon.get("/api/auth/me", {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    expect(me.ok()).toBe(true);
    const session = await me.json();
    expect(session.authenticated).toBe(true);
    expect(session.doctor.role).toBe("reception_admin");
    await anon.dispose();
  });

  test("3. an unknown role is refused when creating a user", async () => {
    const admin = await apiAs("admin");
    const response = await admin.post("/api/doctors", {
      data: { name: `${NEW_USER} typo`, role: "reception_admn", pin: PIN },
    });
    expect(response.status()).toBe(400);
    await admin.dispose();
  });

  test("4. a role typed in another case is saved in its canonical form", async () => {
    const admin = await apiAs("admin");
    const response = await admin.post("/api/doctors", {
      data: { name: `${NEW_USER} cased`, role: " Reception_Admin ", pin: PIN },
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).role).toBe("reception_admin");
    await admin.dispose();
  });

  test("5. reception_admin reaches reception endpoints but not admin ones", async () => {
    const api = await apiAs("reception_admin");
    expect((await api.get("/api/appointments")).status()).toBe(200);
    expect((await api.get("/api/admin/backfill-healthray-docs")).status()).toBe(403);
    await api.dispose();
  });

  test("6. reception can not create users", async () => {
    const api = await apiAs("reception");
    const response = await api.post("/api/doctors", {
      data: { name: `${NEW_USER} blocked`, role: "reception_admin", pin: PIN },
    });
    expect(response.status()).toBe(403);
    await api.dispose();
  });

  test("7. the login screen lists a Reception Admin group", async ({ page }) => {
    await page.goto("/login");
    const group = page.locator('optgroup[label="Reception Admin"]');
    await expect(group).toHaveCount(1);
    await expect(group.locator("option", { hasText: userFor("reception_admin").name })).toHaveCount(
      1,
    );
  });

  test("8. a reception_admin who logs in on the login page lands on the OPD page", async ({
    page,
  }) => {
    const user = userFor("reception_admin");
    await page.goto("/login");
    await page.locator("select.login-select").selectOption(String(user.id));
    await page.getByPlaceholder("Enter 4-digit PIN").fill(PIN);
    await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();
    await expect(page).toHaveURL(/\/opd(\?|$)/);
  });
});
