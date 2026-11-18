import pool from "../../config/db.js";
import { pharmacyVendorLabels, pharmacyVendorSchema } from "../../schemas/pharmacyVendors.js";
import { vendorRecords } from "./vendors.js";
import { applyRows, previewRows, problemRows, readSheet, sheetFile } from "./sheetImport.js";
import { asText, isoDate, nameKey } from "./sheetValues.js";

export const VENDOR_COLUMNS = [
  { field: "name", header: "Vendor name", width: 32, required: true },
  { field: "contact_person", header: "Contact person", width: 20 },
  { field: "phone", header: "Phone", width: 14 },
  { field: "alt_phone", header: "Alternate phone", width: 14 },
  { field: "email", header: "Email", width: 24 },
  { field: "address", header: "Address", width: 36 },
  { field: "city", header: "City", width: 14 },
  { field: "state", header: "State", width: 14 },
  { field: "pincode", header: "Pincode", width: 10 },
  { field: "gstin", header: "GSTIN", width: 18 },
  { field: "pan", header: "PAN", width: 12 },
  { field: "drug_license_no", header: "Drug licence number", width: 20 },
  { field: "drug_license_expiry", header: "Drug licence expiry (DD/MM/YYYY)", width: 18 },
  { field: "payment_terms_days", header: "Payment terms (days)", width: 12 },
  { field: "bank_name", header: "Bank name", width: 18 },
  { field: "bank_account", header: "Bank account number", width: 20 },
  { field: "ifsc", header: "IFSC", width: 14 },
  { field: "notes", header: "Notes", width: 30 },
];

const FIELDS = VENDOR_COLUMNS.map((c) => c.field);

function toInput(values) {
  const input = {};
  for (const f of FIELDS) {
    if (values[f] === undefined) continue;
    input[f] = f === "drug_license_expiry" ? isoDate(values[f]) : asText(values[f]);
  }
  if (input.gstin) input.gstin = input.gstin.toUpperCase();
  if (input.pan) input.pan = input.pan.toUpperCase();
  if (input.ifsc) input.ifsc = input.ifsc.toUpperCase();
  return input;
}

async function load(rawRows, db) {
  const { rows } = await db.query(`SELECT id, version, ${FIELDS.join(", ")} FROM pharmacy_vendors`);
  const byName = new Map();
  const byGstin = new Map();
  for (const v of rows) {
    const entry = { id: v.id, version: v.version, values: v, label: v.name };
    byName.set(nameKey(v.name), entry);
    if (v.gstin) byGstin.set(v.gstin.toUpperCase(), entry);
  }
  return { byName, byGstin };
}

const spec = {
  noun: "vendor",
  columns: VENDOR_COLUMNS,
  labels: pharmacyVendorLabels,
  schema: pharmacyVendorSchema,
  compare: FIELDS,
  load,
  toInput,
  problems: (input, ctx) => {
    const byGstin = input.gstin ? ctx.byGstin.get(input.gstin) : null;
    const byName = ctx.byName.get(nameKey(input.name));
    if (byGstin && byName && byGstin.id !== byName.id) {
      return [
        {
          column: "GSTIN",
          message: `This GSTIN belongs to ${byGstin.values.name}, but the name matches another vendor.`,
        },
      ];
    }
    return [];
  },
  match: (input, ctx) =>
    (input.gstin ? ctx.byGstin.get(input.gstin) : null) ?? ctx.byName.get(nameKey(input.name)),
  keyOf: (data) => nameKey(data.name),
  describe: (data) => ({ key: data.name || "—", label: data.gstin || null }),
  create: (client, r, ctx) => vendorRecords.create(r.data, ctx, client),
  update: (client, r, ctx) =>
    vendorRecords.update(
      r.current.id,
      {
        ...Object.fromEntries(FIELDS.map((f) => [f, r.current.values[f]])),
        ...Object.fromEntries(r.changes.map((c) => [c.field, r.data[c.field]])),
        version: r.current.version,
      },
      ctx,
      client,
    ),
};

const HELP = [
  "One row per vendor. A row whose GSTIN or name matches an existing vendor updates that vendor.",
  "Blank cells keep what Scribe already has. Only the cells you fill are compared and changed.",
  "Phone numbers are 10 digits. GSTIN is 15 characters. Licence expiry can be 31/12/2027 or 2027-12-31.",
  "When you upload, Scribe shows new vendors, changes to existing ones and any rows with mistakes before saving anything.",
];

export function vendorSample() {
  return sheetFile({
    sheetName: "Vendors",
    columns: VENDOR_COLUMNS,
    rows: [
      {
        name: "Sharma Medical Agencies",
        contact_person: "Rakesh Sharma",
        phone: "9876543210",
        email: "orders@example.com",
        address: "SCO 12, Phase 3B2",
        city: "Mohali",
        state: "Punjab",
        pincode: "160059",
        gstin: "03AAPFU0939F1Z5",
        drug_license_no: "PB-MOH-12345",
        drug_license_expiry: "31/03/2028",
        payment_terms_days: 30,
      },
    ],
    help: HELP,
  });
}

export async function vendorTemplate(db = pool) {
  const { rows } = await db.query(
    `SELECT ${FIELDS.join(", ")} FROM pharmacy_vendors WHERE is_active ORDER BY lower(name)`,
  );
  return sheetFile({ sheetName: "Vendors", columns: VENDOR_COLUMNS, rows, help: HELP });
}

export async function previewVendorSheet(buffer, db = pool) {
  return previewRows(spec, await readSheet(buffer, VENDOR_COLUMNS), db);
}

export async function applyVendorSheet(buffer, decisionOf, ctx, db = pool) {
  const preview = await previewVendorSheet(buffer, db);
  return { ...(await applyRows(spec, preview, decisionOf, ctx, db)), counts: preview.counts };
}

export async function vendorProblemFile(buffer, db = pool) {
  const preview = await previewVendorSheet(buffer, db);
  return sheetFile({
    sheetName: "Vendors to fix",
    columns: VENDOR_COLUMNS,
    rows: problemRows(spec, preview),
    help: HELP,
    errors: true,
  });
}
