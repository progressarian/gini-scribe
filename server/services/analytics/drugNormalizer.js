import { DRUG_PATTERNS, CATEGORY_PATTERNS } from "../../config/medicationCategories.js";

const NOISE_TOKENS = new Set([
  "inj",
  "injection",
  "injections",
  "injectable",
  "injectionable",
  "injected",
  "injective",
  "injector",
  "injction",
  "tab",
  "tabs",
  "tablet",
  "tablets",
  "cap",
  "caps",
  "capsule",
  "pen",
  "sc",
  "subcut",
  "subcutaneous",
  "oral",
  "orally",
  "mg",
  "mcg",
  "ml",
  "iu",
  "unit",
  "units",
  "once",
  "twice",
  "weekly",
  "week",
  "daily",
  "day",
  "od",
  "bd",
  "tds",
  "qid",
  "sos",
  "hs",
  "am",
  "pm",
  "before",
  "after",
  "food",
  "meal",
  "meals",
  "breakfast",
  "dinner",
  "lunch",
  "and",
  "with",
  "the",
  "for",
  "agonist",
  "analogue",
]);

const MOLECULES = [
  {
    key: "tirzepatide",
    label: "Tirzepatide",
    className: "GLP-1/GIP",
    incretin: true,
    defaultRoute: "injectable",
    aliases: [
      "tirzepatide",
      "mounjaro",
      "mounjero",
      "monjaro",
      "monjouro",
      "monjauro",
      "monjero",
      "mounjao",
      "zepbound",
    ],
    fuzzy: ["tirzepatide", "mounjaro", "zepbound"],
  },
  {
    key: "semaglutide_oral",
    label: "Semaglutide (oral)",
    className: "GLP-1",
    incretin: true,
    defaultRoute: "oral",
    aliases: ["rybelsus"],
    fuzzy: ["rybelsus"],
  },
  {
    key: "semaglutide_inj",
    label: "Semaglutide (injectable)",
    className: "GLP-1",
    incretin: true,
    defaultRoute: "injectable",
    aliases: [
      "semaglutide",
      "ozempic",
      "wegovy",
      "semanex",
      "semanext",
      "semaglow",
      "erly",
      "gliptoza",
      "jampi",
      "oxemia",
    ],
    fuzzy: ["semaglutide", "ozempic", "wegovy", "semanext", "erly", "gliptoza"],
  },
  {
    key: "liraglutide",
    label: "Liraglutide",
    className: "GLP-1",
    incretin: true,
    defaultRoute: "injectable",
    aliases: ["liraglutide", "victoza", "saxenda", "lirafit"],
    fuzzy: ["liraglutide", "victoza", "saxenda", "lirafit"],
  },
  {
    key: "dulaglutide",
    label: "Dulaglutide",
    className: "GLP-1",
    incretin: true,
    defaultRoute: "injectable",
    aliases: ["dulaglutide", "trulicity"],
    fuzzy: ["dulaglutide", "trulicity"],
  },
  {
    key: "exenatide",
    label: "Exenatide",
    className: "GLP-1",
    incretin: true,
    defaultRoute: "injectable",
    aliases: ["exenatide", "byetta", "bydureon"],
    fuzzy: ["exenatide", "byetta", "bydureon"],
  },
];

const GLP1_HINTS = [/\bglp[\s-]?1\b/i, /\bglp1ra?\b/i, /\bincretin\b/i];

const LOCAL_BRANDS = {
  statin: /\b(atchol|lipvas|tonact|storvas|atorlip|rozat|rosufit|liponorm)\b/i,
  biguanide:
    /\b(glycomet|gluconorm|carbophage|glyciphage|melmet|bigomet|exermet|riomet|obimet|walaphage|reclimet)\b/i,
  sglt2i: /\b(daplo|dapanorm|oxra|dapastar|udapa|glyxambi|forziga)\b/i,
  dpp4i: /\b(sitacip|linaxa|sitara|dynaglipt|linsipt)\b/i,
  sulfonylurea: /\b(glizid|zoryl|glimisave|glimestar)\b/i,
  ccb: /\b(cilacar|amlogard|stamlo)\b/i,
  renin_angiotensin: /\b(telvas|telmichek|olmesave|eritel)\b/i,
  antiplatelet: /\b(ecospirin|ecosprin|deplatt)\b/i,
  diuretic: /\b(dytor|lasilactone|aldactone)\b/i,
  supplement: /\b(aktiv|maxmala|racal|nefcm|amla candy|onecan)\b/i,
};

const METFORMIN_FDC =
  /\b(glizid|diamicron|daplo|dapanorm|reclimet|sitacip|linaxa|oxra|gluconorm|zoryl|amaryl|glycomet|janumet|jalra|galvus|zita|istamet|synjardy|xigduo|invokamet|gemer|triglimisave)\b[^a-z]*\b(m|met|mex|dm|trio|sm|forte|gp)\b/i;

