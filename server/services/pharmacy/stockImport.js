import crypto from "crypto";
import pool from "../../config/db.js";
import { writeAuditMany } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { canonicalMedKey } from "../medication/normalize.js";
import { pharmacyMedicineSchema } from "../../schemas/pharmacyMedicines.js";
import { pharmacyPurchaseLineSchema } from "../../schemas/pharmacyPurchases.js";
import { readableZodError } from "../../middleware/validate.js";
import { UNIT_BY_FORM, darpanForm } from "./medicineSheet.js";
import { createPurchase, postPurchase, updatePurchase } from "./purchases.js";
import { sheetFile } from "./sheetImport.js";
import { isoDate, nameKey } from "./sheetValues.js";
import { STOCK_IMPORT_COLUMNS, packSizeOf, readStockImport } from "./stockImportParse.js";

const BATCH = 100;
const NO_VENDOR = /opening\s*stock/i;
const LANDING_TOLERANCE = 0.01;

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const round2 = (n) => Math.round(n * 100) / 100;
const cleanName = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
const batchOf = (v) =>
  String(v ?? "")
    .toUpperCase()
    .replace(/\s+/g, "");
const fileHash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const HELP = [
  "One row per batch. Rows of the same medicine and batch are merged: quantities are added and the highest price is kept.",
  "Missing vendors and medicines are created. Vendor phone, address and GSTIN are not needed here.",
  "Units per pack accepts 10, 1*10 or 1 X 10. Blank, 0 or a weight/volume (100ML, 20GM) means 1.",
  "Expiry can be 31/12/2027, 12/2027 or Dec-2027 (taken as the last day of that month).",
  "Landing rate is not stored; Scribe works it out as purchase rate plus GST and only uses it to check the row.",
  'Rows with "Opening Stock" as the vendor are loaded without a vendor.',
  "The DARPAN Batch Wise Stock Report can be uploaded as it is.",
];

const mostCommon = (values) => {
  const counts = new Map();
  for (const v of values)
    if (v !== null && v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
};

const zodMessage = (error, labels) => readableZodError(error, labels);

const LINE_LABELS = {
  batch_no: "Batch",
  expiry_date: "Expiry",
  qty_packs: "Qty (packs)",
  purchase_rate: "Purchase rate",
  gst_rate_pct: "GST %",
  mrp: "MRP",
  sale_rate: "Sale rate",
};

function normalise({ row, values }) {
  const vendor = cleanName(values.vendor);
  const qty = values.qty_packs;
  return {
    row,
    values,
    name: cleanName(values.name).slice(0, 200),
    key: nameKey(values.name),
    batch_no: batchOf(values.batch_no),
    expiry_date: isoDate(values.expiry),
    pack_size: packSizeOf(values.pack_size),
    qty_packs: qty,
    mrp: values.mrp,
    sale_rate: values.sale_rate,
    purchase_rate: values.purchase_rate ?? 0,
    gst_rate_pct: values.gst_rate_pct ?? 0,
    landing_rate: values.landing_rate,
    hsn_code: values.hsn_code ? String(values.hsn_code).replace(/\s/g, "") : null,
    vendor: !vendor || NO_VENDOR.test(vendor) ? null : vendor.slice(0, 160),
    vendorKey: !vendor || NO_VENDOR.test(vendor) ? null : nameKey(vendor),
    manufacturer: values.manufacturer?.slice(0, 160) ?? null,
    generic_name: values.generic_name?.slice(0, 300) ?? null,
    type: values.type || values.item_type || null,
  };
}

function rowProblem(r) {
  if (r.name.length < 2) return "Medicine name must be at least 2 characters";
  if (!r.batch_no) return "Batch is empty";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.expiry_date ?? "")) return "Expiry date could not be read";
  if (r.expiry_date <= today()) return `Expired on ${r.expiry_date}`;
  if (!Number.isInteger(r.qty_packs) || r.qty_packs <= 0)
    return "Qty (packs) must be a whole number above 0";
  const parsed = pharmacyPurchaseLineSchema.safeParse({
    medicine_id: 1,
    batch_no: r.batch_no,
    expiry_date: r.expiry_date,
    qty_packs: r.qty_packs,
    purchase_rate: r.purchase_rate,
    gst_rate_pct: r.gst_rate_pct,
    mrp: r.mrp,
    sale_rate: r.sale_rate,
  });
  if (!parsed.success) return zodMessage(parsed.error, LINE_LABELS);
  return null;
}

