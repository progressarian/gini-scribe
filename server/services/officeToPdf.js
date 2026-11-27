import mammoth from "mammoth";
import { renderHtmlToPdf } from "./prescriptionHtmlPdf.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const LEGACY_OFFICE = /\.(doc|rtf|odt|wps)$/i;
const LEGACY_MIME =
  /^(application\/msword|application\/rtf|text\/rtf|application\/vnd\.oasis\.opendocument\.text)$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

const extensionOf = (fileName) =>
  String(fileName || "")
    .toLowerCase()
    .split(".")
    .pop();

export const isDocx = ({ fileName, mediaType }) =>
  extensionOf(fileName) === "docx" || mediaType === DOCX_MIME;

const isLegacyOffice = ({ fileName, mediaType }) =>
  LEGACY_OFFICE.test(String(fileName || "")) || LEGACY_MIME.test(String(mediaType || ""));

const pdfName = (fileName) =>
  `${String(fileName || "report").replace(/\.[^.]+$/, "") || "report"}.pdf`;

const DOCX_PAGE_CSS = `
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.45; color: #111; }
  h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
  h1, h2, h3, h4 { margin: 12px 0 6px; }
  p { margin: 0 0 6px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  td, th { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
  td p, th p { margin: 0; }
  img { max-width: 100%; height: auto; }
`;

async function docxToPdf(buffer) {
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer }));
  } catch {
    throw fail(422, "This Word file could not be converted — save it as PDF and upload again");
  }
  if (!String(html || "").trim()) {
    throw fail(422, "This Word file is empty — save it as PDF and upload again");
  }
  return renderHtmlToPdf(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${DOCX_PAGE_CSS}</style></head><body>${html}</body></html>`,
    { pageNumbers: false },
  );
}

export async function asViewableUpload({ buffer, fileName, mediaType }) {
  if (isDocx({ fileName, mediaType })) {
    return {
      buffer: await docxToPdf(buffer),
      fileName: pdfName(fileName),
      mediaType: "application/pdf",
      converted: true,
    };
  }
  if (isLegacyOffice({ fileName, mediaType })) {
    throw fail(415, "This file type cannot be shown — save it as PDF or DOCX and upload again");
  }
  return { buffer, fileName, mediaType, converted: false };
}
