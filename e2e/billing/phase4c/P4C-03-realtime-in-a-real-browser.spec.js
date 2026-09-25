import crypto from "node:crypto";
import { test, expect, request } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { PIN, USERS } from "../../fixtures/data.mjs";
import { WEB_URL } from "../../setup/testEnv.mjs";
import {
  RT_API_URL,
  RT_WEB_URL,
  RT_SUPABASE_URL,
  assertLocalSupabase,
} from "../../setup/localRealtime.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const ITEM = `P4C3 Dressing ${tag}`;
const WANTED = `P4C3 Knee brace ${tag}`;
const WANTED_REASON = `Fitted at the counter ${tag}`;
const REPEAT_REASON = `Second dressing before discharge ${tag}`;
const POLLED = `P4C3 Walking stick ${tag}`;
const POLLED_REASON = `Arrived with realtime off ${tag}`;
const PATIENT = `P4C3 Patient ${tag}`;
const FILE_NO = `F4C3-${tag}`;
const POLL_MS = 15000;
const LIVE_WITHIN_MS = 5000;
const seed = {};

const note = (type, description) => {
  test.info().annotations.push({ type, description });
  console.log(`[P4C-03] ${type}: ${description}`);
};

const reachable = async (url) => {
  try {
    return (await fetch(url)).status < 500;
  } catch {
    return false;
  }
};

async function localTokens(role) {
  const context = await request.newContext({ baseURL: RT_API_URL });
  const response = await context.post("/api/auth/login", {
    data: { doctor_id: USERS[role].id, pin: PIN },
  });
  const body = await response.json();
  await context.dispose();
  expect(response.ok(), `local login as ${role}`).toBe(true);
  return body;
}

