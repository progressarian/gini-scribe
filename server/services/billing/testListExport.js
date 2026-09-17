import ExcelJS from "exceljs";
import { machineForTest } from "../../../shared/machineStages.js";

export const TEST_LIST_COLUMNS = [
  { header: "test_name", key: "test_name", width: 36 },
  { header: "category", key: "category", width: 12 },
  { header: "current_price", key: "current_price", width: 14 },
  { header: "suggested_group", key: "suggested_group", width: 16 },
  { header: "found_in", key: "found_in", width: 34 },
  { header: "possibly_same_as", key: "possibly_same_as", width: 30 },
  { header: "note", key: "note", width: 48 },
];

const STATION_GROUP = { machine_room: "Machine", echo: "ECHO", xray: "X-ray" };
const CATEGORY_GROUP = {
  lab: "Lab",
  machine: "Machine",
  echo: "ECHO",
  xray: "X-ray",
  offsite: "Offsite",
};
const GROUP_ORDER = ["Lab", "Machine", "ECHO", "X-ray", "Offsite"];

const WORD_ALIASES = { vitamin: "vit" };

const words = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => WORD_ALIASES[w] ?? w);

const EXTRA_WORDS = /\b(with|plus|and)\b|\+/i;

const addsMoreThanItsBrackets = (name) => {
  const text = String(name ?? "");
  const afterLastBracket = text.slice(text.lastIndexOf(")") + 1);
  return /[a-z0-9]/i.test(afterLastBracket) || EXTRA_WORDS.test(text);
};

const bracketed = (name) =>
  addsMoreThanItsBrackets(name)
    ? []
    : [...String(name ?? "").matchAll(/\(([^)]+)\)/g)].map((m) => normalizeTestName(m[1]));

const wordKey = (name) => [...words(name)].sort().join(" ");

export function looksLikeSameTest(a, b) {
  if (normalizeTestName(a) === normalizeTestName(b)) return false;
  const na = normalizeTestName(a);
  const nb = normalizeTestName(b);
  if (bracketed(a).includes(nb) || bracketed(b).includes(na)) return true;
  const ka = wordKey(a);
  return ka.length > 0 && ka === wordKey(b);
}

export const normalizeTestName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

function suggestedGroup(category, name, machines) {
  if (category !== "lab") {
    const machine = machineForTest(machines, name);
    if (machine) return STATION_GROUP[machine.station] ?? "Machine";
  }
  return CATEGORY_GROUP[category] ?? "Lab";
}

async function readSources(db) {
  const catalog = await db.query(
    `SELECT test_name, category, price, source, is_active
       FROM giniflow_test_catalog
      ORDER BY is_active DESC, test_name`,
  );
  const reports = await db.query(
    `SELECT name, COALESCE(aliases, '{}') AS aliases
       FROM lab_report_catalog
      WHERE is_active
      ORDER BY name`,
  );
  const { getMachines } = await import("../giniflow/machineCatalog.js");
  const machines = await getMachines(db);
  return { catalog: catalog.rows, reports: reports.rows, machines };
}

const money = (price) => (price == null ? "" : ` (₹${Number(price)})`);

export function mergeTestList({ catalog, reports, machines }) {
  const byKey = new Map();
  const retired = new Map();

  for (const row of catalog) {
    const key = normalizeTestName(row.test_name);
    if (!key) continue;
    if (row.is_active === false) {
      if (!retired.has(key)) retired.set(key, row.test_name);
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.notes.push(
        `Also listed as "${row.test_name}"${money(row.price)} — keep one of the two`,
      );
      continue;
    }
    const placeholder = row.source === "prototype_placeholder";
    byKey.set(key, {
      test_name: row.test_name,
      category: row.category,
      current_price: row.price == null ? null : Number(row.price),
      suggested_group: suggestedGroup(row.category, row.test_name, machines),
      found_in: ["test catalogue"],
      notes: placeholder ? ["Current price is a placeholder — enter the real price"] : [],
    });
  }

  for (const report of reports) {
    const keys = [report.name, ...(report.aliases || [])].map(normalizeTestName);
    const existing = keys.map((k) => byKey.get(k)).find(Boolean);
    if (existing) {
      if (!existing.found_in.includes("lab report catalogue")) {
        existing.found_in.push("lab report catalogue");
      }
      continue;
    }
    const key = normalizeTestName(report.name);
    if (!key) continue;
    const retiredName = keys.map((k) => retired.get(k)).find(Boolean);
    byKey.set(key, {
      test_name: report.name,
      category: "lab",
      current_price: null,
      suggested_group: "Lab",
      found_in: retiredName
        ? ["lab report catalogue", "retired in test catalogue"]
        : ["lab report catalogue"],
      notes: retiredName
        ? [`"${retiredName}" was retired in the test catalogue — check before pricing`]
        : ["No price yet — enter the price"],
    });
  }

  const all = [...byKey.values()];
  for (const row of all) {
    row.possibly_same_as = all
      .filter((other) => other !== row && looksLikeSameTest(row.test_name, other.test_name))
      .map((other) => other.test_name)
      .join(", ");
  }

  return all
    .map(({ notes, ...row }) => ({
      ...row,
      found_in: row.found_in.join(", "),
      note: notes.join(" · "),
    }))
    .sort(
      (a, b) =>
        GROUP_ORDER.indexOf(a.suggested_group) - GROUP_ORDER.indexOf(b.suggested_group) ||
        a.test_name.localeCompare(b.test_name, "en", { sensitivity: "base" }),
    );
}

export async function collectTestList(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const sources = await readSources(client);
    await client.query("COMMIT");
    return mergeTestList(sources);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const lastColumnLetter = () => String.fromCharCode(64 + TEST_LIST_COLUMNS.length);

export async function writeTestList(rows, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  const ws = workbook.addWorksheet("Tests to price", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = TEST_LIST_COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = {
    from: "A1",
    to: `${lastColumnLetter()}${Math.max(rows.length, 1) + 1}`,
  };
  for (const row of rows) ws.addRow(row);
  ws.getColumn("current_price").numFmt = "0.00";
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
