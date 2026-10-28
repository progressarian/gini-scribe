import { createRequire } from "module";
import pool from "../config/db.js";
import { DEFAULT_LOGO_DATA_URI } from "../templates/prescriptionTemplate.js";

const require = createRequire(import.meta.url);

const KEY = "rx_logo";
const MAX_HEIGHT = 200;

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ACCEPTED = new Set(["png", "jpeg", "jpg", "webp", "gif", "svg"]);

export function decodeDataUri(dataUri) {
  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(String(dataUri || "").trim());
  if (!m) throw Object.assign(new Error("That doesn't look like an image file"), { status: 400 });
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw Object.assign(new Error("The image was empty"), { status: 400 });
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error("Image is larger than 4MB — use a smaller file"), {
      status: 413,
    });
  }
  return { mime: m[1].toLowerCase(), buf };
}
export async function normalizeLogo(dataUri) {
  const { buf } = decodeDataUri(dataUri);
  const sharp = require("sharp");
  let img = sharp(buf, { animated: false });

  let meta;
  try {
    meta = await img.metadata();
  } catch {
    throw Object.assign(new Error("That file isn't a readable image"), { status: 400 });
  }
  if (!meta?.format || !ACCEPTED.has(meta.format)) {
    throw Object.assign(new Error("Use a PNG, JPG, WebP or SVG file"), { status: 400 });
  }

  img = img.trim({ threshold: 12 });

  const out = await img
    .resize({ height: MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  return {
    dataUri: `data:image/png;base64,${out.data.toString("base64")}`,
    width: out.info.width,
    height: out.info.height,
    bytes: out.data.length,
    warning: await backgroundWarning(out.data),
  };
}
async function backgroundWarning(png) {
  try {
    const sharp = require("sharp");
    const stats = await sharp(png).stats();
    if (!stats.isOpaque) return null;
    const [r, g, b] = stats.channels.slice(0, 3).map((c) => c.mean);
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
    return light
      ? "This image has no transparency, so it will print as a light tile on the dark letterhead band. A PNG with a transparent background looks better."
      : "This image has no transparency, so its background will print as a solid block on the letterhead band. A PNG with a transparent background looks better.";
  } catch {
    return null;
  }
}

let cache = null;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getPrescriptionLogo({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  let stored = null;
  try {
    const { rows } = await pool.query("SELECT value FROM app_kv WHERE key=$1", [KEY]);
    stored = rows[0]?.value || null;
  } catch {
    stored = null; // A prescription still has to print with the shipped mark.
  }
  cache = stored?.dataUri
    ? { ...stored, isDefault: false }
    : { dataUri: DEFAULT_LOGO_DATA_URI, isDefault: true };
  cachedAt = Date.now();
  return cache;
}

export async function setPrescriptionLogo(dataUri) {
  const value = { ...(await normalizeLogo(dataUri)), updatedAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(value)],
  );
  cache = { ...value, isDefault: false };
  cachedAt = Date.now();
  return cache;
}

export async function resetPrescriptionLogo() {
  await pool.query("DELETE FROM app_kv WHERE key=$1", [KEY]);
  cache = { dataUri: DEFAULT_LOGO_DATA_URI, isDefault: true };
  cachedAt = Date.now();
  return cache;
}
