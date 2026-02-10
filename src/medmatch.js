// Medicine Fuzzy Matcher — matches AI-extracted names to Gini pharmacy brands
import PHARMACY_DB from "./medicine_db.json";

// Build search index once on load
const MEDS_INDEX = PHARMACY_DB
  .filter(m => ["tablet","capsule","injection","syrup","cream","gel","drops","inhaler","ointment","suspension","powder","lotion"].includes(m.form))
  .map(m => ({
    raw: m.raw,
    brand: m.brand,
    form: m.form,
    dose: m.dose,
    // Normalized tokens for matching
    tokens: normalize(m.brand).split(/\s+/),
    norm: normalize(m.brand)
  }));

function normalize(s) {
  return (s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s.]/g, " ")
    .replace(/\bTAB\b|\bCAP\b|\bINJ\b|\bSYP\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance
function lev(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

// Score a pharmacy item against a query
function score(query, item) {
  const qNorm = normalize(query);
  const qTokens = qNorm.split(/\s+/);
  
  // Exact match
  if (item.norm === qNorm) return 100;
  
  // Starts with same word
  if (item.tokens[0] === qTokens[0]) {
    // First word matches exactly — strong signal
    const editDist = lev(qNorm, item.norm);
    const maxLen = Math.max(qNorm.length, item.norm.length);
    const similarity = ((maxLen - editDist) / maxLen) * 100;
    return similarity + 20; // bonus for first-word match
  }
  
  // Check if query contains any token from the pharmacy item
  const tokenOverlap = item.tokens.filter(t => t.length > 2 && qTokens.some(q => q === t || lev(q, t) <= 1)).length;
  if (tokenOverlap > 0) {
    const editDist = lev(qNorm, item.norm);
    const maxLen = Math.max(qNorm.length, item.norm.length);
    const similarity = ((maxLen - editDist) / maxLen) * 100;
    return similarity + (tokenOverlap * 10);
  }
  
  // Fuzzy on full string
  const editDist = lev(qNorm, item.norm);
  const maxLen = Math.max(qNorm.length, item.norm.length);
  return ((maxLen - editDist) / maxLen) * 100;
}

// Find best pharmacy match for a medicine name
export function matchMedicine(name) {
  if (!name || name.length < 2) return null;
  
  let bestScore = 0;
  let bestMatch = null;
  
  for (const item of MEDS_INDEX) {
    const s = score(name, item);
    if (s > bestScore) {
      bestScore = s;
      bestMatch = item;
    }
  }
  
  // Only return if confidence is decent (>60%)
  if (bestScore > 60 && bestMatch) {
    return {
      matched: bestMatch.raw,
      brand: bestMatch.brand,
      form: bestMatch.form,
      dose: bestMatch.dose,
      confidence: Math.round(bestScore)
    };
  }
  return null;
}

// Fix all medicines in MO data
export function fixMoMedicines(moData) {
  if (!moData) return moData;
  const fixed = { ...moData };
  
  if (Array.isArray(fixed.previous_medications)) {
    fixed.previous_medications = fixed.previous_medications.map(m => {
      const match = matchMedicine(m.name);
      if (match && match.confidence > 65) {
        return { ...m, name: match.brand, _matched: match.matched, _confidence: match.confidence };
      }
      return m;
    });
  }
  return fixed;
}

// Fix all medicines in Consultant data
export function fixConMedicines(conData) {
  if (!conData) return conData;
  const fixed = { ...conData };
  
  if (Array.isArray(fixed.medications_confirmed)) {
    fixed.medications_confirmed = fixed.medications_confirmed.map(m => {
      const match = matchMedicine(m.name);
      if (match && match.confidence > 65) {
        return { ...m, name: match.brand, _matched: match.matched, _confidence: match.confidence };
      }
      return m;
    });
  }
  return fixed;
}

// Fix medicines in Quick Mode data (both mo and consultant)
export function fixQuickMedicines(data) {
  if (!data) return data;
  const fixed = { ...data };
  if (fixed.mo) fixed.mo = fixMoMedicines(fixed.mo);
  if (fixed.consultant) fixed.consultant = fixConMedicines(fixed.consultant);
  return fixed;
}

// Export for debugging / UI
export function searchPharmacy(query, limit = 10) {
  if (!query || query.length < 2) return [];
  return MEDS_INDEX
    .map(item => ({ ...item, score: score(query, item) }))
    .filter(x => x.score > 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => ({ name: x.raw, brand: x.brand, form: x.form, dose: x.dose, score: x.score }));
}
