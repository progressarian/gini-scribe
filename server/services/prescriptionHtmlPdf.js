// Generates a prescription PDF by rendering the HTML template with
// Puppeteer (headless Chromium). One shared browser instance is kept warm
// across requests — Puppeteer cold-starts ~1-2s, so reusing it makes the
// per-request cost only the page render.

import { createRequire } from "module";
import crypto from "crypto";
import { buildPrescriptionHtml } from "../templates/prescriptionTemplate.js";

const require = createRequire(import.meta.url);

// Builds a prescription filename like:
//   "Prescription_Rx - dr__anil_bhansali_29_01_2026_03_47_PM_1c5ywjwdy.pdf"
// Date/time are formatted in Asia/Kolkata so the filename matches the local
// clock the doctor sees when they end the visit.
export function buildPrescriptionFileName(doctorName, now = new Date()) {
  const slug =
    (doctorName || "doctor")
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "doctor";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
    .formatToParts(now)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

  const date = `${parts.day}_${parts.month}_${parts.year}`;
  const time = `${parts.hour}_${parts.minute}_${(parts.dayPeriod || "").toUpperCase()}`;
  const shortId = crypto.randomBytes(5).toString("base64url").toLowerCase();

  return `Prescription_Rx - ${slug}_${date}_${time}_${shortId}.pdf`;
}

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b && b.connected !== false) return b;
    } catch {
      // Fall through and re-launch
    }
  }
  const puppeteer = require("puppeteer");
  browserPromise = puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    headless: "new",
  });
  const browser = await browserPromise;
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

export async function generatePrescriptionPdf(data) {
  const html = buildPrescriptionHtml(data);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
    });
    return pdf;
  } finally {
    await page.close();
  }
}
