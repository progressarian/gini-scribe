import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY = process.env.AADHAAR_ENCRYPTION_KEY
  ? Buffer.from(process.env.AADHAAR_ENCRYPTION_KEY, "hex")
  : null;

if (!KEY)
  console.warn("⚠️  AADHAAR_ENCRYPTION_KEY not set — Aadhaar numbers will be stored as plain text");

// Encrypt: returns "iv:authTag:ciphertext" (all hex)
export function encryptAadhaar(plain) {
  if (!plain || !KEY) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plain, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

// Decrypt: expects "iv:authTag:ciphertext" format, returns plain text
// Returns masked value for API responses — full value only via decryptAadhaarFull
export function decryptAadhaar(stored) {
  if (!stored || !KEY) return stored;
  // Not encrypted (legacy plain text) — return masked
  if (!stored.includes(":")) return maskAadhaar(stored);
  try {
    const [ivHex, authTagHex, ciphertext] = stored.split(":");
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return maskAadhaar(decrypted);
  } catch {
    return "XXXX XXXX XXXX";
  }
}

// Full decrypt (for internal use only, never send to client without masking)
export function decryptAadhaarFull(stored) {
  if (!stored || !KEY) return stored;
  if (!stored.includes(":")) return stored;
  try {
    const [ivHex, authTagHex, ciphertext] = stored.split(":");
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

// Mask: "123456789012" → "XXXX XXXX 9012"
function maskAadhaar(val) {
  if (!val) return val;
  const digits = val.replace(/\s/g, "");
  if (digits.length < 4) return "XXXX XXXX XXXX";
  return `XXXX XXXX ${digits.slice(-4)}`;
}
