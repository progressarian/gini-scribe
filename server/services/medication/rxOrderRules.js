import pool from "../../config/db.js";
import {
  MED_CATEGORIES,
  DRUG_PATTERNS,
  CATEGORY_PATTERNS,
  DIABETES_CLASS_RANK,
  DEFAULT_CATEGORY,
  GENERIC_CATEGORIES,
} from "../../config/medicationCategories.js";

const KEY = "rx_medicine_order";
const TTL_MS = 60_000;
const MAX_CATEGORIES = 40;
const MAX_CLASSES = 120;
const MAX_PINS = 500;
const MAX_KEYWORDS = 200;

const CLASS_LABELS = {
  insulin: "Insulin",
  metformin: "Metformin",
  sglt2: "SGLT2 inhibitor",
  glp1: "GLP-1 agonist",
  dpp4: "DPP-4 inhibitor",
  su: "Sulphonylurea",
  pioglitazone: "Pioglitazone",
  acarbose: "Acarbose / Voglibose",
};

const keywordsOf = (pattern) =>
  pattern
    ? pattern.source
        .replace(/^\\b\(/, "")
        .replace(/\)\\b$/, "")
        .split("|")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

const classRank = (id) => DIABETES_CLASS_RANK[id] ?? DIABETES_CLASS_RANK.other;

export const DEFAULT_RX_ORDER = Object.freeze({
  categories: MED_CATEGORIES.filter((c) => c.id !== "external").map((c) => ({
    id: c.id,
    label: c.label,
    keywords: keywordsOf(CATEGORY_PATTERNS[c.id]),
  })),
  classes: Object.keys(DRUG_PATTERNS)
    .sort((a, b) => classRank(a) - classRank(b))
    .map((id) => ({
      id,
      category: "diabetes",
      label: CLASS_LABELS[id] || id,
      keywords: keywordsOf(DRUG_PATTERNS[id]),
    })),
  pins: [],
});

const text = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

const slug = (v) =>
  text(v, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const cleanKeywords = (list) => [
  ...new Set(
    (Array.isArray(list) ? list : [])
      .map((k) => text(k, 60).toLowerCase())
      .filter(Boolean)
      .slice(0, MAX_KEYWORDS),
  ),
];

const uniqueId = (wanted, taken) => {
  const base = wanted || "group";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  taken.add(id);
  return id;
};

export function normalizeRxOrder(raw) {
  if (!raw || typeof raw !== "object") return DEFAULT_RX_ORDER;
  const categoryIds = new Set();
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .slice(0, MAX_CATEGORIES)
    .map((c) => ({ label: text(c?.label, 80), id: slug(c?.id || c?.label), keywords: c?.keywords }))
    .filter((c) => c.label)
    .map((c) => ({
      id: uniqueId(c.id, categoryIds),
      label: c.label,
      keywords: cleanKeywords(c.keywords),
    }));
  if (!categoryIds.has(DEFAULT_CATEGORY)) {
    categories.push({ id: DEFAULT_CATEGORY, label: "Other", keywords: [] });
    categoryIds.add(DEFAULT_CATEGORY);
  }

  const classIds = new Set();
  const classes = (Array.isArray(raw.classes) ? raw.classes : [])
    .slice(0, MAX_CLASSES)
    .map((c) => ({
      label: text(c?.label, 80),
      id: slug(c?.id || c?.label),
      category: text(c?.category, 60),
      keywords: c?.keywords,
    }))
    .filter((c) => c.label && categoryIds.has(c.category))
    .map((c) => ({
      id: uniqueId(c.id, classIds),
      category: c.category,
      label: c.label,
      keywords: cleanKeywords(c.keywords),
    }));

  const pinned = new Set();
  const pins = (Array.isArray(raw.pins) ? raw.pins : [])
    .slice(0, MAX_PINS)
    .map((p) => ({
      medicine: text(p?.medicine, 120),
      category: text(p?.category, 60),
      position: Math.max(1, Math.min(999, Math.trunc(Number(p?.position)) || 1)),
    }))
    .filter((p) => {
      const key = p.medicine.toUpperCase();
      if (!p.medicine || !categoryIds.has(p.category) || pinned.has(key)) return false;
      pinned.add(key);
      return true;
    });

  return { categories, classes, pins };
}

let cache = null;
let cachedAt = 0;

export async function getRxOrderRules({ fresh = false, db = pool } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const { rows } = await db.query("SELECT value FROM app_kv WHERE key = $1", [KEY]);
  cache = rows[0]?.value ? normalizeRxOrder(rows[0].value) : DEFAULT_RX_ORDER;
  cachedAt = Date.now();
  return cache;
}

export async function setRxOrderRules(next, actorId = null, db = pool) {
  const value = normalizeRxOrder(next);
  await db.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(value)],
  );
  await db.query(
    `INSERT INTO audit_log (doctor_id, action, entity_type, details)
     VALUES ($1, 'update_rx_order', 'settings', $2::jsonb)`,
    [
      actorId,
      JSON.stringify({
        categories: value.categories.map((c) => c.id),
        classes: value.classes.length,
        pins: value.pins.length,
      }),
    ],
  );
  cache = value;
  cachedAt = Date.now();
  return value;
}

export async function resetRxOrderRules(actorId = null, db = pool) {
  await db.query("DELETE FROM app_kv WHERE key = $1", [KEY]);
  await db.query(
    `INSERT INTO audit_log (doctor_id, action, entity_type, details)
     VALUES ($1, 'reset_rx_order', 'settings', '{}'::jsonb)`,
    [actorId],
  );
  cache = DEFAULT_RX_ORDER;
  cachedAt = Date.now();
  return cache;
}

export const isGenericCategory = (id) => GENERIC_CATEGORIES.has(id);
