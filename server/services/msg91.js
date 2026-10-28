const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || "";
const MSG91_WA_TEMPLATE_NAME = process.env.MSG91_WA_TEMPLATE_NAME || "";
const MSG91_WA_TEMPLATE_LANG = process.env.MSG91_WA_TEMPLATE_LANG || "en";
const MSG91_WA_INTEGRATED_NUMBER = process.env.MSG91_WA_INTEGRATED_NUMBER || "";
const MSG91_WA_FLOW_TEMPLATE_NAME = process.env.MSG91_WA_FLOW_TEMPLATE_NAME || "";

const IS_DEV = process.env.NODE_ENV !== "production";

export async function sendOtpSms(phone, otp) {
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
export async function sendReferralLetter(phone, vars = {}) {
  const template = process.env.MSG91_WA_REFERRAL_TEMPLATE_NAME || "";
  if (IS_DEV || !MSG91_AUTH_KEY || !template || !MSG91_WA_INTEGRATED_NUMBER || !phone) {
    console.log(`[DEV] Referral letter WhatsApp → ${phone || "(no phone)"}:`, vars);
    return { ok: true, dev: true };
  }

  const to = String(phone).replace(/^\+/, "");
  const order = ["patient_name", "specialty", "doctor_name", "hospital", "letter_link"];
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
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MSG91 referral WhatsApp send failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return { ok: true };
}
