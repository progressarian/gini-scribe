import { readFileSync } from "node:fs";
import { canonicalMedKey } from "../medication/normalize.js";
import { stockItemKey } from "./stockParse.js";

const MEDICINE_DB_PATH = new URL("../../../src/medicine_db.json", import.meta.url);

let catalog = null;

function loadCatalog() {
  if (catalog) return catalog;
  try {
    const entries = JSON.parse(readFileSync(MEDICINE_DB_PATH, "utf8"));
    catalog = {
      byRaw: new Map(entries.map((e) => [stockItemKey(e.raw), e.brand])),
      brands: [...new Set(entries.map((e) => String(e.brand || "").trim()).filter(Boolean))],
    };
  } catch {
    catalog = { byRaw: new Map(), brands: [] };
  }
  return catalog;
}

export const medicineKey = (name) => canonicalMedKey(name);

const keyVariants = (name) => {
  const plain = stockItemKey(name);
  const canonical = medicineKey(name);
  return [...new Set([canonical, plain].filter(Boolean))];
};

export function autoLinkKeys(itemName) {
  const brand = loadCatalog().byRaw.get(stockItemKey(itemName));
  const fromCatalog = brand ? keyVariants(brand) : [];
  const identity = keyVariants(itemName).filter((k) => !fromCatalog.includes(k));
  return [
    ...fromCatalog.map((key) => ({ key, status: "auto" })),
    ...identity.map((key) => ({ key, status: "identity" })),
  ];
}

export const hasCatalogMatch = (itemName) => loadCatalog().byRaw.has(stockItemKey(itemName));

const PACK_TOKENS = new Set([
  "TAB",
  "TABS",
  "TABLET",
  "TABLETS",
  "CAP",
  "CAPS",
  "CAPSULE",
  "INJ",
  "INJECTION",
  "SYP",
  "SYRUP",
  "X",
  "S",
  "STRIP",
  "PACK",
  "BOX",
  "KIT",
  "NOS",
  "OF",
]);

const tokensOf = (name) =>
  stockItemKey(name)
    .replace(/(\d+)\s*[*X]\s*(\d+)/g, " ")
    .replace(/[^A-Z0-9.%]+/g, " ")
    .split(" ")
    .filter((t) => t && !PACK_TOKENS.has(t) && !/^\d+S$/.test(t));

const numbersOf = (tokens) => tokens.map((t) => (t.match(/^\d+(\.\d+)?/) || [])[0]).filter(Boolean);

function score(itemTokens, candidate) {
  const candTokens = tokensOf(candidate);
  if (!candTokens.length || !itemTokens.length) return 0;
  const itemNums = numbersOf(itemTokens);
  const candNums = numbersOf(candTokens);
  if (candNums.length && itemNums.length && !candNums.every((n) => itemNums.includes(n))) return 0;
  if (itemTokens[0] !== candTokens[0] && !candTokens.includes(itemTokens[0])) return 0;
  const words = (ts) => new Set(ts.filter((t) => !/^\d/.test(t)));
  const a = words(itemTokens);
  const b = words(candTokens);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = new Set([...a, ...b]).size || 1;
  const numBonus = itemNums.length && candNums.length ? 0.2 : 0;
  return shared / union + numBonus;
}

export function suggestMatches(itemName, prescribedNames = [], limit = 6) {
  const itemTokens = tokensOf(itemName);
  const seen = new Set();
  const scored = [];
  for (const candidate of [...loadCatalog().brands, ...prescribedNames]) {
    const key = medicineKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const s = score(itemTokens, candidate);
    if (s >= 0.34)
      scored.push({ name: candidate, medicineKey: key, score: Math.round(s * 100) / 100 });
  }
  return scored.sort((x, y) => y.score - x.score || x.name.length - y.name.length).slice(0, limit);
}
