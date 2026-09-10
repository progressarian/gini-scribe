// Generates a prescription PDF by rendering the HTML template with
// Puppeteer (headless Chromium). One shared browser instance is kept warm
// across requests — Puppeteer cold-starts ~1-2s, so reusing it makes the
// per-request cost only the page render.

import { createRequire } from "module";
import crypto from "crypto";
import { buildPrescriptionHtml } from "../templates/prescriptionTemplate.js";
import { buildReferralLetterHtml } from "../templates/referralLetterTemplate.js";
import { getPrescriptionFooter } from "./prescriptionFooter.js";
import { getPrescriptionLogo } from "./prescriptionLogo.js";

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

// "Page 2 of 3" in the bottom margin of every printed page. A prescription that
// runs past one sheet is handed over as loose paper, so each sheet has to say
// where it sits in the set — and a patient (or a pharmacy) has to be able to
// tell that a page is missing. Rendered by Chromium, not the template, because
// only the print engine knows the final page count.
const PAGE_NUMBER_FOOTER = `
  <div style="width:100%;padding:0 12mm;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#6b7d90;">
    <div style="text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
  </div>`;

// The rendering half, without the prescription's own template — the warm
// browser is the expensive part and there is now more than one thing to print.
export async function renderHtmlToPdf(html, { margin, pageNumbers = true } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    // Buffer, not the Uint8Array Puppeteer 24 hands back. `res.send()` treats a
    // plain Uint8Array as an object and JSON-encodes it, so the browser gets
    // {"0":37,"1":80,...} with a Content-Type of application/pdf and reports
    // "Failed to load PDF document". Buffer is a Uint8Array, so the storage
    // upload path is unaffected.
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      // The footer is drawn INSIDE the bottom margin, so the margin has to grow
      // with it or Chromium prints the page number over the last line of body.
      margin: margin || {
        top: "12mm",
        bottom: pageNumbers ? "16mm" : "12mm",
        left: "12mm",
        right: "12mm",
      },
      displayHeaderFooter: pageNumbers,
      headerTemplate: pageNumbers ? "<div></div>" : undefined,
      footerTemplate: pageNumbers ? PAGE_NUMBER_FOOTER : undefined,
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export async function generatePrescriptionPdf(data) {
  // Resolved here rather than at each call site: the strip is fixed clinic-wide,
  // and prescriptions are rendered from the client, the visit route and the
  // sync auto-save alike — none of which should have to remember to fetch it.
  const [rx_footer, logo] = await Promise.all([
    data?.rx_footer ? Promise.resolve(data.rx_footer) : getPrescriptionFooter(),
    data?.rx_logo ? Promise.resolve({ dataUri: data.rx_logo }) : getPrescriptionLogo(),
  ]);
  return renderHtmlToPdf(buildPrescriptionHtml({ ...data, rx_footer, rx_logo: logo.dataUri }));
}

// The referral letter (19 §7.1). Same warm browser, deliberately — a second
// Chromium for a one-page letter would double the memory the API holds all day
// for a render that costs the same as the prescription's.
export async function generateReferralLetterPdf(data) {
  // Same letterhead, so the same mark and the same hospital identity — a letter
  // and a prescription handed over together must not show two different logos,
  // nor two different addresses for the place that issued them.
  const [rx_footer, logo] = await Promise.all([
    data?.rx_footer ? Promise.resolve(data.rx_footer) : getPrescriptionFooter(),
    data?.rx_logo ? Promise.resolve({ dataUri: data.rx_logo }) : getPrescriptionLogo(),
  ]);
  return renderHtmlToPdf(buildReferralLetterHtml({ ...data, rx_footer, rx_logo: logo.dataUri }));
}
