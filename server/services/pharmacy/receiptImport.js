import pool from "../../config/db.js";
import { httpError } from "../billing/transaction.js";
import { pharmacyPurchaseLineSchema } from "../../schemas/pharmacyPurchases.js";
import { getPurchase, updatePurchase } from "./purchases.js";
import { applyRows, previewRows, problemRows, readSheet, sheetFile } from "./sheetImport.js";
import { asNumber, asText, isoDate, nameKey } from "./sheetValues.js";

export const MAX_RECEIPT_UPLOAD_BYTES = 5 * 1024 * 1024;

const COLUMNS = [
  { field: "code", header: "Medicine code", width: 14, required: true },
  { field: "name", header: "Medicine name", width: 40 },
  { field: "pack", header: "Pack", width: 16 },
  { field: "batch_no", header: "Batch", width: 14, required: true },
  {
    field: "expiry_date",
    header: "Expiry (DD/MM/YYYY or MM/YYYY)",
    aliases: ["Expiry", "Expiry date"],
    width: 18,
    required: true,
  },
  { field: "mfg_date", header: "MFG date", width: 14 },
  { field: "qty_packs", header: "Qty (packs)", width: 12, required: true },
  { field: "free_packs", header: "Free (packs)", width: 12 },
  { field: "purchase_rate", header: "Purchase rate per pack", width: 14 },
  { field: "discount_pct", header: "Discount %", width: 11 },
  { field: "gst_rate_pct", header: "GST %", width: 8 },
  { field: "mrp", header: "MRP per pack", width: 12, required: true },
  { field: "sale_rate", header: "Sale rate per pack", width: 14, required: true },
  { field: "rack_no", header: "Rack", width: 10 },
];

const LINE_FIELDS = [
  "batch_no",
  "expiry_date",
  "mfg_date",
  "qty_packs",
  "free_packs",
  "purchase_rate",
  "discount_pct",
  "gst_rate_pct",
  "mrp",
  "sale_rate",
  "rack_no",
];

const LABELS = {
  medicine_id: "Medicine",
  batch_no: "Batch",
  expiry_date: "Expiry",
  mfg_date: "MFG date",
  qty_packs: "Qty (packs)",
  free_packs: "Free (packs)",
  purchase_rate: "Purchase rate",
  discount_pct: "Discount %",
  gst_rate_pct: "GST %",
  mrp: "MRP",
  sale_rate: "Sale rate",
  rack_no: "Rack",
};

const HELP = [
  "One row per batch. Copy a medicine's row if you hold more than one batch of it.",
  "Leave Batch and Qty empty on medicines you do not stock; those rows are skipped.",
  "Quantities and rates are per pack, as on the vendor invoice. Free packs cost nothing.",
  "Expiry can be 31/12/2027, 2027-12-31 or 12/2027 (taken as the last day of that month).",
  "Medicine code finds the medicine. If it is blank, the exact medicine name is used instead.",
  "If a batch is already on the receipt, you choose to keep it, use the sheet, or add the quantities together.",
];

export function receiptSample() {
  return sheetFile({
    sheetName: "Stock",
    columns: COLUMNS,
    rows: [
      {
        code: "MED000001",
        name: "Glycomet GP 2",
        pack: "strip of 15 tab",
        batch_no: "GT2401",
        expiry_date: "31/12/2027",
        mfg_date: "01/01/2025",
        qty_packs: 20,
        free_packs: 2,
        purchase_rate: 98.5,
        discount_pct: 0,
        gst_rate_pct: 12,
        mrp: 145.5,
        sale_rate: 140,
        rack_no: "A-3",
      },
      {
        code: "",
        name: "Huminsulin R 40IU",
        pack: "vial of 1 vial",
        batch_no: "HR9921",
        expiry_date: "06/2027",
        qty_packs: 5,
        purchase_rate: 150,
        gst_rate_pct: 5,
        mrp: 180,
        sale_rate: 180,
      },
    ],
    help: HELP,
  });
}

