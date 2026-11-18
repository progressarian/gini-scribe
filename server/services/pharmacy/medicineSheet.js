import pool from "../../config/db.js";
import { medicineTypeFor } from "../../../shared/medicineTypes.js";
import { SCHEDULE_LABEL } from "../../../shared/pharmacyVocab.js";
import { pharmacyMedicineLabels, pharmacyMedicineSchema } from "../../schemas/pharmacyMedicines.js";
import { canonicalMedKey } from "../medication/normalize.js";
import { medicineRecords } from "./medicines.js";
import { applyRows, previewRows, problemRows, readSheet, sheetFile } from "./sheetImport.js";
import { asNumber, asText, nameKey } from "./sheetValues.js";

export const MEDICINE_COLUMNS = [
  { field: "code", header: "Medicine code", width: 14 },
  { field: "name", header: "Medicine name", width: 40, required: true },
  { field: "generic_name", header: "Generic name / composition", width: 36 },
  { field: "manufacturer", header: "Manufacturer", width: 24 },
  { field: "form", header: "Type", width: 12 },
  { field: "strength", header: "Strength", width: 12 },
  { field: "pack_size", header: "Units per pack", width: 12 },
  { field: "unit_label", header: "Unit", width: 10 },
  { field: "pack_label", header: "Pack", width: 10 },
  { field: "hsn_code", header: "HSN code", width: 12 },
  { field: "gst_rate_pct", header: "GST %", width: 8 },
  { field: "schedule", header: "Schedule", width: 14 },
  { field: "default_mrp", header: "MRP per pack", width: 12 },
  { field: "default_sale_rate", header: "Sale rate per pack", width: 14 },
  { field: "min_stock_units", header: "Minimum stock (units)", width: 14 },
  { field: "max_stock_units", header: "Maximum stock (units)", width: 14 },
  { field: "reorder_qty_units", header: "Reorder quantity (units)", width: 14 },
  { field: "default_rack", header: "Rack", width: 10 },
  { field: "allow_loose_sale", header: "Loose sale (Yes/No)", width: 12 },
];

const FIELDS = MEDICINE_COLUMNS.map((c) => c.field);
const COMPARE = FIELDS.filter((f) => f !== "code");
const DARPAN_COMPARE = ["generic_name", "manufacturer"];
const DARPAN_FORM = {
  SURGICAL: "SURG. ITEM",
  SOLUTION: "SOL",
  RESPULE: "RESPULES",
  PEN: "INSULIN PEN",
};
const formInName = (name) =>
  String(name ?? "")
    .split(/[\s.()/-]+/)
    .map((word) => medicineTypeFor({ form: word }) || medicineTypeFor({ name: word }))
    .find(Boolean) ?? null;
const UNIT_BY_FORM = { TAB: "tab", CAP: "cap", INJ: "vial", "INSULIN PEN": "pen", SAC: "sachet" };
const SCHEDULE_BY_TEXT = new Map(
  Object.entries(SCHEDULE_LABEL).flatMap(([key, label]) => [
    [key.toLowerCase(), key],
    [label.toLowerCase(), key],
  ]),
);

const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : v);
const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : v);

const yesNo = (v) => {
  if (v === true || v === false) return v;
  const t = lower(v);
  if (["yes", "y", "true", "1"].includes(t)) return true;
  if (["no", "n", "false", "0"].includes(t)) return false;
  return t ? v : undefined;
};

function toInput(values) {
  const input = {};
  for (const f of FIELDS) if (values[f] !== undefined) input[f] = values[f];
  for (const f of [
    "code",
    "name",
    "generic_name",
    "manufacturer",
    "strength",
    "hsn_code",
    "default_rack",
  ]) {
    if (input[f] !== undefined && input[f] !== null) input[f] = asText(input[f]);
  }
  for (const f of [
    "pack_size",
    "gst_rate_pct",
    "default_mrp",
    "default_sale_rate",
    "min_stock_units",
    "max_stock_units",
    "reorder_qty_units",
  ]) {
    if (input[f] !== undefined) input[f] = asNumber(input[f]);
  }
  if (input.form) input.form = medicineTypeFor({ form: input.form }) || upper(input.form);
  if (input.unit_label) input.unit_label = lower(input.unit_label);
  if (input.pack_label) input.pack_label = lower(input.pack_label);
  if (input.schedule)
    input.schedule = SCHEDULE_BY_TEXT.get(lower(input.schedule)) ?? input.schedule;
  if (input.allow_loose_sale !== undefined) input.allow_loose_sale = yesNo(input.allow_loose_sale);
  return input;
}

