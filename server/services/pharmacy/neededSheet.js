import { z } from "zod";
import pool from "../../config/db.js";
import { NEEDED_REASON_LABEL, RX_NOT_GIVEN_REASON_LABEL } from "../../../shared/pharmacyVocab.js";
import { medicineKey } from "./stockMatch.js";
import { applyRows, previewRows, problemRows, readSheet, sheetFile } from "./sheetImport.js";
import { asNumber, asText, isoDate, nameKey } from "./sheetValues.js";

export const NEEDED_COLUMNS = [
  { field: "medicine_name", header: "Medicine name", width: 36, required: true },
  { field: "reason", header: "Reason", width: 22, required: true },
  { field: "qty_units", header: "Quantity needed (units)", width: 14 },
  { field: "needed_on", header: "Date (DD/MM/YYYY)", aliases: ["Date"], width: 16 },
  { field: "note", header: "Note", width: 40 },
];

const REASON_BY_TEXT = new Map(
  Object.entries(RX_NOT_GIVEN_REASON_LABEL).flatMap(([code, label]) => [
    [code.replace(/_/g, " "), code],
    [code, code],
    [nameKey(label), code],
  ]),
);

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const schema = z
  .strictObject({
    medicine_name: z.string().trim().min(2, "must be at least 2 characters").max(200),
    reason: z.enum(Object.keys(RX_NOT_GIVEN_REASON_LABEL), {
      message: `must be one of: ${Object.values(RX_NOT_GIVEN_REASON_LABEL).join(", ")}`,
    }),
    qty_units: z.coerce.number().int().min(1).max(1000000).nullish(),
    needed_on: z.iso
      .date("must be a date like 31/12/2026")
      .refine((d) => d <= today(), "cannot be in the future"),
    note: z.string().trim().max(300).nullish(),
  })
  .refine((r) => r.reason !== "other" || Boolean(r.note), {
    path: ["note"],
    message: "is needed when the reason is Other",
  });

const LABELS = {
  medicine_name: "Medicine name",
  reason: "Reason",
  qty_units: "Quantity needed",
  needed_on: "Date",
  note: "Note",
};

const rowKey = (r) => `${medicineKey(r.medicine_name)}|${r.needed_on}|${r.reason}`;

function toInput(values) {
  const reasonText = nameKey(values.reason);
  return {
    medicine_name: asText(values.medicine_name),
    reason: REASON_BY_TEXT.get(reasonText) ?? asText(values.reason),
    qty_units: asNumber(values.qty_units),
    needed_on: values.needed_on ? isoDate(values.needed_on) : undefined,
    note: asText(values.note),
  };
}

const spec = {
  noun: "medicine",
  columns: NEEDED_COLUMNS,
  labels: LABELS,
  schema,
  compare: ["qty_units", "note"],
  add: true,
  defaults: { needed_on: today() },
  load: async (rawRows, db) => {
    const { rows } = await db.query(
      `SELECT id, medicine_key, medicine_name, reason, note, qty_units, needed_on::text AS needed_on
         FROM pharmacy_medicine_requests WHERE source = 'import'`,
    );
    const byKey = new Map(
      rows.map((r) => [
        `${r.medicine_key}|${r.needed_on}|${r.reason}`,
        {
          id: r.id,
          values: { qty_units: r.qty_units, note: r.note },
          label: `Added earlier for ${r.needed_on}`,
          addable: true,
        },
      ]),
    );
    return { byKey };
  },
  toInput,
  match: (input, ctx) =>
    input.medicine_name && input.reason
      ? (ctx.byKey.get(rowKey({ ...input, needed_on: input.needed_on ?? today() })) ?? null)
      : null,
  keyOf: rowKey,
  describe: (data) => ({
    key: data.medicine_name || "—",
    label: RX_NOT_GIVEN_REASON_LABEL[data.reason] ?? null,
  }),
  create: (client, r, ctx) =>
    client.query(
      `INSERT INTO pharmacy_medicine_requests
         (medicine_key, medicine_name, source, reason, note, qty_units, needed_on, requested_by)
       VALUES ($1, $2, 'import', $3, $4, $5, $6, $7)`,
      [
        medicineKey(r.data.medicine_name) || r.data.medicine_name.toUpperCase(),
        r.data.medicine_name,
        r.data.reason,
        r.data.note ?? null,
        r.data.qty_units ?? null,
        r.data.needed_on,
        ctx.actorId ?? null,
      ],
    ),
  update: (client, r) =>
    client.query(`UPDATE pharmacy_medicine_requests SET qty_units = $1, note = $2 WHERE id = $3`, [
      r.data.qty_units ?? null,
      r.data.note ?? null,
      r.current.id,
    ]),
  add: (client, r) =>
    client.query(
      `UPDATE pharmacy_medicine_requests
          SET qty_units = COALESCE(qty_units, 0) + COALESCE($1, 0),
              note = COALESCE($2, note)
        WHERE id = $3`,
      [r.data.qty_units ?? null, r.data.note ?? null, r.current.id],
    ),
};

