export const STATUS_TEXT = {
  ready: "Ready",
  override: "Needs override",
  failed: "Failed",
  unchanged: "Unchanged",
};

export const OUTCOME_TEXT = {
  saved: "Saved",
  kept: "Kept",
  failed: "Failed",
  unchanged: "Unchanged",
};

export const DECISION_TEXT = {
  pending: "Undecided — will be kept",
  override: "Override — will be saved",
  keep: "Keep — stays as it is",
};

export const TONE = {
  ready: "new",
  saved: "new",
  override: "update",
  kept: "update",
  failed: "error",
  unchanged: "unchanged",
};

export const when = (value) =>
  new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export const shown = (value) =>
  value === null || value === undefined || value === ""
    ? "blank"
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);

export const typed = (text) => (text === undefined || text === "" ? "nothing" : `"${text}"`);

export const ordered = (counts, text) => {
  const known = Object.keys(text);
  const rank = (key) => (known.includes(key) ? known.indexOf(key) : known.length);
  return Object.keys(counts ?? {})
    .filter((key) => key !== "all")
    .sort((a, b) => rank(a) - rank(b));
};

export const labelOf = (key, text) => text[key] ?? key;

export const saveBlob = ({ blob, fileName }) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