function landingWarning(r) {
  if (r.landing_rate === null || r.landing_rate === undefined || Number.isNaN(r.landing_rate))
    return null;
  const expected = round2(r.purchase_rate * (1 + r.gst_rate_pct / 100));
  if (Math.abs(expected - r.landing_rate) <= Math.max(LANDING_TOLERANCE * expected, 0.02))
    return null;
  return {
    row: r.row,
    name: r.name,
    batch_no: r.batch_no,
    sheet: r.landing_rate,
    scribe: expected,
  };
}

async function loadExisting(db, rows) {
  const keys = [...new Set(rows.map((r) => r.key))];
  const { rows: medicines } = await db.query(
    `SELECT id, name, pack_size, is_active FROM pharmacy_medicines
      WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = ANY($1::text[])`,
    [keys],
  );
  const { rows: vendors } = await db.query(`SELECT id, name, is_active FROM pharmacy_vendors`);
  const medicineIds = medicines.map((m) => m.id);
  const { rows: batches } = medicineIds.length
    ? await db.query(
        `SELECT b.medicine_id, b.batch_no, b.expiry_date, b.mrp, b.sale_rate
           FROM pharmacy_batches b WHERE b.medicine_id = ANY($1::int[])`,
        [medicineIds],
      )
    : { rows: [] };
  return {
    medicines: new Map(medicines.map((m) => [nameKey(m.name), m])),
    vendors: new Map(vendors.map((v) => [nameKey(v.name), v])),
    batches: new Map(batches.map((b) => [`${b.medicine_id}|${b.batch_no}|${b.expiry_date}`, b])),
  };
}

function medicineDraft(group) {
  const top = group.reduce((a, b) => (b.mrp > a.mrp ? b : a));
  const form = darpanForm(mostCommon(group.map((r) => r.type?.toUpperCase())), top.name);
  const pack_size = group[0].pack_size;
  const hsn = mostCommon(
    group.map((r) => (/^[0-9]{4,8}$/.test(r.hsn_code ?? "") ? r.hsn_code : null)),
  );
  return {
    name: top.name,
    generic_name: mostCommon(group.map((r) => r.generic_name)),
    manufacturer: mostCommon(group.map((r) => r.manufacturer)),
    form,
    pack_size,
    unit_label: UNIT_BY_FORM[form] ?? "unit",
    pack_label:
      pack_size > 1 && ["TAB", "CAP"].includes(form) ? "strip" : pack_size > 1 ? "pack" : "unit",
    hsn_code: hsn,
    gst_rate_pct: mostCommon(group.map((r) => r.gst_rate_pct)) ?? 0,
    schedule: "none",
    default_mrp: top.mrp,
    default_sale_rate: top.sale_rate,
  };
}

function mergeBatch(rows) {
  const top = rows.reduce((a, b) =>
    b.mrp > a.mrp || (b.mrp === a.mrp && b.sale_rate > a.sale_rate) ? b : a,
  );
  return {
    ...top,
    rows: rows.map((r) => r.row),
    qty_packs: rows.reduce((s, r) => s + r.qty_packs, 0),
    mrp: Math.max(...rows.map((r) => r.mrp)),
    sale_rate: Math.max(...rows.map((r) => r.sale_rate)),
    purchase_rate: Math.max(...rows.map((r) => r.purchase_rate)),
    gst_rate_pct: Math.max(...rows.map((r) => r.gst_rate_pct)),
    pricesDiffer: new Set(rows.map((r) => `${r.mrp}|${r.sale_rate}|${r.purchase_rate}`)).size > 1,
  };
}

