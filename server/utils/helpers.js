export const n = (v) => (v === "" || v === undefined || v === null ? null : v);
export const num = (v) => {
  const x = parseFloat(v);
  return isNaN(x) ? null : x;
};
export const int = (v) => {
  const x = parseInt(v);
  return isNaN(x) ? null : x;
};
export const safeJson = (v) => {
  try {
    return v ? JSON.stringify(v) : null;
  } catch {
    return null;
  }
};
export const t = (v, max = 500) => {
  const s = n(v);
  return s && s.length > max ? s.slice(0, max) : s;
};
