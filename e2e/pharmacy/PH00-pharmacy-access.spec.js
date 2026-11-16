import { test, expect } from "@playwright/test";
import { apiAs, anonymousApi } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const REFUSED = 403;

const CASES = [
  [
    "/api/pharmacy/vendors",
    { pharmacy_admin: true, admin: true, pharmacy: false, reception: false },
  ],
  [
    "/api/pharmacy/medicines",
    { pharmacy_admin: true, pharmacy: true, nurse: true, reception: false, lab: false },
  ],
  ["/api/pharmacy/settings", { pharmacy_admin: true, pharmacy: false, nurse: false }],
  ["/api/pharmacy/purchases", { pharmacy_admin: true, pharmacy: false }],
  ["/api/pharmacy/adjustments", { pharmacy_admin: true, pharmacy: false }],
  ["/api/pharmacy/batches", { pharmacy: true, nurse: true, reception: false }],
  ["/api/pharmacy/bills", { pharmacy: true, pharmacy_admin: true, reception: false, nurse: false }],
  ["/api/pharmacy/credit/requests", { pharmacy: true, pharmacy_admin: true, reception: false }],
  ["/api/pharmacy/transfers", { pharmacy_admin: true, pharmacy: false, nurse: false }],
  ["/api/pharmacy/indents", { nurse: true, pharmacy_admin: true, pharmacy: false }],
  [
    "/api/pharmacy/collect",
    { reception: true, reception_admin: true, pharmacy: false, nurse: false },
  ],
  ["/api/pharmacy/reports", { pharmacy_admin: true, pharmacy: false, coordinator: false }],
];

test.describe("PH00 pharmacy module access", () => {
  for (const [path, expectations] of CASES) {
    for (const [role, allowed] of Object.entries(expectations)) {
      test(`${role} ${allowed ? "passes" : "is refused at"} ${path}`, async () => {
        const api = await apiAs(role);
        const response = await api.get(path);
        if (allowed) expect(response.status(), await response.text()).not.toBe(REFUSED);
        else expect(response.status()).toBe(REFUSED);
        await api.dispose();
      });
    }
  }

  test("an unsigned request never reaches a pharmacy endpoint", async () => {
    const api = await anonymousApi();
    for (const [path] of CASES) {
      const response = await api.get(path);
      expect(response.status(), path).toBe(REFUSED);
    }
    await api.dispose();
  });

  test("the existing stock page keeps its old access", async () => {
    const pharmacist = await apiAs("pharmacy");
    expect((await pharmacist.get("/api/pharmacy/stock/summary")).status()).toBe(200);
    await pharmacist.dispose();
    const reception = await apiAs("reception");
    expect((await reception.get("/api/pharmacy/stock/summary")).status()).toBe(REFUSED);
    await reception.dispose();
  });
});
