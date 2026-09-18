import pool from "../../config/db.js";

const IST_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const indiaToday = (now = new Date()) => IST_DATE.format(now);

export function normalizeGender(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return null;
  if (text === "m" || text === "male") return "Male";
  if (text === "f" || text === "female") return "Female";
  return "Other";
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})/;

export function ageOn(dob, date) {
  const born = DATE_TEXT.exec(typeof dob === "string" ? dob : "");
  const on = DATE_TEXT.exec(date);
  if (!born || !on) return null;
  const [, by, bm, bd] = born.map(Number);
  const [, y, m, d] = on.map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age >= 0 ? age : null;
}

function patientFacts(patient, date) {
  const fromDob = ageOn(patient?.dob, date);
  const recorded = Number.isInteger(patient?.age) ? patient.age : null;
  return {
    age: fromDob ?? recorded,
    ageSource: fromDob !== null ? "date_of_birth" : recorded !== null ? "recorded_age" : null,
    gender: normalizeGender(patient?.sex),
    hasCard: typeof patient?.scheme_ref === "string" && patient.scheme_ref.trim() !== "",
  };
}

export async function loadResolverData(db = pool) {
  const { rows: schemes } = await db.query(
    `SELECT s.code, s.label, s.parent_code, s.payer_name, s.requires_ref,
            s.is_active AND COALESCE(p.is_active, TRUE) AS active,
            s.requires_ref OR COALESCE(p.requires_ref, FALSE) AS needs_card,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS display_label,
            EXISTS (SELECT 1 FROM patient_schemes c WHERE c.parent_code = s.code AND c.is_active)
              AS has_children
       FROM patient_schemes s
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
      ORDER BY s.sort_order, s.label, s.code`,
  );
  const { rows: rules } = await db.query(
    `SELECT id, scheme_code, name, min_age, max_age, gender, requires_card, mode, priority
       FROM category_rules
      WHERE is_active
      ORDER BY priority, id`,
  );
  return { schemes: new Map(schemes.map((s) => [s.code, s])), rules };
}

const describe = (scheme) =>
  scheme && {
    code: scheme.code,
    label: scheme.label,
    display_label: scheme.display_label,
    parent_code: scheme.parent_code,
    payer_name: scheme.payer_name,
  };

function matches(rule, facts) {
  if (rule.min_age !== null && (facts.age === null || facts.age < rule.min_age)) return false;
  if (rule.max_age !== null && (facts.age === null || facts.age > rule.max_age)) return false;
  if (rule.gender !== null && facts.gender !== rule.gender) return false;
  if (rule.requires_card && !facts.hasCard) return false;
  return true;
}

function explicitCategory(patient, appointment) {
  const fromAppointment = appointment?.patient_category?.trim?.();
  if (fromAppointment) return { code: fromAppointment, source: "appointment" };
  const fromPatient = patient?.scheme_code?.trim?.();
  if (fromPatient) return { code: fromPatient, source: "patient" };
  return null;
}

export function resolveCategory({ patient, appointment, date = indiaToday() }, data) {
  const facts = patientFacts(patient, date);
  const warnings = [];
  const parentOf = (scheme) => (scheme?.parent_code ? data.schemes.get(scheme.parent_code) : null);
  const result = (scheme, source, extra = {}) => ({
    category: describe(scheme),
    parent: describe(parentOf(scheme)),
    source,
    rule: null,
    suggestions: [],
    needs_sub_category: false,
    age: facts.age,
    age_source: facts.ageSource,
    warnings,
    ...extra,
  });

  const recorded = explicitCategory(patient, appointment);
  if (recorded) {
    const scheme = data.schemes.get(recorded.code);
    if (scheme?.active) {
      if (!scheme.has_children) return result(scheme, recorded.source);
      const subs = [...data.schemes.values()]
        .filter((s) => s.parent_code === scheme.code && s.active)
        .map((s) => ({ category: describe(s), rule: null, reason: "choose_sub_category" }));
      return result(scheme, recorded.source, { needs_sub_category: true, suggestions: subs });
    }
    warnings.push(
      scheme
        ? `The recorded category ${scheme.display_label} is retired, so it was not used`
        : `The recorded category "${recorded.code}" doesn't exist, so it was not used`,
    );
  }

  const suggestions = [];
  const suggest = (scheme, rule, reason) => {
    if (suggestions.some((s) => s.category.code === scheme.code)) return;
    suggestions.push({
      category: describe(scheme),
      rule: { id: rule.id, name: rule.name },
      reason,
    });
  };
  let chosen = null;
  for (const rule of data.rules) {
    const scheme = data.schemes.get(rule.scheme_code);
    if (!scheme?.active || !matches(rule, facts)) continue;
    if (scheme.has_children) {
      suggest(scheme, rule, "move_rule_to_sub_category");
      continue;
    }
    if (rule.mode === "auto" && !chosen) {
      if (scheme.needs_card && !facts.hasCard) {
        suggest(scheme, rule, "needs_card");
        continue;
      }
      chosen = { scheme, rule };
      continue;
    }
    if (chosen?.scheme.code === scheme.code) continue;
    suggest(scheme, rule, rule.mode === "auto" ? "lower_priority_auto_rule" : "suggest_rule");
  }

  if (chosen) {
    return result(chosen.scheme, "rule", {
      rule: { id: chosen.rule.id, name: chosen.rule.name },
      suggestions: suggestions.filter((s) => s.category.code !== chosen.scheme.code),
    });
  }
  return { ...result(null, "general"), suggestions };
}

export async function resolveCategoryFor(input, db = pool) {
  return resolveCategory(input, await loadResolverData(db));
}
