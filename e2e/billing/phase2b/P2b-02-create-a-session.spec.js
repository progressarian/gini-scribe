import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import {
  addDoctor,
  admin,
  cleanUp,
  db,
  find,
  newTag,
  recAdmin,
  rowsOf,
  seed,
  sessions,
  upload,
  workbook,
} from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B02");
const EG = `${P}-EG`;
const EG2 = `${P}-EG2`;
const ES = `${P}-ES`;
const OPD = `${P}-OPD`;
const EI = `${P}-EI`;
const CI = `${P}-CI`;
const CAT = `${p}_a`;
const CAT2 = `${p}_b`;
const DOCTOR = `Dr ${P}`;
const file = (name) => `${p}-${name}.xlsx`;

const BASE = () => ({
  Groups: [
    { group_code: EG, name: `Exist ${T}`, sort_order: 5 },
    { group_code: EG2, name: `Other ${T}` },
  ],
  Subgroups: [
    { subgroup_code: ES, group_code: EG, name: `ESub ${T}` },
    { subgroup_code: OPD, group_code: EG, name: `OPD ${T}` },
  ],
  Items: [
    { item_code: EI, name: `Dressing ${T}`, subgroup_code: ES, base_price: 500, kind: "procedure" },
    {
      item_code: CI,
      name: `Consult ${T}`,
      subgroup_code: OPD,
      base_price: 1000,
      kind: "consultation",
      doctor: DOCTOR,
      visit_type: "New",
    },
  ],
  Categories: [
    { category_code: CAT, label: `Scheme A ${T}`, payer_name: "Payer A", daily_cap: 30 },
    { category_code: CAT2, label: `Scheme B ${T}`, payer_name: "Payer B" },
  ],
  "Payment rules": [
    {
      category_code: CAT,
      rule_name: "Dressing amount",
      item_code: EI,
      patient_pays: "amount",
      patient_value: 400,
      remainder: "claim",
    },
  ],
  "Consultant fees": [
    {
      doctor: DOCTOR,
      visit_type: "New",
      category_code: CAT,
      fee: 800,
      patient_pays: "amount",
      patient_value: 200,
      remainder: "claim",
    },
  ],
});

