export const localDate = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const showDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

export const inr = (n) => {
  const value = Number(n || 0);
  const text = Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? "−" : ""}₹${text}`;
};

const plural = (n, word) => (n === 1 || word.endsWith("s") ? word : `${word}s`);

export function packUnits(units, { pack_size, pack_label, unit_label }) {
  const total = Number(units || 0);
  const size = Number(pack_size || 1);
  if (size <= 1)
    return `${total.toLocaleString("en-IN")} ${plural(total, pack_label === "unit" ? unit_label : pack_label)}`;
  const packs = Math.floor(total / size);
  const loose = total % size;
  const parts = [];
  if (packs) parts.push(`${packs.toLocaleString("en-IN")} ${plural(packs, pack_label)}`);
  if (loose || !packs) parts.push(`${loose} ${unit_label}`);
  return parts.join(" + ");
}