async function buildPlan(buffer, db) {
  const raw = await readStockImport(buffer);
  const all = raw.map(normalise);
  const existing = await loadExisting(db, all);
  const leftOut = [];
  const skip = (r, reason) =>
    leftOut.push({ row: r.row, name: r.name, batch_no: r.batch_no, reason, values: r.values });

  const valid = [];
  for (const r of all) {
    const problem = rowProblem(r);
    if (problem) skip(r, problem);
    else valid.push(r);
  }

  const byMedicine = new Map();
  for (const r of valid) {
    if (!byMedicine.has(r.key)) byMedicine.set(r.key, []);
    byMedicine.get(r.key).push(r);
  }

  const newMedicines = [];
  const kept = [];
  for (const [key, group] of byMedicine) {
    const found = existing.medicines.get(key);
    if (found && !found.is_active) {
      group.forEach((r) => skip(r, `${found.name} is deactivated in Scribe`));
      continue;
    }
    const packSize = found ? found.pack_size : mostCommon(group.map((r) => r.pack_size));
    const fitting = group.filter((r) => r.pack_size === packSize);
    group
      .filter((r) => r.pack_size !== packSize)
      .forEach((r) =>
        skip(
          r,
          `Units per pack is ${r.pack_size}, but other rows of this medicine${found ? " (and Scribe)" : ""} say ${packSize}`,
        ),
      );
    if (!fitting.length) continue;
    if (!found) {
      const draft = medicineDraft(fitting);
      const parsed = pharmacyMedicineSchema.safeParse(draft);
      if (!parsed.success) {
        fitting.forEach((r) =>
          skip(
            r,
            `Medicine could not be created: ${zodMessage(parsed.error, { name: "Medicine name" })}`,
          ),
        );
        continue;
      }
      newMedicines.push({
        key,
        ...parsed.data,
        medicine_key: canonicalMedKey(parsed.data.name),
        needs_review: true,
      });
    }
    kept.push(...fitting.map((r) => ({ ...r, medicine_id: found?.id ?? null })));
  }

  const byBatch = new Map();
  for (const r of kept) {
    const k = `${r.key}|${r.batch_no}|${r.expiry_date}`;
    if (!byBatch.has(k)) byBatch.set(k, []);
    byBatch.get(k).push(r);
  }

  const lines = [];
  const merged = [];
  for (const rows of byBatch.values()) {
    const line = mergeBatch(rows);
    if (line.medicine_id) {
      const stock = existing.batches.get(
        `${line.medicine_id}|${line.batch_no}|${line.expiry_date}`,
      );
      if (stock) {
        const samePrice =
          Number(stock.mrp) === line.mrp && Number(stock.sale_rate) === line.sale_rate;
        rows.forEach((r) =>
          skip(
            r,
            samePrice
              ? `Batch ${line.batch_no} is already in stock (imported before)`
              : `Batch ${line.batch_no} is already in stock at MRP ₹${stock.mrp} and sale rate ₹${stock.sale_rate}`,
          ),
        );
        continue;
      }
    }
    if (rows.length > 1) {
      merged.push({
        name: line.name,
        batch_no: line.batch_no,
        rows: rows.map((r) => ({
          row: r.row,
          qty_packs: r.qty_packs,
          mrp: r.mrp,
          sale_rate: r.sale_rate,
          purchase_rate: r.purchase_rate,
          vendor: r.vendor,
        })),
        qty_packs: line.qty_packs,
        mrp: line.mrp,
        sale_rate: line.sale_rate,
        purchase_rate: line.purchase_rate,
        pricesDiffer: line.pricesDiffer,
      });
    }
    lines.push(line);
  }

  const newVendors = new Map();
  for (const l of lines) {
    if (l.vendorKey && !existing.vendors.has(l.vendorKey) && !newVendors.has(l.vendorKey)) {
      newVendors.set(l.vendorKey, l.vendor);
    }
  }

  const warnings = valid.map(landingWarning).filter(Boolean);
  leftOut.sort((a, b) => a.row - b.row);
  const totals = lines.reduce(
    (t, l) => ({
      packs: t.packs + l.qty_packs,
      purchase: t.purchase + l.qty_packs * l.purchase_rate,
      sale: t.sale + l.qty_packs * l.sale_rate,
    }),
    { packs: 0, purchase: 0, sale: 0 },
  );

  return {
    hash: fileHash(buffer),
    rows: all.length,
    lines,
    newMedicines,
    newVendors: [...newVendors.values()],
    merged,
    leftOut,
    warnings,
    totals: { packs: totals.packs, purchase: round2(totals.purchase), sale: round2(totals.sale) },
  };
}

const summaryOf = (plan) => ({
  hash: plan.hash,
  counts: {
    rows: plan.rows,
    batches: plan.lines.length,
    medicines: plan.newMedicines.length,
    existingMedicines: new Set(plan.lines.filter((l) => l.medicine_id).map((l) => l.medicine_id))
      .size,
    vendors: plan.newVendors.length,
    merged: plan.merged.length,
    leftOut: plan.leftOut.length,
    warnings: plan.warnings.length,
  },
  totals: plan.totals,
  newVendors: plan.newVendors,
  merged: plan.merged,
  leftOut: plan.leftOut.map(({ values, ...r }) => r),
  warnings: plan.warnings,
});

