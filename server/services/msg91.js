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