async function realtimeConfigFor(role) {
  const { access_token } = await localTokens(role);
  const context = await request.newContext({ baseURL: RT_API_URL });
  const response = await context.get("/api/giniflow/realtime-token", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const body = await response.json();
  await context.dispose();
  return body;
}

async function localLogin(page, role) {
  const body = await localTokens(role);
  await page.addInitScript(
    ([token, refreshToken]) => {
      window.localStorage.setItem("gini_auth_token", token);
      window.localStorage.setItem("gini_refresh_token", refreshToken);
    },
    [body.access_token, body.refresh_token],
  );
}

const USER_BROADCAST = 4;

function binaryBroadcast(buffer) {
  if (buffer[0] !== USER_BROADCAST) return null;
  const [topicSize, eventSize, metadataSize] = [buffer[1], buffer[2], buffer[3]];
  let offset = 5;
  const topic = buffer.subarray(offset, (offset += topicSize)).toString();
  offset += eventSize + metadataSize;
  return { topic, payload: JSON.parse(buffer.subarray(offset).toString()) };
}

function watchSocket(page) {
  const seen = { joins: new Map(), billing: [], sockets: [] };
  page.on("websocket", (ws) => {
    seen.sockets.push(ws.url());
    ws.on("framereceived", ({ payload }) => {
      if (Buffer.isBuffer(payload)) {
        const frame = binaryBroadcast(payload);
        if (frame?.payload?.kind === "billing_request")
          seen.billing.push({ at: Date.now(), ...frame });
        return;
      }
      const text = String(payload);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const topic = message.topic ?? message[2];
      const event = message.event ?? message[3];
      const body = message.payload ?? message[4];
      if (event === "phx_reply" && body?.status) seen.joins.set(topic, body.status);
      if (event === "broadcast" && text.includes("billing_request")) {
        seen.billing.push({ at: Date.now(), topic, payload: body?.payload });
      }
    });
  });
  return seen;
}

function watchFetches(page, pattern) {
  const at = [];
  page.on("response", (r) => {
    if (r.request().method() === "GET" && pattern.test(new URL(r.url()).pathname))
      at.push(Date.now());
  });
  return at;
}

const waitingRow = (page, text) =>
  page.getByRole("table", { name: "Requests waiting" }).getByRole("row").filter({ hasText: text });
const mine = (page) => page.getByRole("region", { name: "My requests" });

async function openInbox(page, base) {
  await gotoReady(page, `${base}/settings/desk-requests`, () =>
    page.getByRole("heading", { name: "Waiting for an answer" }),
  );
}

async function openCounter(page) {
  await gotoReady(page, `${RT_WEB_URL}/giniflow/station/billing?visit=${seed.visit}`, () =>
    page.getByRole("region", { name: "Add items" }),
  );
}

async function joined(seen, topic) {
  await expect.poll(() => seen.joins.get(`realtime:${topic}`), { timeout: 15000 }).toBe("ok");
}

test.describe.serial("P4C-03 realtime in a real browser", () => {
  test.beforeAll(async () => {
    const admin = await apiAs("admin");
    const post = async (path, data) => {
      const response = await admin.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), `${path} ${JSON.stringify(data)}`).toBe(201);
      return response.json();
    };
    seed.group = await post("groups", { code: `P4C3G_${T}`, name: `P4C3 Group ${tag}` });
    seed.subgroup = await post("subgroups", {
      group_id: seed.group.id,
      code: `P4C3S_${T}`,
      name: `P4C3 Procedures ${tag}`,
    });
    seed.item = await post("items", {
      code: `P4C3I_${T}`,
      name: ITEM,
      subgroup_id: seed.subgroup.id,
      base_price: 400,
      kind: "procedure",
    });
    await admin.dispose();
    seed.patient = (
      await one(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 58, 'Female') RETURNING id`,
        [PATIENT, FILE_NO],
      )
    ).id;
    seed.visit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date) RETURNING id`,
        [seed.patient],
      )
    ).id;
    seed.bill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        seed.patient,
        seed.visit,
      ])
    ).id;
    await query(
      `INSERT INTO bill_lines
         (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
          listed_actual, actual_amount, taxable, patient_payable)
       VALUES ($1, $2, 1, $3, $4, 1, 400, 400, 400, 400, 400)`,
      [seed.bill, seed.visit, seed.item.id, ITEM],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM bill_lines WHERE bill_id = $1`, [seed.bill ?? null]);
    await query(`DELETE FROM billing_requests WHERE reason LIKE $1`, [`%${tag}%`]);
    await query(`DELETE FROM bills WHERE patient_id = $1`, [seed.patient ?? null]);
    await query(`DELETE FROM giniflow_visits WHERE patient_id = $1`, [seed.patient ?? null]);
    await query(`DELETE FROM patients WHERE file_no = $1`, [FILE_NO]);
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P4C3%${T}`]);
    await query(`DELETE FROM service_subgroups WHERE code = $1`, [`P4C3S_${T}`]);
    await query(`DELETE FROM service_groups WHERE code = $1`, [`P4C3G_${T}`]);
  });

  test.describe("with a local Supabase Realtime", () => {
    test.beforeAll(async () => {
      const running =
        (await reachable(`${RT_API_URL}/api/giniflow/realtime-token`)) &&
        (await reachable(`${RT_SUPABASE_URL}/realtime/v1/api/ping`));
      const why =
        "tests 1-2 did not run: the local Supabase Realtime stack is down (node e2e/setup/localRealtime.mjs)";
      if (!running && process.env.E2E_REQUIRE_REALTIME) throw new Error(`[P4C-03] ${why}`);
      if (!running) console.warn(`[P4C-03] SKIPPED — ${why}`);
      test.skip(!running, why);
      for (const role of ["reception", "reception_admin"]) {
        const config = await realtimeConfigFor(role);
        expect(config.enabled, `realtime is configured for ${role}`).toBe(true);
        assertLocalSupabase(config.url);
      }
    });

    test("1. a request raised at the counter reaches the open inbox without a reload", async ({
      browser,
    }) => {
      const adminContext = await browser.newContext();
      const deskContext = await browser.newContext();
      const inbox = await adminContext.newPage();
      const counter = await deskContext.newPage();
      try {
        const seen = watchSocket(inbox);
        const polls = watchFetches(inbox, /\/api\/billing\/master\/requests$/);
        await localLogin(inbox, "reception_admin");
        await openInbox(inbox, RT_WEB_URL);
        await joined(seen, "giniflow:station:billing-requests");
        expect(
          seen.sockets.some((url) => url.startsWith("ws://localhost:54472/realtime/v1/")),
        ).toBe(true);
        await expect(waitingRow(inbox, WANTED)).toHaveCount(0);

        await localLogin(counter, "reception");
        await openCounter(counter);
        await counter.getByLabel("Search items").fill(WANTED);
        await counter.getByRole("button", { name: "Request new item" }).click();
        await counter.getByLabel("Why is it needed?").fill(WANTED_REASON);

        await inbox.waitForResponse((r) => /\/api\/billing\/master\/requests$/.test(r.url()));
        const lastPoll = Date.now();
        await counter.getByRole("button", { name: "Send request" }).click();
        const sent = Date.now();
        await expect(waitingRow(inbox, WANTED)).toHaveCount(1, { timeout: LIVE_WITHIN_MS });
        const shown = Date.now();

        const frame = seen.billing.find((f) => f.payload?.action === "created");
        expect(frame, "a billing_request broadcast reached the inbox's socket").toBeTruthy();
        expect(frame.topic).toBe("realtime:giniflow:station:billing-requests");
        expect(frame.payload).not.toHaveProperty("proposed_name");
        expect(polls.some((at) => at >= frame.at && at <= shown)).toBe(true);
        expect(shown - lastPoll).toBeLessThan(POLL_MS);
        note("inbox latency", `${shown - sent} ms from Send request to the row in the inbox`);
      } finally {
        await adminContext.close();
        await deskContext.close();
      }
    });

    test("2. approving in the inbox updates the counter's My requests without a reload", async ({
      browser,
    }) => {
      const adminContext = await browser.newContext();
      const deskContext = await browser.newContext();
      const inbox = await adminContext.newPage();
      const counter = await deskContext.newPage();
      try {
        const seen = watchSocket(counter);
        const polls = watchFetches(counter, /\/api\/billing\/requests\/mine$/);
        await localLogin(counter, "reception");
        await openCounter(counter);
        await counter.getByLabel("Search items").fill(ITEM);
        await counter
          .getByRole("list", { name: "Item search results" })
          .getByRole("listitem")
          .filter({ hasText: ITEM })
          .getByRole("button", { name: "Ask admin to bill again" })
          .click();
        await counter.getByLabel("Why must it be billed again?").fill(REPEAT_REASON);
        await counter.getByRole("button", { name: "Send request" }).click();
        const row = mine(counter).getByRole("listitem").filter({ hasText: ITEM });
        await expect(row.getByText("Waiting for an admin")).toBeVisible();
        await joined(seen, "giniflow:station:billing-requests");

        await localLogin(inbox, "reception_admin");
        await openInbox(inbox, RT_WEB_URL);
        await inbox.getByRole("button", { name: `Approve billing ${ITEM} again` }).click();
        await inbox
          .getByRole("dialog")
          .getByLabel("Note for the desk", { exact: true })
          .fill(`Once more ${tag}`);

        await counter.waitForResponse((r) => /\/api\/billing\/requests\/mine$/.test(r.url()));
        const lastPoll = Date.now();
        await inbox
          .getByRole("dialog")
          .getByRole("button", { name: "Approve request", exact: true })
          .click();
        const approved = Date.now();
        await expect(row.getByText("Approved")).toBeVisible({ timeout: LIVE_WITHIN_MS });
        const shown = Date.now();

        const frame = seen.billing.find((f) => f.payload?.action === "approved");
        expect(frame, "the approval reached the counter's socket").toBeTruthy();
        expect(polls.some((at) => at >= frame.at && at <= shown)).toBe(true);
        expect(shown - lastPoll).toBeLessThan(POLL_MS);
        note("counter latency", `${shown - approved} ms from Approve to "Approved" at the counter`);
      } finally {
        await adminContext.close();
        await deskContext.close();
      }
    });
  });

  test("3. with realtime unconfigured, the inbox's 15 s poll still brings a new request", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const seen = watchSocket(page);
    const tokens = [];
    page.on("response", async (r) => {
      if (r.url().includes("/api/giniflow/realtime-token")) tokens.push(await r.json());
    });
    await loginAs(page, "reception_admin");
    await openInbox(page, WEB_URL);
    await expect.poll(() => tokens.length).toBeGreaterThan(0);
    expect(tokens[0]).toEqual({ enabled: false });
    await expect(waitingRow(page, POLLED)).toHaveCount(0);

    const desk = await apiAs("reception");
    const made = await desk.post("/api/billing/requests/new-item", {
      data: { proposed_name: POLLED, reason: POLLED_REASON },
    });
    expect(made.status()).toBe(201);
    await desk.dispose();
    const sent = Date.now();

    await expect(waitingRow(page, POLLED)).toHaveCount(1, { timeout: POLL_MS + 5000 });
    expect(seen.sockets.filter((url) => url.includes("/realtime/v1/"))).toEqual([]);
    note("poll latency", `${Date.now() - sent} ms from the request to the row, by poll alone`);
  });

  test("4. with realtime unconfigured, the counter's 15 s poll still brings an approval", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const seen = watchSocket(page);
    const desk = await apiAs("reception");
    const asked = await desk.post("/api/billing/requests/new-item", {
      data: {
        proposed_name: `${POLLED} again`,
        reason: `${POLLED_REASON} at the desk`,
        visit_id: seed.visit,
        bill_id: seed.bill,
      },
    });
    expect(asked.status()).toBe(201);
    const { id } = await asked.json();
    await desk.dispose();

    await loginAs(page, "reception");
    await gotoReady(page, `${WEB_URL}/giniflow/station/billing?visit=${seed.visit}`, () =>
      page.getByRole("region", { name: "Add items" }),
    );
    const row = mine(page)
      .getByRole("listitem")
      .filter({ hasText: `${POLLED} again` });
    await expect(row.getByText("Waiting for an admin")).toBeVisible();

    const admin = await apiAs("admin");
    const decided = await admin.post(`/api/billing/master/requests/${id}/reject`, {
      data: { note: `Not stocked ${tag}` },
    });
    expect(decided.status()).toBe(200);
    await admin.dispose();
    const sent = Date.now();

    await expect(row.getByText("Rejected")).toBeVisible({ timeout: POLL_MS + 5000 });
    expect(seen.sockets.filter((url) => url.includes("/realtime/v1/"))).toEqual([]);
    note(
      "counter poll latency",
      `${Date.now() - sent} ms from the decision to the counter, by poll alone`,
    );
  });
});
