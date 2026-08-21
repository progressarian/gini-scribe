export function pct(numerator, denominator, decimals = 1) {
  if (!denominator) return null;
  return round((numerator / denominator) * 100, decimals);
}

export function round(value, decimals = 1) {
  if (value == null || isNaN(value)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

export function mean(values) {
  const xs = values.filter((v) => v != null && !isNaN(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function quantile(values, q) {
  const xs = values.filter((v) => v != null && !isNaN(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (xs[base + 1] === undefined) return xs[base];
  return xs[base] + rest * (xs[base + 1] - xs[base]);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function stdDev(values) {
  const xs = values.filter((v) => v != null && !isNaN(v));
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((acc, v) => acc + (v - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function describe(values, decimals = 2) {
  const xs = values.filter((v) => v != null && !isNaN(v));
  if (!xs.length) return { n: 0, mean: null, median: null, sd: null, p25: null, p75: null };
  return {
    n: xs.length,
    mean: round(mean(xs), decimals),
    median: round(median(xs), decimals),
    sd: round(stdDev(xs), decimals),
    p25: round(quantile(xs, 0.25), decimals),
    p75: round(quantile(xs, 0.75), decimals),
    min: round(Math.min(...xs), decimals),
    max: round(Math.max(...xs), decimals),
  };
}

export function countBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key == null) continue;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

export function mapToRows(map, keyName = "key", valueName = "count") {
  return [...map.entries()].map(([k, v]) => ({ [keyName]: k, [valueName]: v }));
}

export function histogram(values, { min, max, bins = 20 }) {
  const xs = values.filter((v) => v != null && !isNaN(v));
  if (!xs.length) return [];
  const lo = min != null ? min : Math.min(...xs);
  const hi = max != null ? max : Math.max(...xs);
  const width = (hi - lo) / bins;
  if (!(width > 0)) return [];
  const counts = new Array(bins).fill(0);
  for (const x of xs) {
    let idx = Math.floor((x - lo) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    counts[idx] += 1;
  }
  return counts.map((count, i) => ({
    from: round(lo + i * width, 2),
    to: round(lo + (i + 1) * width, 2),
    count,
  }));
}

export function quarterOf(dateStr) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split("-").map(Number);
  if (!y || !m) return null;
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

export function monthOf(dateStr) {
  if (!dateStr) return null;
  return dateStr.slice(0, 7);
}