export async function receiptTemplate(db = pool) {
  const { rows } = await db.query(
    `SELECT code, name, pack_label, pack_size, unit_label, gst_rate_pct, default_mrp,
            default_sale_rate, default_rack
       FROM pharmacy_medicines WHERE is_active ORDER BY lower(name)`,
  );
  return sheetFile({
    sheetName: "Stock",
    columns: COLUMNS,
    help: HELP,
    rows: rows.map((m) => ({
      code: m.code,
      name: m.name,
      pack: `${m.pack_label} of ${m.pack_size} ${m.unit_label}`,
      gst_rate_pct: Number(m.gst_rate_pct),
      mrp: m.default_mrp === null ? null : Number(m.default_mrp),
      sale_rate: m.default_sale_rate === null ? null : Number(m.default_sale_rate),
      rack_no: m.default_rack,
      free_packs: 0,
      discount_pct: 0,
    })),
  });
}

const lineKey = (l) => `${l.medicine_id}|${String(l.batch_no).toUpperCase()}|${l.expiry_date}`;
const money = (v) => (v === null || v === undefined ? null : Number(v));
const rupee = (v) => `₹${Number(v).toFixed(2)}`;

const lineOf = (l) => ({
  medicine_id: l.medicine_id,
  batch_no: l.batch_no,
  expiry_date: l.expiry_date,
  mfg_date: l.mfg_date,
  qty_packs: l.qty_packs,
  free_packs: l.free_packs,
  purchase_rate: Number(l.purchase_rate),
  discount_pct: Number(l.discount_pct),
  gst_rate_pct: Number(l.gst_rate_pct),
  mrp: Number(l.mrp),
  sale_rate: Number(l.sale_rate),
  rack_no: l.rack_no,
});

function toInput(values, ctx) {
  const code = asText(values.code)?.toUpperCase() || null;
  const medicine = code ? ctx.byCode.get(code) : ctx.byName.get(nameKey(values.name));
  const input = { medicine_id: medicine?.id ?? null };
  for (const f of LINE_FIELDS) {
    if (values[f] === undefined) continue;
    input[f] = ["expiry_date", "mfg_date"].includes(f)
      ? isoDate(values[f])
      : ["batch_no", "rack_no"].includes(f)
        ? asText(values[f])
        : asNumber(values[f]);
  }
  return { ...input, __code: code, __name: asText(values.name) ?? null, __medicine: medicine };
}

const strip = ({ __code, __name, __medicine, ...input }) => input;

