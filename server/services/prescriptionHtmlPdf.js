import { buildRxParameterTable } from "./rxParameterTable.js";
import { createRequire } from "module";
import crypto from "crypto";
import { buildPrescriptionHtml } from "../templates/prescriptionTemplate.js";
import { buildReferralLetterHtml } from "../templates/referralLetterTemplate.js";
import { getPrescriptionFooter } from "./prescriptionFooter.js";
import { getPrescriptionLogo } from "./prescriptionLogo.js";
import { healthrayNoteSections } from "./healthray/noteSections.js";

const require = createRequire(import.meta.url);

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
const PAGE_NUMBER_FOOTER = `
  <div style="width:100%;padding:0 12mm;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#6b7d90;">
    <div style="text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
  </div>`;

export async function renderHtmlToPdf(html, { margin, pageNumbers = true, footerTemplate } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: margin || {
        top: "12mm",
        bottom: pageNumbers ? "16mm" : "12mm",
        left: "12mm",
        right: "12mm",
      },
      displayHeaderFooter: pageNumbers,
      headerTemplate: pageNumbers ? "<div></div>" : undefined,
      footerTemplate: pageNumbers ? footerTemplate || PAGE_NUMBER_FOOTER : undefined,
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export async function generatePrescriptionPdf(data) {
  const [rx_footer, logo, rxParameters, note] = await Promise.all([
    data?.rx_footer ? Promise.resolve(data.rx_footer) : getPrescriptionFooter(),
    data?.rx_logo ? Promise.resolve({ dataUri: data.rx_logo }) : getPrescriptionLogo(),
    resolveRxParameters(data),
    resolveNoteSections(data),
  ]);
  return renderHtmlToPdf(
    buildPrescriptionHtml({
      ...data,
      history: data?.history || note.history,
      referrals: data?.referrals ?? note.referrals,
      rx_footer,
      rx_logo: logo.dataUri,
      rxParameters,
    }),
  );
}

async function resolveNoteSections(data) {
  const patientId = data?.patient?.id;
  if (!patientId || (data.history && data.referrals)) return { history: null, referrals: [] };
  try {
    return await healthrayNoteSections(patientId, data.rxDate || istToday());
  } catch (e) {
    console.error("Rx note sections skipped:", e.message);
    return { history: null, referrals: [] };
  }
}

async function resolveRxParameters(data) {
  if (data?.rxParameters !== undefined) return data.rxParameters;
  const patientId = data?.patient?.id;
  if (!patientId) return null;
  try {
    return await buildRxParameterTable(undefined, {
      patientId,
      visitDate: data.rxDate || istToday(),
      todayOnlyWhenCompleted: true,
    });
  } catch (e) {
    console.error("Rx parameter table skipped:", e.message);
    return null;
  }
}

const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

export async function generateReferralLetterPdf(data) {
  const [rx_footer, logo] = await Promise.all([
    data?.rx_footer ? Promise.resolve(data.rx_footer) : getPrescriptionFooter(),
    data?.rx_logo ? Promise.resolve({ dataUri: data.rx_logo }) : getPrescriptionLogo(),
  ]);
  return renderHtmlToPdf(buildReferralLetterHtml({ ...data, rx_footer, rx_logo: logo.dataUri }));
}
