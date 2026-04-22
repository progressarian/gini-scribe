// Anthropic rejects base64 image payloads above 5 MB per image.
// Stay under 4.5 MB to leave headroom for JSON/transport overhead.
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;

const ATTEMPTS = [
  { maxDim: 2400, quality: 0.8 },
  { maxDim: 2000, quality: 0.75 },
  { maxDim: 1600, quality: 0.7 },
  { maxDim: 1280, quality: 0.65 },
  { maxDim: 1024, quality: 0.6 },
  { maxDim: 800, quality: 0.5 },
];

function base64ToBlob(base64, mediaType) {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image decode failed"));
    };
    img.src = url;
  });
}

function drawToBlob(img, maxDim, quality) {
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality,
    ),
  );
}

// Returns { base64, mediaType } — original if already small or non-image,
// otherwise a JPEG-compressed copy that fits under the Anthropic limit.
export async function compressBase64Image(base64, mediaType) {
  if (!base64 || !mediaType?.startsWith?.("image/")) return { base64, mediaType };
  // base64 char length ≈ 4/3 of raw bytes; bail early if already under threshold.
  if (base64.length * 0.75 <= MAX_BASE64_BYTES) return { base64, mediaType };

  try {
    const srcBlob = base64ToBlob(base64, mediaType);
    const img = await loadImage(srcBlob);

    for (const { maxDim, quality } of ATTEMPTS) {
      const outBlob = await drawToBlob(img, maxDim, quality);
      const outB64 = await blobToBase64(outBlob);
      if (outB64.length * 0.75 <= MAX_BASE64_BYTES) {
        return { base64: outB64, mediaType: "image/jpeg" };
      }
    }

    // Final fallback: return the smallest attempt anyway — better than the original.
    const finalBlob = await drawToBlob(img, 800, 0.4);
    const finalB64 = await blobToBase64(finalBlob);
    return { base64: finalB64, mediaType: "image/jpeg" };
  } catch (err) {
    console.warn("Image compression failed, sending original:", err.message);
    return { base64, mediaType };
  }
}
