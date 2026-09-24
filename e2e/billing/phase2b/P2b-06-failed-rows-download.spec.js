import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import {
  admin,
  cleanUp,
  db,
  newTag,
  readWorkbook,
  seed,
  sessions,
  upload,
} from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B06");
const file = (name) => `${p}-${name}.xlsx`;
const EG = `${P}-EG`;

const errorColumn = (ws) => {
  let at = null;
  ws.getRow(1).eachCell((cell, col) => {
    if (String(cell.value).toLowerCase() === "error") at = col;
  });
  return at;
};

const messages = (ws) => {
  const col = errorColumn(ws);
  const found = {};
  ws.eachRow((row, n) => {
    if (n > 1 && col && row.getCell(col).value) found[n] = row.getCell(col).value;
  });
  return found;
};

test.describe.serial("P2b-06 failed rows download", () => {
  let session = null;

  test.beforeAll(async () => {
    await cleanUp(P, p);
    await seed({ Groups: [{ group_code: EG, name: `Exist ${T}` }] }, file("base"));
    session = await upload(
      {
        Groups: [
          { group_code: `${P}-OK`, name: `Fine ${T}` },
          { group_code: `${P}-DUP`, name: `Exist ${T}` },
          { group_code: `${P}-NG`, name: `Later ${T}` },
        ],
        Subgroups: [{ subgroup_code: `${P}-S`, group_code: `${P}-DUP`, name: `Sub ${T}` }],
      },
      file("prices"),
    );
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. before commit: the admin's own workbook with each failed row's reason beside it", async () => {
    const { file: buffer, fileName } = await sessions.failedRowsFile(session.id, db);
    expect(fileName).toBe(`${p}-prices - errors.xlsx`);
    const wb = await readWorkbook(buffer);
    expect(wb.getWorksheet("Groups").getCell("A3").value).toBe(`${P}-DUP`);
    expect(messages(wb.getWorksheet("Groups"))).toEqual({
      3: `A group called "Exist ${T}" already exists (${EG}, Scribe)`,
    });
    expect(messages(wb.getWorksheet("Subgroups"))).toEqual({
      2: "Depends on Groups row 3, which failed",
    });
    const ws = wb.getWorksheet("Groups");
    const shaded = (ref) => ws.getCell(ref).fill?.fgColor?.argb ?? null;
    expect(shaded("B3")).toBe("FFFDE2E1");
    expect(shaded("B2")).toBeNull();
    expect(wb.getWorksheet("Read me")).toBeTruthy();
  });

  test("2. after commit it also lists rows that failed during the commit", async () => {
    const rows = (await sessions.listRows(session.id, { status: "ready" }, db)).rows;
    expect(rows.map((r) => r.key)).toEqual([`${P}-OK`, `${P}-NG`]);
    await query(`INSERT INTO service_groups (code, name) VALUES ($1, $2)`, [
      `${P}-SCR`,
      `Later ${T}`,
    ]);
    await sessions.commitSession(session.id, { ctx: admin }, db);
    const { file: buffer } = await sessions.failedRowsFile(session.id, db);
    const wb = await readWorkbook(buffer);
    const groups = messages(wb.getWorksheet("Groups"));
    expect(Object.keys(groups)).toEqual(["3", "4"]);
    expect(groups[4]).toBe(`A group called "Later ${T}" already exists (${P}-SCR, Scribe)`);
  });

  test("3. the file uploads again: fixed in place, its rows are ready", async () => {
    const { file: buffer } = await sessions.failedRowsFile(session.id, db);
    const wb = await readWorkbook(buffer);
    wb.getWorksheet("Groups").getCell("B3").value = `Renamed ${T}`;
    wb.getWorksheet("Groups").getCell("B4").value = `Later fixed ${T}`;
    const again = await sessions.createSession(
      Buffer.from(await wb.xlsx.writeBuffer()),
      { fileName: file("fixed"), ctx: admin },
      db,
    );
    const rows = (await sessions.listRows(again.id, {}, db)).rows;
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      [`${P}-OK`, "unchanged"],
      [`${P}-DUP`, "ready"],
      [`${P}-NG`, "ready"],
      [`${P}-S`, "ready"],
    ]);
  });

  test("4. no failed rows means no file; an abandoned session has no file either", async () => {
    const clean = await upload(
      { Groups: [{ group_code: `${P}-C`, name: `Clean ${T}` }] },
      file("clean"),
    );
    const none = await sessions.failedRowsFile(clean.id, db).catch((e) => e);
    expect([none.status, none.message]).toEqual([
      422,
      "No row in this import failed, so there is no file of failed rows",
    ]);
    const bad = await upload(
      { Groups: [{ group_code: `${P}-B`, name: `Exist ${T}` }] },
      file("abandon"),
    );
    await sessions.abandonSession(bad.id, admin, db);
    const gone = await sessions.failedRowsFile(bad.id, db).catch((e) => e);
    expect(gone.status).toBe(409);
    const unknown = await sessions
      .failedRowsFile("00000000-0000-4000-8000-000000000000", db)
      .catch((e) => e);
    expect(unknown.status).toBe(404);
  });
});
