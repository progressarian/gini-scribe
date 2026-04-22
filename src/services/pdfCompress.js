import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Anthropic rejects request payloads above 32 MB and a single document
// block typically needs to stay well under that. Aim for ≤ 15 MB base64
// so transport/JSON overhead doesn't push us over, while still leaving
// most real-world PDFs (lab reports, Rx scans) untouched.
const MAX_BASE64_BYTES = 15 * 1024 * 1024;

// Each attempt = one pdfjs render-scale + JPEG quality combo. Ordered
// from best-looking to smallest. We stop at the first attempt that fits.
const ATTEMPTS = [
  { scale: 1.5, quality: 0.8 },
  { scale: 1.25, quality: 0.75 },
  { scale: 1.0, quality: 0.7 },
  { scale: 0.85, quality: 0.6 },
  { scale: 0.7, quality: 0.5 },
  { scale: 0.55, quality: 0.4 },
];

function base64ToUint8(base64) {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function uint8ToBase64(bytes) {
  // Chunked to avoid "Maximum call stack exceeded" on large buffers.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function renderPageToJpeg(page, scale, quality) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha — flatten transparent pages to white so they don't
  // render as solid black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await new Promise((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error("canvas.toBlob failed"))),
      "image/jpeg",
      quality,
    ),
  );
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { width: canvas.width, height: canvas.height, jpeg: buf };
}

// Build a minimal PDF 1.4 where each page is a single embedded JPEG.
// PDF structure: Catalog → Pages → (Page + Image XObject + Content stream) × N.
function buildPdfFromJpegs(pages) {
  const enc = new TextEncoder();
  const objects = []; // array of Uint8Array, indexed by obj id - 1

  const pushObj = (dict, streamBytes = null) => {
    const id = objects.length + 1;
    const parts = [enc.encode(`${id} 0 obj\n${dict}\n`)];
    if (streamBytes) {
      parts.push(enc.encode("stream\n"));
      parts.push(streamBytes);
      parts.push(enc.encode("\nendstream\n"));
    }
    parts.push(enc.encode("endobj\n"));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    objects.push(out);
    return id;
  };

  // Emit Image XObject + Content stream for each page first. Remember
  // their ids; we'll need them when we write the Page dicts.
  const perPage = [];
  for (const { width, height, jpeg } of pages) {
    const imageId = pushObj(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${jpeg.length} >>`,
      jpeg,
    );
    const contentStr = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = enc.encode(contentStr);
    const contentId = pushObj(`<< /Length ${contentBytes.length} >>`, contentBytes);
    perPage.push({ imageId, contentId, width, height });
  }

  // Page dicts need /Parent pointing at the Pages obj, which we haven't
  // written yet. We can predict its id: it comes after all page dicts.
  const pagesObjId = objects.length + pages.length + 1;

  const pageIds = [];
  for (const { imageId, contentId, width, height } of perPage) {
    const pageId = pushObj(
      `<< /Type /Page /Parent ${pagesObjId} 0 R ` +
        `/MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
        `/Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  const actualPagesId = pushObj(
    `<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`,
  );
  // Invariant: the predicted pagesObjId must match what we actually got,
  // otherwise /Parent refs are dangling.
  if (actualPagesId !== pagesObjId) {
    throw new Error(`PDF build invariant broken (${actualPagesId} vs ${pagesObjId})`);
  }

  const catalogId = pushObj(`<< /Type /Catalog /Pages ${actualPagesId} 0 R >>`);

  // %PDF-1.4 header + binary-marker comment (4 bytes > 127) so downstream
  // tools treat the file as binary.
  const header = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a,
  ]);

  let size = header.length;
  const offsets = [];
  for (const obj of objects) {
    offsets.push(size);
    size += obj.length;
  }
  const xrefOffset = size;

  const n = objects.length;
  let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += off.toString().padStart(10, "0") + " 00000 n \n";
  xref +=
    `trailer\n<< /Size ${n + 1} /Root ${catalogId} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  const xrefBytes = enc.encode(xref);

  const out = new Uint8Array(size + xrefBytes.length);
  let off = 0;
  out.set(header, off);
  off += header.length;
  for (const obj of objects) {
    out.set(obj, off);
    off += obj.length;
  }
  out.set(xrefBytes, off);
  return out;
}

// Returns { base64, mediaType }. Passes the original through unchanged
// unless it's a PDF over the size cap; then rasterises each page to JPEG
// at progressively smaller scale/quality until it fits, rebuilding a
// valid PDF around the JPEGs. Falls back to the original on any failure.
export async function compressBase64Pdf(base64, mediaType) {
  if (!base64 || mediaType !== "application/pdf") return { base64, mediaType };
  // base64 length × 0.75 ≈ raw bytes. Bail early if already under cap.
  if (base64.length * 0.75 <= MAX_BASE64_BYTES) return { base64, mediaType };

  let pdf = null;
  try {
    // pdf.js transfers the buffer on load — slice so the caller's base64
    // stays valid if we need to fall back.
    const srcBytes = base64ToUint8(base64);
    pdf = await pdfjsLib.getDocument({ data: srcBytes.slice() }).promise;
  } catch (err) {
    console.warn("PDF parse failed, sending original:", err?.message);
    return { base64, mediaType };
  }

  let bestB64 = null;
  try {
    for (const { scale, quality } of ATTEMPTS) {
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        pages.push(await renderPageToJpeg(page, scale, quality));
      }
      const pdfBytes = buildPdfFromJpegs(pages);
      const b64 = uint8ToBase64(pdfBytes);
      if (!bestB64 || b64.length < bestB64.length) bestB64 = b64;
      if (b64.length * 0.75 <= MAX_BASE64_BYTES) {
        return { base64: b64, mediaType: "application/pdf" };
      }
    }
  } catch (err) {
    console.warn("PDF compression failed, sending original:", err?.message);
    return { base64, mediaType };
  } finally {
    try {
      await pdf?.destroy?.();
    } catch {}
  }

  // Even the smallest attempt is over the cap — ship it anyway; it's
  // still smaller than the original and Claude may accept it.
  return { base64: bestB64 || base64, mediaType: "application/pdf" };
}