const HELP = [
  "One row per medicine that was needed but could not be given.",
  `Reason must be one of: ${Object.values(RX_NOT_GIVEN_REASON_LABEL).join(", ")}. A note is needed for Other.`,
  "Quantity is in units (tablets, ml, vials…). Leave it blank if you do not know it.",
  "Date can be 31/12/2026 or 2026-12-31. Leave it blank for today.",
  "If the same medicine, date and reason was added before, you choose to keep it, use the sheet or add the quantities together.",
];

export function neededSample() {
  return sheetFile({
    sheetName: "Needed in stock",
    columns: NEEDED_COLUMNS,
    rows: [
      {
        medicine_name: "Glycomet GP 2",
        reason: "Out of stock",
        qty_units: 30,
        needed_on: "18/11/2026",
        note: "",
      },
      {
        medicine_name: "Huminsulin R 40IU",
        reason: "Other",
        qty_units: 2,
        needed_on: "17/11/2026",
        note: "Patient needs a cold box",
      },
    ],
    help: HELP,
  });
}

export async function previewNeededSheet(buffer, db = pool) {
  return previewRows(spec, await readSheet(buffer, NEEDED_COLUMNS), db);
}

export async function applyNeededSheet(buffer, decisionOf, ctx, db = pool) {
  const preview = await previewNeededSheet(buffer, db);
  return { ...(await applyRows(spec, preview, decisionOf, ctx, db)), counts: preview.counts };
}

export async function neededProblemFile(buffer, db = pool) {
  const preview = await previewNeededSheet(buffer, db);
  return sheetFile({
    sheetName: "Needed rows to fix",
    columns: NEEDED_COLUMNS,
    rows: problemRows(spec, preview),
    help: HELP,
    errors: true,
  });
}

const STATUS_TEXT = {
  not_stocked: "Not stocked",
  out_of_stock: "Out of stock",
  in_stock: "In stock",
};

export async function neededReportFile(filters, list) {
  const report = await list(filters);
  const reasonCodes = Object.keys(NEEDED_REASON_LABEL);
  return sheetFile({
    sheetName: "Needed in stock",
    columns: [
      { field: "medicine", header: "Medicine", width: 36 },
      { field: "status", header: "Stock now", width: 14 },
      { field: "times", header: "Times not given", width: 14 },
      { field: "patients", header: "Patients", width: 10 },
      ...reasonCodes.map((code) => ({ field: code, header: NEEDED_REASON_LABEL[code], width: 14 })),
      { field: "qty", header: "Quantity asked (units)", width: 14 },
      { field: "notes", header: "Notes", width: 50 },
      { field: "last", header: "Last date", width: 12 },
      { field: "ordered", header: "Ordered", width: 22 },
    ],
    rows: report.items.map((item) => ({
      medicine: item.medicineName,
      status: STATUS_TEXT[item.status],
      times: item.times,
      patients: item.patients,
      ...Object.fromEntries(reasonCodes.map((code) => [code, item.reasons[code] ?? null])),
      qty: item.qtyUnits,
      notes: item.notes.map((n) => `${n.date}: ${n.text}`).join("\n"),
      last: item.lastPrescribed,
      ordered: item.ordered ? `${item.ordered.by ?? "Yes"}` : "",
    })),
  });
}