async function loadMedicines(db) {
  const { rows } = await db.query(
    `SELECT id, version, medicine_key, needs_review, ${FIELDS.join(", ")} FROM pharmacy_medicines`,
  );
  const byCode = new Map();
  const byName = new Map();
  for (const m of rows) {
    const values = { ...m };
    byCode.set(m.code, { id: m.id, version: m.version, values, label: `${m.code} · ${m.name}` });
    byName.set(nameKey(m.name), byCode.get(m.code));
  }
  return { byCode, byName };
}

const fullInput = (current) => Object.fromEntries(FIELDS.map((f) => [f, current.values[f]]));

function medicineSpec({ compare = COMPARE, needsReview = false, keyFor = null } = {}) {
  return {
    noun: "medicine",
    columns: MEDICINE_COLUMNS,
    labels: { ...pharmacyMedicineLabels, form: "Type", gst_rate_pct: "GST %" },
    schema: pharmacyMedicineSchema,
    compare,
    load: (rawRows, db) => loadMedicines(db),
    toInput,
    problems: (input, ctx) => {
      if (input.code && !ctx.byCode.has(String(input.code).toUpperCase())) {
        const named = ctx.byName.get(nameKey(input.name));
        if (named) {
          return [
            {
              column: "Medicine code",
              message: `${input.name} already has the code ${named.values.code}. Use that code or leave it blank.`,
            },
          ];
        }
      }
      if (input.code) {
        const coded = ctx.byCode.get(String(input.code).toUpperCase());
        const named = ctx.byName.get(nameKey(input.name));
        if (coded && named && coded.id !== named.id) {
          return [
            {
              column: "Medicine name",
              message: `Another medicine (${named.values.code}) already has this name.`,
            },
          ];
        }
      }
      return [];
    },
    match: (input, ctx) =>
      (input.code ? ctx.byCode.get(String(input.code).toUpperCase()) : null) ??
      ctx.byName.get(nameKey(input.name)) ??
      null,
    keyOf: (data) => nameKey(data.name),
    describe: (data) => ({
      key: data.code || data.name || "—",
      label: data.code ? data.name : null,
    }),
    create: (client, r, ctx) =>
      medicineRecords.create(
        {
          ...r.data,
          needs_review: needsReview,
          ...(keyFor ? { medicine_key: keyFor(r) } : {}),
        },
        ctx,
        client,
      ),
    update: (client, r, ctx) => {
      const changed = Object.fromEntries(r.changes.map((c) => [c.field, r.data[c.field]]));
      return medicineRecords.update(
        r.current.id,
        {
          ...fullInput(r.current),
          ...changed,
          medicine_key:
            "name" in changed ? canonicalMedKey(changed.name) : r.current.values.medicine_key,
          needs_review: r.current.values.needs_review ?? false,
          version: r.current.version,
        },
        ctx,
        client,
      );
    },
  };
}

const HELP = [
  "One row per medicine. To change a medicine, keep its Medicine code; leave the code blank for a new one.",
  "Blank cells keep what Scribe already has. Only the cells you fill are compared and changed.",
  `Type must be one of the medicine types in Scribe, e.g. TAB, CAP, INJ, SYP, CRM, SURG. ITEM, OTHER.`,
  "Unit: tab, cap, ml, g, unit, vial, amp, sachet, pen, dose. Pack: strip, bottle, box, tube, vial, pack, unit.",
  "Schedule: Not scheduled, Schedule H, Schedule H1, Schedule X or Narcotic.",
  "Rates are per pack. GST % is 0 to 28. Loose sale is Yes or No.",
  "When you upload, Scribe shows new medicines, changes to existing ones and any rows with mistakes before saving anything.",
];

