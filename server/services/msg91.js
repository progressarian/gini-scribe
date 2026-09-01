// MSG91 WhatsApp OTP delivery.
//
// In dev (NODE_ENV !== 'production' OR MSG91_AUTH_KEY blank OR template name
// blank) we skip the network call and print the OTP to the server console
// so testers can grab it without sending a real WhatsApp message.
//
// Required env (production):
//   MSG91_AUTH_KEY              — account auth key (MSG91 → Auth Keys)
//   MSG91_WA_TEMPLATE_NAME      — name of the APPROVED Authentication-category
//                                  WhatsApp template (e.g. "gini_otp_auth")
//   MSG91_WA_TEMPLATE_LANG      — language code matching the approved template
//                                  ("en", "en_US", "hi"). Default "en".
//   MSG91_WA_INTEGRATED_NUMBER  — WABA-registered phone, country code + number,
//                                  no `+` (e.g. "919876543210" or "15559743794").
//
// Endpoint: POST https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/
// Docs: https://docs.msg91.com/whatsapp/

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || "";
const MSG91_WA_TEMPLATE_NAME = process.env.MSG91_WA_TEMPLATE_NAME || "";
const MSG91_WA_TEMPLATE_LANG = process.env.MSG91_WA_TEMPLATE_LANG || "en";
const MSG91_WA_INTEGRATED_NUMBER = process.env.MSG91_WA_INTEGRATED_NUMBER || "";
// Patient-flow check-in template (separate approved template from the OTP one).
//   MSG91_WA_FLOW_TEMPLATE_NAME — approved Utility-category template with 6 body
//   variables in this order: {{1}} patient_name, {{2}} file_number,
//   {{3}} doctor_name, {{4}} estimate_min, {{5}} est_completion_time,
//   {{6}} visit_link. Language falls back to MSG91_WA_TEMPLATE_LANG.
const MSG91_WA_FLOW_TEMPLATE_NAME = process.env.MSG91_WA_FLOW_TEMPLATE_NAME || "";

const IS_DEV = process.env.NODE_ENV !== "production";

export async function sendOtpSms(phone, otp) {
  // Falls back to console in dev OR if any required value is missing.
  // Lets you ship the code before the WABA + template are fully approved —
  // the moment all env values are filled, real WhatsApp delivery kicks in
  // with no code change.
  if (IS_DEV || !MSG91_AUTH_KEY || !MSG91_WA_TEMPLATE_NAME || !MSG91_WA_INTEGRATED_NUMBER) {
    console.log(`[DEV] OTP for ${phone}: ${otp}`);
    return { ok: true, dev: true };
  }

  const to = String(phone).replace(/^\+/, "");

  const body = {
    integrated_number: MSG91_WA_INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: MSG91_WA_TEMPLATE_NAME,
        language: { code: MSG91_WA_TEMPLATE_LANG, policy: "deterministic" },
        // `to_and_components` is MSG91's wrapper around Meta's Cloud API
        // template components. body_1 binds to the first {{1}} in the body;
        // button_1 binds to the copy-code button so tapping it copies the OTP.
        to_and_components: [
          {
            to: [to],
            components: {
              body_1: { type: "text", value: otp },
              button_1: { subtype: "url", type: "text", value: otp },
            },
          },
        ],
      },
    },
  };

  const res = await fetch(
    "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: MSG91_AUTH_KEY },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MSG91 WhatsApp send failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return { ok: true };
}

// Patient-flow check-in confirmation + tracking link. Same dev-fallback as
// sendOtpSms: until the flow template + WABA env are set, it logs to console and
// returns { dev: true } so check-in still works. `vars` keys map positionally to
// the template body variables (see MSG91_WA_FLOW_TEMPLATE_NAME above).
export async function sendFlowCheckin(phone, vars = {}) {
  if (
    IS_DEV ||
    !MSG91_AUTH_KEY ||
    !MSG91_WA_FLOW_TEMPLATE_NAME ||
    !MSG91_WA_INTEGRATED_NUMBER ||
    !phone
  ) {
    console.log(`[DEV] Flow check-in WhatsApp → ${phone || "(no phone)"}:`, vars);
    return { ok: true, dev: true };
  }

  const to = String(phone).replace(/^\+/, "");
  const order = [
    "patient_name",
    "file_number",
    "doctor_name",
    "estimate_min",
    "est_completion_time",
    "visit_link",
  ];
  const components = {};
  order.forEach((k, i) => {
    components[`body_${i + 1}`] = { type: "text", value: String(vars[k] ?? "") };
  });

  const body = {
    integrated_number: MSG91_WA_INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: MSG91_WA_FLOW_TEMPLATE_NAME,
        language: { code: MSG91_WA_TEMPLATE_LANG, policy: "deterministic" },
        to_and_components: [{ to: [to], components }],
      },
    },
  };

  const res = await fetch(
    "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: MSG91_AUTH_KEY },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MSG91 flow WhatsApp send failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return { ok: true };
}

// The medicine card at the pharmacy counter (docs/gini-flow/16-PHARMACY-STATION-PLAN.md §6).
//
// MSG91, not WATI. The brief names WATI; this repo has one WhatsApp vendor, one
// WABA and one template approval queue, and adding a second for one hospital
// would mean two of each. What survives from the brief is the warning: this
// template needs Meta approval and that takes days.
//
//   MSG91_WA_CARD_TEMPLATE_NAME — approved Utility-category template with 4 body
//   variables in this order: {{1}} patient_name, {{2}} medicine_count,
//   {{3}} changes, {{4}} doctor_name. Language falls back to
//   MSG91_WA_TEMPLATE_LANG.
//
// Until it is approved this logs exactly as sendOtpSms does, so the station is
// usable and the counter still records that the card was sent.
export async function sendMedicineCard(phone, vars = {}) {
  const template = process.env.MSG91_WA_CARD_TEMPLATE_NAME || "";
  if (IS_DEV || !MSG91_AUTH_KEY || !template || !MSG91_WA_INTEGRATED_NUMBER || !phone) {
    console.log(`[DEV] Medicine card WhatsApp → ${phone || "(no phone)"}:`, vars);
    return { ok: true, dev: true };
  }

  const to = String(phone).replace(/^\+/, "");
  const order = ["patient_name", "medicine_count", "changes", "doctor_name"];
  const components = {};
  order.forEach((k, i) => {
    components[`body_${i + 1}`] = { type: "text", value: String(vars[k] ?? "") };
  });

  const res = await fetch(
    "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: MSG91_AUTH_KEY },
      body: JSON.stringify({
        integrated_number: MSG91_WA_INTEGRATED_NUMBER,
        content_type: "template",
        payload: {
          messaging_product: "whatsapp",
          type: "template",
          template: {
            name: template,
            language: { code: MSG91_WA_TEMPLATE_LANG, policy: "deterministic" },
            to_and_components: [{ to: [to], components }],
          },
        },
      }),
      // The pharmacy fires this after the counter's request has already been
      // answered, so nothing is waiting on it — but a vendor that never replies
      // would hold the socket for the life of the process.
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `MSG91 medicine-card WhatsApp send failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  return { ok: true };
}
