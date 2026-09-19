import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import {
  AUDIT_ACTIONS,
  REDACTED,
  auditContext,
  writeAudit,
} from "../../../server/services/billing/audit.js";

const BILLING_SERVICES = path.join(repoRoot, "server", "services", "billing");
const WRITES_SQL = /\bINSERT\s+INTO\b|\bUPDATE\b[^;`]*?\bSET\b|\bDELETE\s+FROM\b/i;
const uniqueId = () => `e2e-${crypto.randomUUID()}`;

async function inTransaction(work, { commit }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const rowsFor = (entityId) =>
  query(
    `SELECT entity, entity_id, action, before, after, actor_id, ip, at IS NOT NULL AS stamped
       FROM billing_audit WHERE entity_id = $1`,
    [entityId],
  ).then((r) => r.rows);

test.describe("P1-13 audit helper", () => {
  test("1. a committed change writes one audit row with every field", async () => {
    const entityId = uniqueId();
    const actorId = USERS.reception_admin.id;
    const id = await inTransaction(
      (client) =>
        writeAudit(client, {
          entity: "service_items",
          entityId,
          action: "update",
          before: { base_price: 500, name: "Dressing" },
          after: { base_price: 600, name: "Dressing", tags: ["a"], nested: { x: 1 } },
          actorId,
          ip: "10.0.0.7",
        }),
      { commit: true },
    );
    expect(Number(id)).toBeGreaterThan(0);
    expect(await rowsFor(entityId)).toEqual([
      {
        entity: "service_items",
        entity_id: entityId,
        action: "update",
        before: { base_price: 500, name: "Dressing" },
        after: { base_price: 600, name: "Dressing", tags: ["a"], nested: { x: 1 } },
        actor_id: actorId,
        ip: "10.0.0.7",
        stamped: true,
      },
    ]);
  });

  test("2. a rolled-back transaction leaves no audit row", async () => {
    const entityId = uniqueId();
    await inTransaction(
      (client) =>
        writeAudit(client, { entity: "service_groups", entityId, action: "create", after: {} }),
      { commit: false },
    );
    expect(await rowsFor(entityId)).toEqual([]);
  });

  test("3. a failure later in the same transaction removes the audit row too", async () => {
    const entityId = uniqueId();
    await expect(
      inTransaction(
        async (client) => {
          await writeAudit(client, { entity: "tax_codes", entityId, action: "create", after: {} });
          await client.query(`INSERT INTO tax_codes (code, rate_pct) VALUES ('BAD CODE', 5)`);
        },
        { commit: true },
      ),
    ).rejects.toThrow();
    expect(await rowsFor(entityId)).toEqual([]);
  });

  test("4. it refuses to run on the pool, outside a transaction", async () => {
    await expect(
      writeAudit(getPool(), { entity: "x", entityId: "1", action: "create" }),
    ).rejects.toThrow(/transaction's client/);
    await expect(
      writeAudit(null, { entity: "x", entityId: "1", action: "create" }),
    ).rejects.toThrow(/transaction's client/);
  });

  test("5. entity, id and action are required; empty snapshots are stored as null", async () => {
    const entityId = uniqueId();
    await inTransaction(
      async (client) => {
        for (const missing of [
          { entityId: "1", action: "create" },
          { entity: "x", action: "create" },
          { entity: "x", entityId: "1" },
          { entity: "  ", entityId: "1", action: "create" },
        ]) {
          await expect(writeAudit(client, missing)).rejects.toThrow(/is required/);
        }
        await writeAudit(client, { entity: "service_items", entityId, action: "delete" });
      },
      { commit: true },
    );
    const [row] = await rowsFor(entityId);
    expect(row).toMatchObject({ before: null, after: null, actor_id: null, ip: null });
  });

  test("6. a numeric id is stored as text", async () => {
    const numeric = Date.now();
    await inTransaction(
      (client) =>
        writeAudit(client, { entity: "e2e_numeric", entityId: numeric, action: "create" }),
      { commit: true },
    );
    expect(await rowsFor(String(numeric))).toHaveLength(1);
  });

  test("7. auditContext takes the signed-in user and the request IP", () => {
    expect(auditContext({ doctor: { doctor_id: 9002 }, ip: "1.2.3.4" })).toEqual({
      actorId: 9002,
      ip: "1.2.3.4",
    });
    expect(auditContext({})).toEqual({ actorId: null, ip: null });
    expect(auditContext(undefined)).toEqual({ actorId: null, ip: null });
  });

  test("8. a connection with no open transaction is refused, and nothing is written", async () => {
    const entityId = uniqueId();
    const client = await getPool().connect();
    try {
      await expect(
        writeAudit(client, { entity: "service_items", entityId, action: "create" }),
      ).rejects.toThrow(/inside the caller's open transaction/);
    } finally {
      client.release();
    }
    expect(await rowsFor(entityId)).toEqual([]);
  });

  test("9. sensitive fields are masked in both snapshots, at any depth", async () => {
    const entityId = uniqueId();
    await inTransaction(
      (client) =>
        writeAudit(client, {
          entity: "patients",
          entityId,
          action: "update",
          before: {
            scheme_code: "cghs",
            scheme_ref: "CGHS-1234",
            Aadhaar_Number: "1234 5678 9012",
          },
          after: {
            scheme_code: "cghs",
            SCHEME_REF: "CGHS-9999",
            card_no: null,
            nested: { pin: "4321", token: "abc", keep: "yes" },
            list: [{ password: "x" }, { name: "ok" }],
          },
        }),
      { commit: true },
    );
    const [row] = await rowsFor(entityId);
    expect(row.before).toEqual({
      scheme_code: "cghs",
      scheme_ref: REDACTED,
      Aadhaar_Number: REDACTED,
    });
    expect(row.after).toEqual({
      scheme_code: "cghs",
      SCHEME_REF: REDACTED,
      card_no: null,
      nested: { pin: REDACTED, token: REDACTED, keep: "yes" },
      list: [{ password: REDACTED }, { name: "ok" }],
    });
    expect(JSON.stringify([row.before, row.after])).not.toMatch(/CGHS-1234|CGHS-9999|5678|4321/);
  });

  test("10. only the known actions are accepted", async () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(["create", "update", "delete", "deactivate", "cancel", "import"]),
    );
    await inTransaction(
      async (client) => {
        for (const bad of ["deleted", "Update", "remove"]) {
          await expect(
            writeAudit(client, { entity: "x", entityId: "1", action: bad }),
          ).rejects.toThrow(/unknown action/);
        }
      },
      { commit: false },
    );
  });

  test("11. the write-without-audit scan recognises every SQL form", () => {
    for (const sql of [
      "INSERT INTO tax_codes (code) VALUES ($1)",
      "UPDATE service_items SET base_price = $1",
      "UPDATE public.service_items SET x = 1",
      "UPDATE ${table} SET is_active = FALSE",
      "UPDATE service_items AS i SET x = 1",
      "DELETE FROM category_rules WHERE id = $1",
    ]) {
      expect(WRITES_SQL.test(sql), sql).toBe(true);
    }
    for (const text of ["SELECT * FROM x", "const update = 1; const settings = {}"]) {
      expect(WRITES_SQL.test(text), text).toBe(false);
    }
  });

  test("12. every billing service that writes to the database calls writeAudit", () => {
    const files = fs
      .readdirSync(BILLING_SERVICES)
      .filter((name) => name.endsWith(".js") && name !== "audit.js");
    const missing = files.filter((name) => {
      const source = fs.readFileSync(path.join(BILLING_SERVICES, name), "utf8");
      return WRITES_SQL.test(source) && !source.includes("writeAudit(");
    });
    expect(missing, "billing services that write without an audit row").toEqual([]);
  });
});