const SUPPORT_MEDS = {
  antiemetic: /\b(emset|ondansetron|vomikind|perinorm|domstal)\b/i,
  acid_suppression: /\b(rantac|ranitidine|pantop|pantoprazole|razo|rabeprazole|omez)\b/i,
  antidiarrhoeal: /\b(roko|loperamide|eldoper)\b/i,
  nausea_adjunct: /\b(amla candy|ginger)\b/i,
};

const COMPARATOR_CLASSES = [
  { key: "sglt2i", label: "SGLT2 inhibitor", pattern: DRUG_PATTERNS.sglt2 },
  { key: "dpp4i", label: "DPP-4 inhibitor", pattern: DRUG_PATTERNS.dpp4 },
  { key: "sulfonylurea", label: "Sulfonylurea", pattern: DRUG_PATTERNS.su },
  { key: "biguanide", label: "Metformin", pattern: DRUG_PATTERNS.metformin },
  { key: "insulin", label: "Insulin", pattern: DRUG_PATTERNS.insulin },
  { key: "tzd", label: "Pioglitazone", pattern: DRUG_PATTERNS.pioglitazone },
  { key: "agi", label: "Alpha-glucosidase inhibitor", pattern: DRUG_PATTERNS.acarbose },
  { key: "statin", label: "Statin", pattern: CATEGORY_PATTERNS.lipids },
  { key: "renin_angiotensin", label: "ACEi / ARB", pattern: CATEGORY_PATTERNS.kidney },
  { key: "thyroid_hormone", label: "Thyroid hormone", pattern: CATEGORY_PATTERNS.thyroid },
];

const STATIN_ONLY =
  /\b(rosuvastatin|atorvastatin|simvastatin|pravastatin|crestor|rozavel|lipitor|storvas|rosuvas|rosulip|atorva|lipitas|statin)\b/i;

const RAW_CLASS_MAP = {
  biguanide: "biguanide",
  statin: "statin",
  sulfonylurea: "sulfonylurea",
  arb: "renin_angiotensin",
  ace: "renin_angiotensin",
  acei: "renin_angiotensin",
  sglt2i: "sglt2i",
  dpp4i: "dpp4i",
  "glp-1 ra": "glp1",
  tzd: "tzd",
  ccb: "ccb",
  "beta blocker": "beta_blocker",
  antiplatelet: "antiplatelet",
  ppi: "ppi",
  "thyroid hormone": "thyroid_hormone",
  supplement: "supplement",
  "alpha-glucosidase inhibitor": "agi",
  "alpha blocker": "alpha_blocker",
  "loop diuretic": "diuretic",
  thiazide: "diuretic",
  gabapentinoid: "gabapentinoid",
  antibiotic: "antibiotic",
  antifungal: "antifungal",
  corticosteroid: "corticosteroid",
  antiemetic: "antiemetic",
  "xanthine oxidase inhibitor": "urate_lowering",
  other: "other",
};

const RAW_CLASS_COMPONENTS = {
  "insulin-premix": ["insulin"],
  "insulin-basal": ["insulin"],
  "insulin-bolus": ["insulin"],
  insulin: ["insulin"],
};

export function normalizeStoredClass(rawClass) {
  const raw = (rawClass || "").trim().toLowerCase();
  if (!raw) return [];
  if (RAW_CLASS_COMPONENTS[raw]) return RAW_CLASS_COMPONENTS[raw];
  if (raw.includes("+")) {
    return raw
      .split("+")
      .map((part) => RAW_CLASS_MAP[part.trim()] || null)
      .filter(Boolean);
  }
  const mapped = RAW_CLASS_MAP[raw];
  return mapped ? [mapped] : [];
}

export const MOLECULE_KEYS = MOLECULES.map((m) => m.key);

export const INCRETIN_MOLECULES = MOLECULES.filter((m) => m.incretin).map((m) => m.key);

export const MOLECULE_LABELS = MOLECULES.reduce((acc, m) => {
  acc[m.key] = m.label;
  return acc;
}, {});

export const COMPARATOR_LABELS = COMPARATOR_CLASSES.reduce((acc, c) => {
  acc[c.key] = c.label;
  return acc;
}, {});

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function tolerance(token) {
  return token.length <= 6 ? 1 : 2;
}

export function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !NOISE_TOKENS.has(t) && !/^[0-9]/.test(t) && t.length > 2);
}

function haystackOf(med) {
  return [med?.name, med?.composition, med?.pharmacy_match].filter(Boolean).join(" ");
}