function receiptSpec(purchase) {
  return {
    noun: "batch",
    columns: COLUMNS,
    labels: LABELS,
    schema: { safeParse: (input) => pharmacyPurchaseLineSchema.safeParse(strip(input)) },
    compare: LINE_FIELDS.filter((f) => f !== "batch_no" && f !== "expiry_date"),
    add: true,
    defaults: { free_packs: 0, purchase_rate: 0, discount_pct: 0, gst_rate_pct: 0 },
    load: async (rawRows, db) => {
      const { rows: medicines } = await db.query(
        `SELECT id, code, name, is_active FROM pharmacy_medicines`,
      );
      const byCode = new Map(medicines.map((m) => [m.code, m]));
      const byName = new Map(medicines.map((m) => [nameKey(m.name), m]));
      const lines = purchase.lines.map(lineOf);
      const onReceipt = new Map(
        purchase.lines.map((l, i) => [lineKey(l), { line: lines[i], no: l.line_no }]),
      );
      const { rows: batches } = await db.query(
        `SELECT medicine_id, batch_no, expiry_date, mrp, sale_rate FROM pharmacy_batches
          WHERE medicine_id = ANY($1::int[])`,
        [[...new Set(medicines.map((m) => m.id))]],
      );
      const inStock = new Map(batches.map((b) => [lineKey(b), b]));
      return { byCode, byName, lines, onReceipt, inStock };
    },
    toInput,
    problems: (input) => {
      if (!input.__medicine) {
        return [
          {
            column: input.__code ? "Medicine code" : "Medicine name",
            message: input.__code
              ? `No medicine has the code ${input.__code}`
              : input.__name
                ? `No medicine is named ${input.__name}. Add it in Medicines first`
                : "Fill the medicine code or name",
          },
        ];
      }
      if (!input.__medicine.is_active) {
        return [{ column: "Medicine code", message: `${input.__medicine.name} is deactivated` }];
      }
      return [];
    },
    match: (input, ctx) => {
      if (!input.batch_no || !input.expiry_date) return null;
      const key = lineKey({ ...input, batch_no: input.batch_no.replace(/\s+/g, "") });
      const receiptLine = ctx.onReceipt.get(key);
      if (receiptLine) {
        return {
          id: receiptLine.no,
          values: receiptLine.line,
          label: `Line ${receiptLine.no} on this receipt`,
          addable: true,
          line: receiptLine.line,
        };
      }
      const batch = ctx.inStock.get(key);
      const mrp = Number(input.mrp);
      const sale = Number(input.sale_rate);
      if (
        batch &&
        ((mrp && mrp !== Number(batch.mrp)) || (sale && sale !== Number(batch.sale_rate)))
      ) {
        return {
          id: null,
          values: { mrp: money(batch.mrp), sale_rate: money(batch.sale_rate) },
          compare: ["mrp", "sale_rate"],
          label: "Batch already in stock",
          note: `Batch ${input.batch_no} of ${input.__medicine.name} is already in stock at MRP ${rupee(batch.mrp)} and sale rate ${rupee(batch.sale_rate)}. One batch can only have one price.`,
          choices: [
            { value: "keep", label: "Use the rates already in stock" },
            { value: "skip", label: "Leave this row out" },
          ],
          stock: batch,
        };
      }
      return null;
    },
    keyOf: lineKey,
    describe: (data) => ({
      key: data.__medicine?.name ?? data.__name ?? data.__code ?? "—",
      label: data.batch_no ? `Batch ${data.batch_no}` : null,
    }),
    applyAll: async (work, decisionOf, ctx, db, result) => {
      const lines = purchase.lines.map(lineOf);
      const index = new Map(purchase.lines.map((l, i) => [lineKey(l), i]));
      for (const r of work) {
        if (r.status === "new") {
          lines.push(r.data);
          result.created += 1;
          continue;
        }
        const chosen = decisionOf(r.row);
        const decision = r.choices.some((c) => c.value === chosen) ? chosen : r.choices[0].value;
        if (r.current.stock) {
          if (decision === "keep") {
            lines.push({
              ...r.data,
              mrp: money(r.current.stock.mrp),
              sale_rate: money(r.current.stock.sale_rate),
            });
            result.created += 1;
          } else result.kept += 1;
          continue;
        }
        const at = index.get(lineKey(r.data));
        if (decision === "keep") result.kept += 1;
        else if (decision === "add") {
          lines[at] = {
            ...lines[at],
            qty_packs: lines[at].qty_packs + r.data.qty_packs,
            free_packs: lines[at].free_packs + r.data.free_packs,
          };
          result.added += 1;
        } else {
          lines[at] = { ...lines[at], ...r.data };
          result.updated += 1;
        }
      }
      return { lines, result };
    },
  };
}

const readRows = (buffer) =>
  readSheet(buffer, COLUMNS, {
    keep: (values) =>
      ![values.batch_no, values.qty_packs].every((v) => v === null || v === undefined || v === ""),
    empty: "No filled rows found. Enter a batch and quantity on each row you stock.",
  });

async function draftReceipt(id, db) {
  const purchase = await getPurchase(id, db);
  if (purchase.status !== "draft") {
    throw httpError(409, `This receipt is already ${purchase.status} and can no longer be changed`);
  }
  return purchase;
}

export async function previewReceiptSheet(id, buffer, db = pool) {
  const purchase = await draftReceipt(id, db);
  return previewRows(receiptSpec(purchase), await readRows(buffer), db);
}

export async function importReceiptLines(id, buffer, { version }, decisionOf, ctx = {}, db = pool) {
  const purchase = await draftReceipt(id, db);
  if (purchase.version !== version) {
    throw httpError(409, "Someone else changed this receipt. Reload it and import again");
  }
  const spec = receiptSpec(purchase);
  const preview = await previewRows(spec, await readRows(buffer), db);
  const { lines, result } = await applyRows(spec, preview, decisionOf, ctx, db);
  const changed = result.created + result.updated + result.added > 0;
  const saved = changed
    ? await updatePurchase(
        id,
        {
          version,
          vendor_id: purchase.vendor_id,
          invoice_no: purchase.invoice_no,
          invoice_date: purchase.invoice_date,
          notes: purchase.notes,
          lines,
        },
        ctx,
        db,
      )
    : purchase;
  return { purchase: saved, ...result, counts: preview.counts };
}

export async function receiptProblemFile(id, buffer, db = pool) {
  const purchase = await draftReceipt(id, db);
  const spec = receiptSpec(purchase);
  const preview = await previewRows(spec, await readRows(buffer), db);
  return sheetFile({
    sheetName: "Stock to fix",
    columns: COLUMNS,
    rows: problemRows(spec, preview),
    help: HELP,
    errors: true,
  });
}
