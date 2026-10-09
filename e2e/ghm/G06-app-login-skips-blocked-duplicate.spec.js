import { test, expect } from "@playwright/test";
import bcrypt from "bcrypt";
import { anonymousApi } from "../helpers/auth.mjs";
import { query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const PASSWORD = "e2e-app-pass";

async function samePhonePair({ keptBlocked }) {
  const phone = `7${String(Date.now()).slice(-9)}`;
  const password_hash = await bcrypt.hash(PASSWORD, 4);
  const duplicate = await buildPatient({ phone, password_hash, is_blocked: true });
  const kept = await buildPatient({ phone, password_hash, is_blocked: keptBlocked });
  return { phone, duplicate, kept };
}

const cleanup = async ({ duplicate, kept }) => {
  const ids = [duplicate.id, kept.id];
  await query(
    `DELETE FROM refresh_tokens WHERE kind = 'patient' AND patient_ref = ANY($1::text[])`,
    [ids.map(String)],
  );
  await query(
    `DELETE FROM auth_sessions WHERE kind = 'patient' AND patient_ref = ANY($1::text[])`,
    [ids.map(String)],
  );
  await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
};

test.describe("patient app login with a blocked duplicate on the same phone", () => {
  test("signs in to the unblocked record", async () => {
    const pair = await samePhonePair({ keptBlocked: false });
    const api = await anonymousApi();
    try {
      const res = await api.post("/api/patient/auth/login", {
        data: { phone: pair.phone, password: PASSWORD },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).patient.id).toBe(pair.kept.id);
    } finally {
      await api.dispose();
      await cleanup(pair);
    }
  });

  test("still refuses when every record on the phone is blocked", async () => {
    const pair = await samePhonePair({ keptBlocked: true });
    const api = await anonymousApi();
    try {
      const res = await api.post("/api/patient/auth/login", {
        data: { phone: pair.phone, password: PASSWORD },
      });
      expect(res.status()).toBe(403);
      expect((await res.json()).code).toBe("account_blocked");
    } finally {
      await api.dispose();
      await cleanup(pair);
    }
  });
});
