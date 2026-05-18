// One-off WhatsApp OTP test — bypasses the NODE_ENV dev fallback so we
// always hit MSG91 for real. Use to validate the WABA + template wiring
// before flipping NODE_ENV=production for the whole server.
//
//   node scripts/send-test-whatsapp.mjs 7494938207
//
// Prints the raw MSG91 response so failure reasons are visible.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFiles = [join(__dirname, "..", ".env"), join(__dirname, "..", "server", ".env")];
for (const path of envFiles) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const phoneArg = process.argv[2];
if (!phoneArg) {
  console.error("Usage: node scripts/send-test-whatsapp.mjs <10-digit-phone-or-with-cc>");
  process.exit(1);
}

const digits = String(phoneArg).replace(/\D/g, "");
const to = digits.length === 10 ? `91${digits}` : digits;

const otp = String(Math.floor(100000 + Math.random() * 900000));

const {
  MSG91_AUTH_KEY,
  MSG91_WA_TEMPLATE_NAME,
  MSG91_WA_TEMPLATE_LANG = "en",
  MSG91_WA_INTEGRATED_NUMBER,
} = process.env;

console.log("MSG91 WhatsApp test");
console.log("  template :", MSG91_WA_TEMPLATE_NAME || "(missing!)");
console.log("  language :", MSG91_WA_TEMPLATE_LANG);
console.log("  from     :", MSG91_WA_INTEGRATED_NUMBER || "(missing!)");
console.log("  to       :", to);
console.log("  otp      :", otp);
console.log();

if (!MSG91_AUTH_KEY || !MSG91_WA_TEMPLATE_NAME || !MSG91_WA_INTEGRATED_NUMBER) {
  console.error("Required env missing. Check server/.env.");
  process.exit(1);
}

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

console.log("Request body:");
console.log(JSON.stringify(body, null, 2));
console.log();

const res = await fetch(
  "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
  {
    method: "POST",
    headers: { "Content-Type": "application/json", authkey: MSG91_AUTH_KEY },
    body: JSON.stringify(body),
  },
);

const text = await res.text();
console.log(`Status: ${res.status} ${res.statusText}`);
console.log("Response body:");
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
