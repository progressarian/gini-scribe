// ── OPD bill (PDF) → structured values via Claude ───────────────────────────
// Reads a billing PDF *in memory* and returns the line items + totals + payment
// status. Nothing is downloaded or stored — the caller passes the PDF bytes, we
// hand them to Claude as a document block, and return the parsed object.
//
// Each line item is also classified (consultation / lab / imaging / procedure)
// so the caller can map it to a journey step (lab → Blood Sample, etc.).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { createLogger } from "../logger.js";
const { log, error } = createLogger("Billing Extract");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

const BillingItemSchema = z.object({
  desc: z.string().describe("the particular / line item name, cleaned"),
  unit: z.number().describe("quantity (UNIT column); 1 if absent"),
  rate: z.number().describe("per-unit RATE; same as amount when unit is 1"),
  amount: z.number().describe("line AMOUNT (unit × rate)"),
  // Drives the journey-step mapping downstream.
  category: z
    .enum(["consultation", "lab", "imaging", "procedure", "other"])
    .describe(
      "consultation = doctor visit/appointment/follow-up; lab = blood/urine tests " +
        "(HbA1c, Lipid, CBC, Creatinine, Glucose, KFT, LFT, etc.); imaging = X-Ray, " +
        "Echo, ECG, TMT, Fundus, ABI, VPT, USG; procedure = any in-clinic procedure; " +
        "other = registration/consumables/misc.",
    ),
});

export const BillingSchema = z.object({
  bill_no: z.string(),
  bill_date: z.string().describe("ISO date YYYY-MM-DD"),
  department: z.string(),
  patient_name: z.string(),
  uhid: z.string().describe("UHID / patient file number, e.g. P_179506"),
  consultant: z.string().describe("consulting doctor name"),
  items: z.array(BillingItemSchema),
  total: z.number(),
  paid_amount: z.number(),
  net_payable: z.number().describe("amount still owed; 0 when fully paid"),
  payment_status: z
    .enum(["Paid", "Due", "Partial"])
    .describe("Paid when net_payable is 0; Partial when some paid but net_payable > 0; else Due"),
});

const BILLING_EXTRACTION_PROMPT = `You are extracting structured data from a hospital OPD bill / invoice PDF.

Return ONLY the fields in the schema. Rules:
- Read the PARTICULARS table: one entry per row with desc, unit, rate, amount. Strip currency symbols and thousands separators (₹, commas) — amounts are plain numbers (e.g. "1,500.00" → 1500).
- Classify every line's category per the schema (consultation / lab / imaging / procedure / other). When unsure, use "other".
- bill_date: convert any format (DD/MM/YYYY etc.) to ISO YYYY-MM-DD.
- total = TOTAL / BILLED AMOUNT. paid_amount = PAID AMOUNT. net_payable = NET PAYABLE AMOUNT.
- payment_status: "Paid" if net_payable is 0; "Partial" if 0 < paid_amount < total; otherwise "Due".
- IGNORE footer / boilerplate (hospital address, GST no, operator signature, page numbers, amount-in-words).
- If a field is genuinely absent, use an empty string for text or 0 for numbers — never invent values.`;

// Read a billing PDF (Buffer / Uint8Array) and return the structured object, or
// null if extraction is unavailable/fails. Nothing is persisted.
export async function parseBillingPdfWithAi(pdfBuffer, mimeType = "application/pdf") {
  if (!anthropic) return null;
  if (!pdfBuffer || !pdfBuffer.length) return null;

  const base64 = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer.toString("base64")
    : Buffer.from(pdfBuffer).toString("base64");

  try {
    const response = await anthropic.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 4000,
      temperature: 0,
      system: [
        { type: "text", text: BILLING_EXTRACTION_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: "Extract the billing data from this OPD bill." },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(BillingSchema) },
    });
    if (response?.usage) {
      const u = response.usage;
      log("usage", `in=${u.input_tokens} out=${u.output_tokens}`);
    }
    return response.parsed_output ?? null;
  } catch (e) {
    error("parse", e?.message || String(e));
    return null;
  }
}

// Map HealthRay get_transactions rows → { billing, steps }. This is the primary
// path (structured JSON, no PDF/AI): each billing_item's category_type tells us
// the journey step. Prefers the transaction(s) for `appointmentId`; else the
// most recent. PATHOLOGY → one "Blood Sample" step (tests listed); RADIOLOGY →
// one step per imaging item; OPD → consultation (no step, the consult exists).
export function transactionsToBilling(rows, { appointmentId } = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let txns = appointmentId
    ? rows.filter((r) => String(r.appointment_id) === String(appointmentId))
    : [];
  if (!txns.length) txns = [rows[0]]; // rows are newest-first

  const num = (v) => Number(v) || 0;
  const items = [];
  for (const t of txns) {
    for (const b of t.billing_items || []) {
      const cat = (b.category_type || b.charge_category || "").toUpperCase();
      items.push({
        desc: b.name,
        amount: num(b.net_price ?? b.price),
        category:
          cat === "OPD"
            ? "consultation"
            : cat === "PATHOLOGY"
              ? "lab"
              : cat === "RADIOLOGY"
                ? "imaging"
                : cat.includes("MACHINE") // "Machine Test" → ABI/VPT/ECG-type bedside tests
                  ? "machine"
                  : "other",
      });
    }
  }

  const total = txns.reduce((s, t) => s + num(t.net_paid_amount ?? t.payable_amount), 0);
  const due = txns.reduce((s, t) => s + num(t.due_amount), 0);
  const labs = items.filter((i) => i.category === "lab").map((i) => i.desc);
  const steps = [];
  if (labs.length) {
    steps.push({ step_catalog_id: "blood_sample", step_name: "Blood Sample", tests: labs });
  }
  // Imaging (RADIOLOGY) and machine tests (ABI/VPT/ECG-type) each get their own
  // step so they're not silently dropped.
  for (const i of items.filter((i) => i.category === "imaging" || i.category === "machine")) {
    steps.push({ step_catalog_id: null, step_name: i.desc });
  }

  return {
    steps,
    billing: {
      invoice_no: txns[0].invoice_no,
      bill_date: txns[0].billing_date,
      total,
      due,
      payment_status: due > 0 ? "Due" : "Paid",
      items,
    },
  };
}

// Map an extracted bill to suggested journey steps. Lab lines collapse into a
// single "Blood Sample" step carrying the test names; imaging/procedures each
// suggest their own step. Consultation/other never add steps (the consult step
// already exists; "other" isn't a floor step). The caller injects these as
// removable suggestions at check-in and stamps the Billing step with the total.
export function billingToStepSuggestions(billing) {
  if (!billing?.items?.length) return { steps: [], billing: null };

  const labs = billing.items.filter((i) => i.category === "lab").map((i) => i.desc);
  const steps = [];
  if (labs.length) {
    steps.push({ step_catalog_id: "blood_sample", step_name: "Blood Sample", tests: labs });
  }
  for (const i of billing.items.filter(
    (i) => i.category === "imaging" || i.category === "procedure",
  )) {
    steps.push({ step_catalog_id: null, step_name: i.desc });
  }

  return {
    steps, // removable suggestions to add to the journey at check-in
    billing: {
      bill_no: billing.bill_no,
      total: billing.total,
      paid_amount: billing.paid_amount,
      net_payable: billing.net_payable,
      payment_status: billing.payment_status,
    },
  };
}
