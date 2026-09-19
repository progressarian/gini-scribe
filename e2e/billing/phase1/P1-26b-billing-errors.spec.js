import { test, expect } from "@playwright/test";
import { billingRoute } from "../../../server/routes/billingHttp.js";

const fakeResponse = () => {
  const out = { statusCode: null, body: null };
  out.status = (code) => {
    out.statusCode = code;
    return out;
  };
  out.json = (body) => {
    out.body = body;
    return out;
  };
  return out;
};

test.describe("P1-26 billing route errors", () => {
  test("1. an unexpected database error is logged in full but shown as a plain message", async () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(" "));
    try {
      const res = fakeResponse();
      await billingRoute("Billing probe", 200, async () => {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "secret_table_key"'),
          {
            code: "23505",
          },
        );
      })({}, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toMatch(
        /^Something went wrong — it has been logged \(ref [0-9a-f]{8}\)$/,
      );
      expect(JSON.stringify(res.body)).not.toMatch(/secret_table_key|23505|duplicate key/);
      expect(logged.join("\n")).toContain(res.body.ref);
      expect(logged.join("\n")).toContain("secret_table_key");
    } finally {
      console.error = original;
    }
  });

  test("2. clear 4xx messages and their details still reach the screen", async () => {
    const res = fakeResponse();
    await billingRoute("Billing probe", 200, async () => {
      throw Object.assign(new Error("Lab can't be deleted because it is still used"), {
        status: 409,
        uses: [{ table: "service_subgroups", count: 2 }],
        internal: "not sent",
      });
    })({}, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "Lab can't be deleted because it is still used",
      uses: [{ table: "service_subgroups", count: 2 }],
    });
  });

  test("3. success returns the status and the result", async () => {
    const res = fakeResponse();
    await billingRoute("Billing probe", 201, async () => ({ id: 1 }))({}, res);
    expect(res).toMatchObject({ statusCode: 201, body: { id: 1 } });
  });
});