export async function previewStockImport(buffer, db = pool) {
  return summaryOf(await buildPlan(buffer, db));
}

const chunks = (list, size) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

async function createVendors(names, ctx, db) {
  const created = new Map();
  for (const batch of chunks(names, BATCH)) {
    await inTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO pharmacy_vendors (name, created_by, updated_by)
         SELECT x.name, $2, $2 FROM jsonb_to_recordset($1::jsonb) AS x(name text)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [JSON.stringify(batch.map((name) => ({ name }))), ctx.actorId ?? null],
      );
      await writeAuditMany(
        client,
        rows.map((v) => ({
          entity: "pharmacy_vendors",
          entityId: v.id,
          action: "create",
          after: v,
        })),
        ctx,
      );
      rows.forEach((v) => created.set(nameKey(v.name), v.id));
    }, db);
  }
  return created;
}

const MEDICINE_FIELDS = [
  "name",
  "generic_name",
  "manufacturer",
  "form",
  "pack_size",
  "unit_label",
  "pack_label",
  "hsn_code",
  "gst_rate_pct",
  "schedule",
  "default_mrp",
  "default_sale_rate",
  "medicine_key",
  "needs_review",
];

const MEDICINE_TYPES_SQL = `name text, generic_name text, manufacturer text, form text, pack_size int,
  unit_label text, pack_label text, hsn_code text, gst_rate_pct numeric, schedule text,
  default_mrp numeric, default_sale_rate numeric, medicine_key text, needs_review boolean`;

async function createMedicines(medicines, ctx, db) {
  const created = new Map();
  for (const batch of chunks(medicines, BATCH)) {
    await inTransaction(async (client) => {
      const records = batch.map((m) =>
        Object.fromEntries(MEDICINE_FIELDS.map((f) => [f, m[f] ?? null])),
      );
      const { rows } = await client.query(
        `INSERT INTO pharmacy_medicines (${MEDICINE_FIELDS.join(", ")}, created_by, updated_by)
         SELECT ${MEDICINE_FIELDS.map((f) => `x.${f}`).join(", ")}, $2, $2
           FROM jsonb_to_recordset($1::jsonb) AS x(${MEDICINE_TYPES_SQL})
         ON CONFLICT DO NOTHING
         RETURNING id, code, name, pack_size`,
        [JSON.stringify(records), ctx.actorId ?? null],
      );
      await writeAuditMany(
        client,
        rows.map((m) => ({
          entity: "pharmacy_medicines",
          entityId: m.id,
          action: "create",
          after: m,
        })),
        ctx,
      );
      rows.forEach((m) => created.set(nameKey(m.name), m.id));
    }, db);
  }
  return created;
}

async function idsByName(db, table, keys) {
  if (!keys.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, name FROM ${table}
      WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.map((r) => [nameKey(r.name), r.id]));
}

export async function postOpeningLines(lines, notes, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const receipt = await createPurchase({ kind: "opening", notes }, ctx, client);
    const saved = await updatePurchase(
      receipt.id,
      {
        version: receipt.version,
        notes,
        lines: lines.map((l) => ({
          medicine_id: l.medicine_id,
          batch_no: l.batch_no,
          expiry_date: l.expiry_date,
          mfg_date: l.mfg_date ?? null,
          qty_packs: l.qty_packs,
          free_packs: l.free_packs ?? 0,
          purchase_rate: l.purchase_rate,
          discount_pct: l.discount_pct ?? 0,
          gst_rate_pct: l.gst_rate_pct,
          mrp: l.mrp,
          sale_rate: l.sale_rate,
          rack_no: l.rack_no ?? null,
          vendor_id: l.vendor_id ?? null,
        })),
      },
      ctx,
      client,
    );
    const posted = await postPurchase(receipt.id, { version: saved.version }, ctx, client);
    return {
      id: posted.id,
      receipt_no: posted.receipt_no,
      lines: posted.lines.length,
      net_amount: posted.net_amount,
    };
  }, db);
}

