import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { NETWORK_LOG, repoRoot } from "./testEnv.mjs";

const blocker = pathToFileURL(path.join(repoRoot, "e2e", "setup", "blockNetwork.mjs")).href;

function outboundCalls() {
  return fs.existsSync(NETWORK_LOG)
    ? fs.readFileSync(NETWORK_LOG, "utf8").split("\n").filter(Boolean)
    : [];
}

test.describe("PT-04 no outside calls", () => {
  test("the blocker stops and records a non-local connection", () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-net-")), "calls.log");
    const result = spawnSync(
      process.execPath,
      [
        `--import=${blocker}`,
        "--input-type=module",
        "-e",
        `try { await fetch("https://example.com/"); console.log("REACHED"); } catch (e) { console.log(e.code || e.cause?.code || e.message); }
         const net = await import("node:net");
         await new Promise((resolve) => { const s = net.connect(443, "example.com"); s.on("error", (e) => { console.log(e.code); resolve(); }); s.on("connect", () => { console.log("REACHED"); resolve(); }); });`,
      ],
      { env: { ...process.env, E2E_NETWORK_LOG: log }, encoding: "utf8" },
    );
    expect(result.stdout).not.toContain("REACHED");
    expect(result.stdout).toContain("E2E_OUTBOUND_BLOCKED");
    const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines.join("\n")).toContain("example.com");
  });

  test("a reception session makes no outbound call", async () => {
    const api = await apiAs("reception");
    const today = new Date().toISOString().slice(0, 10);

    const arrivals = await api.get(`/api/giniflow/stations/reception/arrivals?date=${today}`);
    expect(arrivals.status()).toBe(200);

    const search = await api.get(
      `/api/giniflow/stations/reception/walk-in/search?date=${today}&q=${encodeURIComponent("E2E General")}`,
    );
    expect(search.status()).toBe(200);

    const status = await api.get("/api/giniflow/stations/reception/healthray");
    expect(status.status()).toBeLessThan(500);

    const bill = await api.get(
      `/api/giniflow/stations/reception/healthray/bill?patientId=${PATIENTS.general.id}`,
    );
    expect(bill.status()).toBe(200);

    const checkIn = await api.post("/api/giniflow/stations/reception/walk-in", {
      data: { patientId: PATIENTS.general.id },
    });
    expect([200, 409]).toContain(checkIn.status());

    await api.dispose();
    expect(outboundCalls()).toEqual([]);
  });
});
