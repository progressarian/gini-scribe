// Generates a prescription PDF by rendering the HTML template with
// Puppeteer (headless Chromium). One shared browser instance is kept warm
// across requests — Puppeteer cold-starts ~1-2s, so reusing it makes the
// per-request cost only the page render.

import { createRequire } from "module";
import { buildPrescriptionHtml } from "../templates/prescriptionTemplate.js";

const require = createRequire(import.meta.url);

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