test.describe.serial("P2b-02 create a session from an upload", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
    await addDoctor(DOCTOR);
    await seed(BASE(), file("base"));
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. new, changed, identical and bad rows give the four statuses, stored with the session", async () => {
    const session = await upload(
      {
        Groups: [
          { group_code: `${P}-NG`, name: `New ${T}` },
          { group_code: EG, name: `Exist renamed ${T}`, sort_order: 5 },
        ],
        Subgroups: [{ subgroup_code: ES, group_code: EG, name: `ESub ${T}` }],
        Items: [
          {
            item_code: `${P}-NEG`,
            name: `Negative ${T}`,
            subgroup_code: ES,
            base_price: -5,
            kind: "procedure",
          },
        ],
      },
      file("four"),
    );
    expect(session.status).toBe("open");
    expect(session.expired).toBe(false);
    expect(session.uploaded_by).toBe(admin.actorId);
    expect(new Date(session.expires_at) - new Date(session.uploaded_at)).toBe(
      sessions.SESSION_HOURS * 3600e3,
    );
    expect(session.live.status).toEqual({ ready: 1, override: 1, unchanged: 1, failed: 1 });
    expect(session.live.decision).toEqual({ pending: 1, override: 0, keep: 0 });
    expect(session.counts).toMatchObject({
      rows: 4,
      ready: 1,
      override: 1,
      unchanged: 1,
      failed: 1,
    });
    expect(session.counts.sheets.Groups).toEqual({
      ready: 1,
      override: 1,
      unchanged: 0,
      failed: 0,
    });

    const rows = await rowsOf(session.id);
    const ready = find(rows, "Groups", 2);
    expect(ready).toMatchObject({ status: "ready", decision: null, before: null, changes: null });
    expect(ready.row_key).toBe(`${P}-NG`);
    expect(ready.label).toBe(`New ${T}`);
    const changed = find(rows, "Groups", 3);
    expect(changed).toMatchObject({ status: "override", decision: "pending", reason: null });
    expect(changed.before).toEqual({ name: `Exist ${T}`, sort_order: 5, active: true });
    expect(changed.changes).toEqual([
      { column: "name", from: `Exist ${T}`, to: `Exist renamed ${T}` },
    ]);
    expect(find(rows, "Subgroups", 2)).toMatchObject({ status: "unchanged", decision: null });
    const bad = find(rows, "Items", 2);
    expect(bad.status).toBe("failed");
    expect(bad.reason).toMatch(/base_price/);
    expect(bad.errors[0].column).toBe("base_price");

    const { rows: stored } = await query(
      `SELECT octet_length(file) > 0 AS has_file, file_name FROM billing_import_sessions WHERE id = $1`,
      [session.id],
    );
    expect(stored[0]).toEqual({ has_file: true, file_name: file("four") });
    const { rows: audit } = await query(
      `SELECT action, actor_id, after FROM billing_audit
        WHERE entity = 'billing_import_sessions' AND entity_id = $1`,
      [session.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "create", actor_id: admin.actorId });
    expect(audit[0].after.file_name).toBe(file("four"));
  });

  test("2. any difference on an existing row needs an override, not just money", async () => {
    const session = await upload(
      {
        Items: [
          {
            item_code: EI,
            name: `Dressing ${T}`,
            subgroup_code: ES,
            base_price: 500,
            unit: "per dressing",
            kind: "procedure",
          },
        ],
        Categories: [
          { category_code: CAT, label: `Scheme A ${T}`, payer_name: "Payer A", daily_cap: 40 },
          {
            category_code: CAT2,
            label: `Scheme B ${T}`,
            payer_name: "Payer B",
            active: "no",
          },
        ],
      },
      file("any"),
    );
    const rows = await rowsOf(session.id);
    expect(rows.map((r) => [r.sheet, r.status])).toEqual([
      ["Categories", "override"],
      ["Categories", "override"],
      ["Items", "override"],
    ]);
    expect(find(rows, "Items", 2).changes).toEqual([
      { column: "unit", from: "each", to: "per dressing" },
    ]);
    expect(find(rows, "Categories", 2).changes).toEqual([
      { column: "daily_cap", from: 30, to: 40 },
    ]);
    expect(find(rows, "Categories", 3).changes).toEqual([
      { column: "active", from: true, to: false },
    ]);
  });

  test("3. a failed new group fails its new subgroups, items, rates and rules, naming the row", async () => {
    const BG = `${P}-BG`;
    const BS = `${P}-BS`;
    const BI = `${P}-BI`;
    const session = await upload(
      {
        Groups: [
          { group_code: BG, name: `Exist ${T}` },
          { group_code: `${P}-OK`, name: `Fine ${T}` },
        ],
        Subgroups: [
          { subgroup_code: BS, group_code: BG, name: `Bad sub ${T}` },
          { subgroup_code: `${P}-OS`, group_code: `${P}-OK`, name: `Fine sub ${T}` },
        ],
        Items: [
          {
            item_code: BI,
            name: `Bad item ${T}`,
            subgroup_code: BS,
            base_price: 50,
            kind: "other",
          },
          {
            item_code: `${P}-OI`,
            name: `Fine item ${T}`,
            subgroup_code: `${P}-OS`,
            base_price: 50,
            kind: "other",
          },
        ],
        "Category rates": [
          { category_code: CAT, item_code: BI, valid_from: "2026-04-01", rate: 40 },
          { category_code: CAT, item_code: `${P}-OI`, valid_from: "2026-04-01", rate: 40 },
        ],
        "Payment rules": [
          {
            category_code: CAT2,
            rule_name: "On the bad item",
            item_code: BI,
            patient_pays: "full",
            remainder: "claim",
          },
        ],
        Discounts: [{ rule_name: `${P} disc`, method: "auto", kind: "flat", value: 5, groups: BG }],
      },
      file("cascade"),
    );
    const rows = await rowsOf(session.id);
    const at = (sheet, row) => find(rows, sheet, row);
    expect(at("Groups", 2).reason).toMatch(/A group called "Exist .*" already exists/);
    expect(at("Groups", 3).status).toBe("ready");
    const chain = [
      ["Subgroups", 2, "Groups", 2],
      ["Items", 2, "Subgroups", 2],
      ["Category rates", 2, "Items", 2],
      ["Payment rules", 2, "Items", 2],
      ["Discounts", 2, "Groups", 2],
    ];
    for (const [sheet, row, parentSheet, parentRow] of chain) {
      const child = at(sheet, row);
      expect(child.status, `${sheet} row ${row}`).toBe("failed");
      expect(child.reason).toBe(`Depends on ${parentSheet} row ${parentRow}, which failed`);
      expect(child.depends_on).toBe(at(parentSheet, parentRow).id);
    }
    for (const [sheet, row] of [
      ["Subgroups", 3],
      ["Items", 3],
      ["Category rates", 3],
    ]) {
      expect(at(sheet, row).status, `${sheet} row ${row}`).toBe("ready");
    }
  });

  test("4. an existing row that fails does not fail the rows under it — it still exists", async () => {
    const session = await upload(
      {
        Groups: [{ group_code: EG, name: `Other ${T}` }],
        Subgroups: [{ subgroup_code: `${P}-KS`, group_code: EG, name: `Kid ${T}` }],
      },
      file("existing"),
    );
    const rows = await rowsOf(session.id);
    expect(find(rows, "Groups", 2).status).toBe("failed");
    expect(find(rows, "Subgroups", 2)).toMatchObject({ status: "ready", depends_on: null });
  });

  test("5. contradictions are Failed, never Needs override", async () => {
    const session = await upload(
      {
        Items: [
          {
            item_code: EI,
            name: `Dressing ${T}`,
            subgroup_code: ES,
            base_price: 300,
            kind: "procedure",
          },
        ],
        "Payment rules": [
          {
            category_code: CAT2,
            rule_name: "Too much",
            item_code: EI,
            patient_pays: "amount",
            patient_value: 900,
            remainder: "claim",
          },
        ],
        "Category rates": [
          { category_code: CAT, item_code: `${P}-NOPE`, valid_from: "2026-04-01", rate: 10 },
        ],
      },
      file("contradictions"),
    );
    const rows = await rowsOf(session.id);
    const price = find(rows, "Items", 2);
    expect(price.status).toBe("failed");
    expect(price.decision).toBeNull();
    expect(price.reason).toContain("is below the ₹400 the payment rule");
    expect(price.changes).toEqual([{ column: "base_price", from: 500, to: 300 }]);
    const rule = find(rows, "Payment rules", 2);
    expect(rule.status).toBe("failed");
    expect(rule.reason).toMatch(/can't pay ₹900/);
    expect(find(rows, "Category rates", 2).reason).toMatch(/There is no item .*NOPE/);
  });

  test("6. only an admin may change a daily cap: the row fails for reception_admin", async () => {
    const sheets = {
      Categories: [
        { category_code: CAT, label: `Scheme A ${T}`, payer_name: "Payer A", daily_cap: 50 },
      ],
    };
    const mine = await upload(sheets, file("cap-rec"), recAdmin);
    const [row] = await rowsOf(mine.id);
    expect(row.status).toBe("failed");
    expect(row.reason).toBe(
      "Only an admin can change a category's patients-per-day limit (it is 30 now)",
    );
    const theirs = await upload(sheets, file("cap-admin"), admin);
    expect((await rowsOf(theirs.id))[0].status).toBe("override");
  });

  test("7. a consultant fee row is one row with one decision, covering its rate and its rule", async () => {
    const session = await upload(
      {
        "Consultant fees": [
          {
            doctor: DOCTOR,
            visit_type: "New",
            category_code: CAT,
            fee: 900,
            patient_pays: "amount",
            patient_value: 250,
            remainder: "claim",
          },
          {
            doctor: DOCTOR,
            visit_type: "New",
            category_code: CAT2,
            fee: 700,
            patient_pays: "full",
            remainder: "claim",
          },
        ],
      },
      file("fees"),
    );
    const rows = await rowsOf(session.id);
    const changed = find(rows, "Consultant fees", 2);
    expect(changed.status).toBe("override");
    expect(changed.row_key).toBe(`${DOCTOR} · New · ${CAT}`);
    expect(changed.changes.map((c) => c.column).sort()).toEqual(["fee", "patient_value"]);
    expect(changed.before).toEqual([
      expect.objectContaining({
        visit_type: "New",
        fee: 800,
        patient_pays: "amount",
        patient_value: 200,
        remainder: "claim",
      }),
    ]);
    expect(find(rows, "Consultant fees", 3)).toMatchObject({ status: "ready", before: null });
  });

  test("8. a file that can't be read row by row is refused with its problems and makes no session", async () => {
    const before = (await query(`SELECT count(*)::int AS n FROM billing_import_sessions`)).rows[0]
      .n;
    const empty = await workbook({});
    const refusal = await sessions
      .createSession(empty, { fileName: file("empty"), ctx: admin }, db)
      .catch((e) => e);
    expect(refusal.status).toBe(422);
    expect(refusal.problems).toEqual(["The file has no rows to import"]);
    const junk = await sessions
      .createSession(Buffer.from("not a workbook"), { fileName: file("junk"), ctx: admin }, db)
      .catch((e) => e);
    expect(junk.status).toBe(422);
    expect(junk.problems[0]).toMatch(/isn't an Excel .xlsx file/);
    const good = await workbook({ Groups: [{ group_code: `${P}-X`, name: `X ${T}` }] });
    const noName = await sessions
      .createSession(good, { fileName: " ", ctx: admin }, db)
      .catch((e) => e);
    expect([noName.status, noName.message]).toEqual([400, "The file needs a name"]);
    const noActor = await sessions
      .createSession(good, { fileName: file("x"), ctx: {} }, db)
      .catch((e) => e);
    expect([noActor.status, noActor.message]).toEqual([400, "An import must name who imported it"]);
    const after = (await query(`SELECT count(*)::int AS n FROM billing_import_sessions`)).rows[0].n;
    expect(after).toBe(before);
  });

  test("9. creating a session saves nothing to the master data", async () => {
    const session = await upload(
      { Groups: [{ group_code: `${P}-ONLY`, name: `Only in session ${T}` }] },
      file("nothing"),
    );
    expect(session.live.status.ready).toBe(1);
    const { rows } = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`${P}-ONLY`]);
    expect(rows).toHaveLength(0);
  });
});
