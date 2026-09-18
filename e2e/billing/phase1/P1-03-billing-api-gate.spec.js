import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { test, expect, request } from "@playwright/test";
import { apiAs, anonymousApi } from "../../helpers/auth.mjs";
import { query } from "../../helpers/db.mjs";
import { PATIENTS } from "../../fixtures/data.mjs";
import { API_URL, e2eValues } from "../../setup/testEnv.mjs";

const AREAS = {
  desk: "/api/billing/bills",
  master: "/api/billing/master/items",
  import: "/api/billing/import/upload",
  settings: "/api/billing/settings",
  claims: "/api/billing/claims/pending",
  reports: "/api/billing/reports/daily",
};

const ALLOWED = {
  admin: ["desk", "master", "import", "settings", "claims", "reports"],
  reception_admin: ["desk", "master", "import", "claims", "reports"],
  reception: ["desk"],
  coordinator: [],
  lab: [],
  banshali: [],
};

const refused = (status) => status === 401 || status === 403;

async function patientApi() {
  const jti = crypto.randomBytes(16).toString("hex");
  const patient = PATIENTS.general;
  const token = jwt.sign(
    { kind: "patient", db: "hospital", patient_id: patient.id, name: patient.name, jti },
    e2eValues().JWT_SECRET,
    { expiresIn: "10m" },
  );
  await query(
    `INSERT INTO auth_sessions (kind, patient_db, patient_ref, token, expires_at)
     VALUES ('patient', 'hospital', $1, $2, NOW() + interval '10 minutes')`,
    [String(patient.id), jti],
  );
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("P1-03 billing API gate", () => {
  for (const [role, allowed] of Object.entries(ALLOWED)) {
    test(`${role} reaches exactly its billing areas`, async () => {
      const api = await apiAs(role);
      for (const [area, path] of Object.entries(AREAS)) {
        for (const method of ["get", "post"]) {
          const status = (await api[method](path, { data: {} })).status();
          expect(refused(status), `${role} ${method.toUpperCase()} ${path} → ${status}`).toBe(
            !allowed.includes(area),
          );
        }
      }
      await api.dispose();
    });
  }

  test("a patient-app session is refused on every billing area", async () => {
    const api = await patientApi();
    const me = await api.get("/api/patient/auth/me");
    expect(me.status(), "the patient session itself is valid").toBe(200);
    const own = await api.get("/api/billing");
    expect(own.status()).toBe(403);
    for (const path of Object.values(AREAS)) {
      const response = await api.get(path);
      expect(response.status(), path).toBe(403);
      expect((await response.json()).error).toBe("Doctor account required");
    }
    await api.dispose();
  });

  test("a request with no login is refused on every billing area", async () => {
    const api = await anonymousApi();
    for (const path of [...Object.values(AREAS), "/api/billing"]) {
      expect(refused((await api.get(path)).status()), path).toBe(true);
    }
    await api.dispose();
  });

  test("a path that only starts like master is gated as the desk, not as master", async () => {
    const api = await apiAs("reception");
    const status = (await api.get("/api/billing/masterful")).status();
    expect(refused(status)).toBe(false);
    await api.dispose();
  });
});
