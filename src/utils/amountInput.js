const TWO_PLACES = /^(\d*\.?\d{0,2}).*$/;

export const cleanAmount = (raw, max = Infinity) => {
  const text = String(raw ?? "")
    .replace(/[^\d.]/g, "")
    .replace(/^(\d*\.)(.*)$/, (_, head, tail) => head + tail.replace(/\./g, ""))
    .replace(TWO_PLACES, "$1");
  if (text === "" || text === ".") return text;
  const cap = Math.max(0, Math.round(Number(max) * 100) / 100);
  return Number(text) > cap ? String(cap) : text;
};

export const amountLeft = (max, used) =>
  Math.max(0, Math.round((Number(max) - (Number(used) || 0)) * 100) / 100);