function matchMolecule(haystack, tokens) {
  const lower = haystack.toLowerCase();
  for (const spec of MOLECULES) {
    for (const alias of spec.aliases) {
      if (lower.includes(alias)) return { spec, brand: alias, matched: "alias" };
    }
  }
  for (const spec of MOLECULES) {
    for (const target of spec.fuzzy) {
      for (const token of tokens) {
        if (token.length < 5) continue;
        if (editDistance(token, target) <= tolerance(target)) {
          return { spec, brand: target, matched: "fuzzy" };
        }
      }
    }
  }
  return null;
}

function detectRoute(spec, haystack) {
  const lower = haystack.toLowerCase();
  if (spec.key === "semaglutide_oral") return "oral";
  if (/\b(inj|injection|injections|injectable|injected|sc|subcut|pen)\b/.test(lower)) {
    return "injectable";
  }
  if (/\b(tab|tabs|tablet|tablets|oral)\b/.test(lower)) return "oral";
  return spec.defaultRoute;
}

function detectComparatorClasses(haystack) {
  const lower = haystack.toLowerCase();
  const found = new Set();
  for (const c of COMPARATOR_CLASSES) {
    if (c.key === "statin") continue;
    if (c.pattern && c.pattern.test(lower)) found.add(c.key);
  }
  if (STATIN_ONLY.test(lower)) found.add("statin");
  for (const [key, pattern] of Object.entries(LOCAL_BRANDS)) {
    if (pattern.test(lower)) found.add(key);
  }
  if (METFORMIN_FDC.test(lower)) found.add("biguanide");
  return [...found];
}

export function detectSupportMed(med) {
  const lower = haystackOf(med).toLowerCase();
  for (const [key, pattern] of Object.entries(SUPPORT_MEDS)) {
    if (pattern.test(lower)) return key;
  }
  return null;
}

export function normalizeDrug(med) {
  const haystack = haystackOf(med);
  if (!haystack.trim()) {
    return {
      molecule: null,
      moleculeLabel: null,
      brand: null,
      classes: [],
      className: null,
      route: null,
      isIncretin: false,
      matched: "empty",
    };
  }
  const tokens = tokenize(haystack);
  const hit = matchMolecule(haystack, tokens);

  if (hit) {
    let key = hit.spec.key;
    const route = detectRoute(hit.spec, haystack);
    if (key === "semaglutide_inj" && route === "oral" && /semaglutide/i.test(haystack)) {
      key = "semaglutide_oral";
    }
    return {
      molecule: key,
      moleculeLabel: MOLECULE_LABELS[key],
      brand: hit.brand,
      classes: ["glp1"],
      className: "glp1",
      route,
      isIncretin: true,
      matched: hit.matched,
    };
  }

  const declaredGlp1 =
    /glp/i.test(med?.drug_class || "") || GLP1_HINTS.some((p) => p.test(haystack));
  if (declaredGlp1) {
    return {
      molecule: "glp1_unspecified",
      moleculeLabel: "GLP-1 (molecule not identified)",
      brand: null,
      classes: ["glp1"],
      className: "glp1",
      route: detectRoute({ key: "glp1_unspecified", defaultRoute: null }, haystack),
      isIncretin: true,
      matched: "declared_class",
    };
  }

  const byPattern = detectComparatorClasses(haystack);
  if (byPattern.length) {
    return {
      molecule: null,
      moleculeLabel: null,
      brand: null,
      classes: byPattern,
      className: byPattern[0],
      route: null,
      isIncretin: false,
      matched: "class_pattern",
    };
  }

  const byStored = normalizeStoredClass(med?.drug_class);
  if (byStored.length) {
    return {
      molecule: null,
      moleculeLabel: null,
      brand: null,
      classes: byStored,
      className: byStored[0],
      route: null,
      isIncretin: false,
      matched: "stored_class",
    };
  }

  return {
    molecule: null,
    moleculeLabel: null,
    brand: null,
    classes: [],
    className: null,
    route: null,
    isIncretin: false,
    matched: "unmatched",
  };
}

export function summariseUnmatched(rows, minCount = 2) {
  const counts = new Map();
  for (const row of rows) {
    const result = normalizeDrug(row);
    if (result.matched !== "unmatched" && result.matched !== "declared_class") continue;
    const label = (row.name || "").trim().toUpperCase();
    if (!label) continue;
    const entry = counts.get(label) || { name: label, rows: 0, patients: new Set() };
    entry.rows += 1;
    if (row.patient_id != null) entry.patients.add(row.patient_id);
    counts.set(label, entry);
  }
  return [...counts.values()]
    .map((e) => ({ name: e.name, rows: e.rows, patients: e.patients.size }))
    .filter((e) => e.rows >= minCount)
    .sort((a, b) => b.rows - a.rows);
}
