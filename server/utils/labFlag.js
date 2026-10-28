export function parseRefRange(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { min: null, max: null };

  const num = (s) => {
    const n = parseFloat(String(s).replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const between = raw.match(/^([+-]?[\d.]+)\s*(?:-|–|—|to)\s*([+-]?[\d.]+)$/i);
  if (between) return { min: num(between[1]), max: num(between[2]) };

  const above = raw.match(/^(?:>|>=|≥|above|min\.?)\s*([+-]?[\d.]+)/i);
  if (above) return { min: num(above[1]), max: null };

  const below = raw.match(/^(?:<|<=|≤|below|upto|up to|max\.?)\s*([+-]?[\d.]+)/i);
  if (below) return { min: null, max: num(below[1]) };

  return { min: null, max: null };
}

export function flagFor(value, { min = null, max = null } = {}) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (min == null && max == null) return null;
  if (min != null && n < min) return "LOW";
  if (max != null && n > max) return "HIGH";
  return null;
}

export const flagForRange = (value, refRangeText) => flagFor(value, parseRefRange(refRangeText));
