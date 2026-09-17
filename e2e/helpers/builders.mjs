import { one, query } from "./db.mjs";

const identifier = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name) {
  if (!identifier.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return name;
}

export async function insertRow(table, values) {
  const columns = Object.keys(values).map(assertIdentifier);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  return one(
    `INSERT INTO ${assertIdentifier(table)} (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    Object.values(values),
  );
}

let counter = 0;
export function unique(prefix = "E2E") {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export async function buildPatient(overrides = {}) {
  const tag = unique("PAT");
  return insertRow("patients", {
    name: `E2E Patient ${tag}`,
    phone: `8${String(Date.now()).slice(-9)}`,
    age: 45,
    sex: "Male",
    file_no: tag,
    health_id: `HID-${tag}`,
    ...overrides,
  });
}

export async function buildCatalogTest(overrides = {}) {
  return insertRow("giniflow_test_catalog", {
    test_name: unique("Test"),
    category: "lab",
    price: 250,
    source: "e2e_fixture",
    ...overrides,
  });
}

export async function buildScheme(overrides = {}) {
  const code = (overrides.code || unique("sch")).toLowerCase();
  return insertRow("patient_schemes", { code, label: code.toUpperCase(), ...overrides, code });
}

export async function countRows(table, where = "TRUE", params = []) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM ${assertIdentifier(table)} WHERE ${where}`,
    params,
  );
  return rows[0].n;
}
