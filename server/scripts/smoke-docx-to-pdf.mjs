import fs from "fs";
import { asViewableUpload } from "../services/officeToPdf.js";

const sample = process.argv[2];
if (!sample) {
  console.error("Usage: node scripts/smoke-docx-to-pdf.mjs <sample.docx>");
  process.exit(2);
}

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
};

const docx = await asViewableUpload({
  buffer: fs.readFileSync(sample),
  fileName: "echo report.docx",
  mediaType: "application/octet-stream",
});
check("docx becomes a PDF", docx.buffer.subarray(0, 5).toString() === "%PDF-", docx.mediaType);
check("converted name ends in .pdf", docx.fileName === "echo report.pdf", docx.fileName);
check("converted mime is application/pdf", docx.mediaType === "application/pdf", docx.mediaType);
check("converted flag is set", docx.converted === true, docx.converted);

const pdfIn = Buffer.from("%PDF-1.4 fake");
const pdf = await asViewableUpload({
  buffer: pdfIn,
  fileName: "r.pdf",
  mediaType: "application/pdf",
});
check("pdf passes through unchanged", pdf.buffer === pdfIn && !pdf.converted, pdf);

const jpg = await asViewableUpload({ buffer: pdfIn, fileName: "r.jpg", mediaType: "image/jpeg" });
check("image passes through unchanged", jpg.mediaType === "image/jpeg" && !jpg.converted, jpg);

const legacy = await asViewableUpload({
  buffer: pdfIn,
  fileName: "old.doc",
  mediaType: "application/msword",
}).catch((e) => e);
check("legacy .doc is refused with 415", legacy?.status === 415, legacy?.message);

const broken = await asViewableUpload({
  buffer: Buffer.from("not a zip"),
  fileName: "broken.docx",
  mediaType: "",
}).catch((e) => e);
check("broken docx is refused with 422", broken?.status === 422, broken?.message);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
