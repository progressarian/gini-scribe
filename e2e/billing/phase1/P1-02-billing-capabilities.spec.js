import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  CAPABILITIES,
  GRANT_ALL_CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  hasCapability,
} from "../../../shared/permissions.js";
import { repoRoot } from "../../setup/testEnv.mjs";

const BILLING = [
  "BILLING_DESK",
  "BILLING_MASTER",
  "BILLING_SETTINGS",
  "BILLING_CLAIMS",
  "BILLING_REPORTS",
];
const BILLING_ROLES = ["admin", "reception_admin", "reception"];

function planMatrix() {
  const plan = fs.readFileSync(
    path.join(repoRoot, "docs", "gini-flow", "52-BILLING-PLAN.md"),
    "utf8",
  );
  const section = plan.slice(plan.indexOf("## 10. Roles and permissions"));
  const rows = section
    .split("\n")
    .filter((line) => /^\|\s*`BILLING_/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = section
    .split("\n")
    .find((line) => line.startsWith("| Capability"))
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const roles = header.slice(2);
  return Object.fromEntries(
    rows.map((cells) => [
      cells[0].replace(/`/g, ""),
      Object.fromEntries(roles.map((role, i) => [role, cells[i + 2] === "✓"])),
    ]),
  );
}

test.describe("P1-02 billing capabilities", () => {
  test("1. the five billing capabilities exist", () => {
    for (const name of BILLING) expect(CAPABILITIES[name]).toBe(name);
    expect(GRANT_ALL_CAPABILITIES).toBe(false);
  });

  test("2. the plan §10 table lists exactly these capabilities and roles", () => {
    const matrix = planMatrix();
    expect(Object.keys(matrix).sort()).toEqual([...BILLING].sort());
    for (const row of Object.values(matrix)) expect(Object.keys(row)).toEqual(BILLING_ROLES);
  });

  test("3. each role holds exactly what plan §10 grants it", () => {
    const matrix = planMatrix();
    for (const [capability, grants] of Object.entries(matrix)) {
      for (const [role, granted] of Object.entries(grants)) {
        expect(hasCapability(role, capability), `${role} → ${capability}`).toBe(granted);
      }
    }
  });

  test("4. no other role holds any billing capability", () => {
    const others = Object.keys(ROLE_CAPABILITIES).filter((role) => !BILLING_ROLES.includes(role));
    expect(others).toContain(ROLES.COORDINATOR);
    for (const role of others) {
      for (const capability of BILLING) {
        expect(hasCapability(role, capability), `${role} → ${capability}`).toBe(false);
      }
    }
  });
});