export function medicineSample() {
  return sheetFile({
    sheetName: "Medicines",
    columns: MEDICINE_COLUMNS,
    rows: [
      {
        name: "Glycomet GP 2",
        generic_name: "Glimepiride 2mg + Metformin 500mg",
        manufacturer: "USV",
        form: "TAB",
        strength: "2/500 mg",
        pack_size: 15,
        unit_label: "tab",
        pack_label: "strip",
        hsn_code: "30049099",
        gst_rate_pct: 12,
        schedule: "Schedule H",
        default_mrp: 145.5,
        default_sale_rate: 140,
        min_stock_units: 150,
        default_rack: "A-3",
        allow_loose_sale: "Yes",
      },
      {
        name: "Huminsulin R 40IU",
        manufacturer: "Lilly",
        form: "INJ",
        pack_size: 1,
        unit_label: "vial",
        pack_label: "vial",
        gst_rate_pct: 5,
        schedule: "Schedule H",
        default_mrp: 180,
        allow_loose_sale: "No",
      },
    ],
    help: HELP,
  });
}

export async function medicineTemplate(db = pool) {
  const { rows } = await db.query(
    `SELECT ${FIELDS.join(", ")} FROM pharmacy_medicines WHERE is_active ORDER BY lower(name)`,
  );
  return sheetFile({
    sheetName: "Medicines",
    columns: MEDICINE_COLUMNS,
    rows: rows.map((m) => ({
      ...m,
      gst_rate_pct: m.gst_rate_pct === null ? null : Number(m.gst_rate_pct),
      default_mrp: m.default_mrp === null ? null : Number(m.default_mrp),
      default_sale_rate: m.default_sale_rate === null ? null : Number(m.default_sale_rate),
      schedule: SCHEDULE_LABEL[m.schedule] ?? m.schedule,
      allow_loose_sale: m.allow_loose_sale ? "Yes" : "No",
    })),
    help: HELP,
  });
}

async function darpanRows(db) {
  const { rows } = await db.query(
    `SELECT i.item_name, i.company, i.generic_name, i.item_type, i.category, i.unit_sale_price,
            (SELECT l.medicine_key FROM pharmacy_stock_links l
              WHERE l.item_key = i.item_key AND l.status <> 'identity'
              ORDER BY (l.status = 'confirmed') DESC, l.medicine_key
              LIMIT 1) AS link_key
       FROM pharmacy_stock_items i
      WHERE i.in_latest
      ORDER BY lower(i.item_name)`,
  );
  return rows.map((i, index) => {
    const type = String(i.item_type || i.category || "")
      .trim()
      .toUpperCase();
    const form =
      DARPAN_FORM[type] ||
      medicineTypeFor({ form: type, name: i.item_name }) ||
      formInName(i.item_name) ||
      "OTHER";
    return {
      row: index + 1,
      linkKey: i.link_key,
      values: {
        name: i.item_name?.slice(0, 200),
        generic_name: i.generic_name,
        manufacturer: i.company,
        form,
        pack_size: 1,
        unit_label: UNIT_BY_FORM[form] ?? "unit",
        pack_label: "unit",
        gst_rate_pct: 5,
        schedule: "none",
        default_sale_rate: i.unit_sale_price === null ? null : Number(i.unit_sale_price),
      },
    };
  });
}

const sheetSpec = medicineSpec();

export async function previewMedicineSheet(buffer, db = pool) {
  return previewRows(sheetSpec, await readSheet(buffer, MEDICINE_COLUMNS), db);
}

export async function applyMedicineSheet(buffer, decisionOf, ctx, db = pool) {
  const preview = await previewMedicineSheet(buffer, db);
  const result = await applyRows(sheetSpec, preview, decisionOf, ctx, db);
  return { ...result, counts: preview.counts };
}

export async function medicineProblemFile(buffer, db = pool) {
  const preview = await previewMedicineSheet(buffer, db);
  return sheetFile({
    sheetName: "Medicines to fix",
    columns: MEDICINE_COLUMNS,
    rows: problemRows(sheetSpec, preview),
    help: HELP,
    errors: true,
  });
}

async function darpanPreview(db) {
  const raw = await darpanRows(db);
  const links = new Map(raw.map((r) => [r.row, r.linkKey]));
  const spec = medicineSpec({
    compare: DARPAN_COMPARE,
    needsReview: true,
    keyFor: (r) => links.get(r.row) || canonicalMedKey(r.data.name),
  });
  return { spec, preview: await previewRows(spec, raw, db) };
}

export async function previewDarpanMedicines(db = pool) {
  return (await darpanPreview(db)).preview;
}

export async function applyDarpanMedicines(decisionOf, ctx, db = pool) {
  const { spec, preview } = await darpanPreview(db);
  const result = await applyRows(spec, preview, decisionOf, ctx, db);
  return { ...result, counts: preview.counts };
}
