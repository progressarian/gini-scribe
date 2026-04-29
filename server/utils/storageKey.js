// Supabase storage keys must be ASCII-only and URL-safe; filenames that come
// from the OS (especially after renaming) often contain em-dashes, smart
// quotes, or other unicode that Supabase rejects with InvalidKey. Sanitize
// for the key while preserving the extension.
export function sanitizeForStorageKey(name) {
  if (!name) return `file_${Date.now()}`;
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  const cleanBase = base
    .normalize("NFKD")
    .replace(/[–—]/g, "-")
    .replace(/[‘’“”]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 120);
  const cleanExt = ext.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const safeBase = cleanBase || `file_${Date.now()}`;
  return cleanExt ? `${safeBase}.${cleanExt}` : safeBase;
}