async function stockMatch(db, lines) {
  const { rows } = await db.query(
    `SELECT x.medicine_id, x.batch_no, x.expiry_date, x.qty_packs,
            coalesce(sum(s.qty_units), 0)::numeric / max(b.pack_size) AS in_scribe
       FROM jsonb_to_recordset($1::jsonb) AS x(medicine_id int, batch_no text, expiry_date date, qty_packs int)
       LEFT JOIN pharmacy_batches b
         ON b.medicine_id = x.medicine_id AND b.batch_no = x.batch_no AND b.expiry_date = x.expiry_date
       LEFT JOIN pharmacy_stock s ON s.batch_id = b.id
      GROUP BY x.medicine_id, x.batch_no, x.expiry_date, x.qty_packs`,
    [
      JSON.stringify(
        lines.map(({ medicine_id, batch_no, expiry_date, qty_packs }) => ({
          medicine_id,
          batch_no,
          expiry_date,
          qty_packs,
        })),
      ),
    ],
  );
  const names = new Map(
    lines.map((l) => [`${l.medicine_id}|${l.batch_no}|${l.expiry_date}`, l.name]),
  );
  const mismatches = rows
    .filter((r) => Number(r.in_scribe) !== r.qty_packs)
    .map((r) => ({
      name: names.get(`${r.medicine_id}|${r.batch_no}|${r.expiry_date}`),
      batch_no: r.batch_no,
      sheet: r.qty_packs,
      scribe: Number(r.in_scribe),
    }));
  return { checked: rows.length, matched: rows.length - mismatches.length, mismatches };
}

export const addOpeningStock = (line, ctx = {}, db = pool) =>
  postOpeningLines([line], "Stock added from the stock page", ctx, db);

export async function applyStockImport(buffer, { hash, fileName }, ctx = {}, db = pool) {
  if (fileHash(buffer) !== hash) {
    throw httpError(409, "The file changed after it was checked. Check it again before importing");
  }
  const plan = await buildPlan(buffer, db);
  if (!plan.lines.length) throw httpError(400, "Nothing to import: every row was left out");

  await createVendors(plan.newVendors, ctx, db);
  await createMedicines(plan.newMedicines, ctx, db);
  const vendorIds = await idsByName(db, "pharmacy_vendors", [
    ...new Set(plan.lines.map((l) => l.vendorKey).filter(Boolean)),
  ]);
  const medicineIds = await idsByName(db, "pharmacy_medicines", [
    ...new Set(plan.lines.map((l) => l.key)),
  ]);
  const lines = plan.lines.map((l) => ({
    ...l,
    medicine_id: l.medicine_id ?? medicineIds.get(l.key),
    vendor_id: l.vendorKey ? (vendorIds.get(l.vendorKey) ?? null) : null,
  }));
  const missing = lines.find((l) => !l.medicine_id);
  if (missing) throw httpError(500, `${missing.name} could not be created`);

  const parts = chunks(lines, BATCH);
  const label = cleanName(fileName || "stock sheet").slice(0, 120);
  const receipts = [];
  for (const [i, part] of parts.entries()) {
    receipts.push(
      await postOpeningLines(part, `Excel import ${label} part ${i + 1}/${parts.length}`, ctx, db),
    );
  }

  return {
    receipts,
    created: {
      vendors: plan.newVendors.length,
      medicines: plan.newMedicines.length,
      batches: lines.length,
    },
    leftOut: plan.leftOut.length,
    match: await stockMatch(db, lines),
  };
}

export async function stockImportProblemFile(buffer, db = pool) {
  const plan = await buildPlan(buffer, db);
  return sheetFile({
    sheetName: "Stock rows left out",
    columns: STOCK_IMPORT_COLUMNS,
    rows: plan.leftOut.map((r) => ({
      ...Object.fromEntries(STOCK_IMPORT_COLUMNS.map((c) => [c.field, r.values[c.field] ?? null])),
      __errors: r.reason,
    })),
    help: HELP,
    errors: true,
  });
}

export function stockImportTemplate() {
  return sheetFile({
    sheetName: "Stock",
    columns: STOCK_IMPORT_COLUMNS,
    rows: [
      {
        name: "GLYCOMET GP 2 TAB",
        hsn_code: "30049099",
        unit: 1,
        batch_no: "GT2401",
        pack_size: "1*15",
        mrp: 145.5,
        qty_packs: 20,
        vendor: "Star Pharma",
        sale_rate: 145.5,
        purchase_rate: 98.5,
        landing_rate: 103.43,
        expiry: "12/2027",
        gst_rate_pct: 5,
        manufacturer: "USV",
        type: "TAB",
        generic_name: "Glimepiride + Metformin",
      },
    ],
    help: HELP,
  });
}
