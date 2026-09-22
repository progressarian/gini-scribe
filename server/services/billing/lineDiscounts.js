import { DISCOUNT_KINDS, STACKING_MODES } from "../../../shared/billingVocab.js";
import { paise } from "../../../shared/labPayment.js";

const refuse = (message) => Object.assign(new Error(message), { status: 400 });

const percentOf = (remaining, value) => {
  const hundredths = BigInt(Math.round(Number(value) * 100));
  return Number((BigInt(remaining) * hundredths + 5000n) / 10000n);
};

const numeric = (value) =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value));

function takes(rule, remaining, quantity) {
  let amount = 0;
  if (rule.kind === "percent") {
    amount = percentOf(remaining, rule.value);
    if (rule.max_discount != null) amount = Math.min(amount, paise(rule.max_discount));
  } else if (rule.kind === "flat") {
    amount = paise(rule.value);
  } else {
    amount = remaining - Math.round(paise(rule.value) * quantity);
  }
  return Math.max(0, Math.min(remaining, amount));
}

const byPriority = (a, b) =>
  Number(a.priority ?? 0) - Number(b.priority ?? 0) || Number(a.id) - Number(b.id);

function largest(rules, remaining, quantity) {
  let best = null;
  for (const rule of [...rules].sort(byPriority)) {
    const amount = takes(rule, remaining, quantity);
    if (amount > 0 && (!best || amount > best.amount)) best = { rule, amount };
  }
  return best;
}

const applied = ({ rule, amount }) => ({
  rule_id: rule.id,
  code: rule.code ?? null,
  name: rule.name,
  kind: rule.kind,
  value: Number(rule.value),
  amount,
});

function checkInput({ actual, quantity, rules, stacking }) {
  if (!Number.isSafeInteger(actual) || actual < 0) {
    throw refuse("The line amount must be a whole number of paise, 0 or more");
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    throw refuse("Quantity must be a number more than 0");
  }
  if (!Array.isArray(rules)) throw refuse("Discount rules must be a list");
  if (!STACKING_MODES.includes(stacking)) {
    throw refuse(`Discount stacking must be one of: ${STACKING_MODES.join(", ")}`);
  }
  for (const rule of rules) {
    if (!DISCOUNT_KINDS.includes(rule?.kind)) {
      throw refuse(`Discount kind must be one of: ${DISCOUNT_KINDS.join(", ")}`);
    }
    if (!numeric(rule.value) || Number(rule.value) < 0) {
      throw refuse(`The discount "${rule.name}" has no valid value`);
    }
    if (rule.kind === "percent" && Number(rule.value) > 100) {
      throw refuse(`The discount "${rule.name}" is more than 100%`);
    }
    if (rule.max_discount != null && (!numeric(rule.max_discount) || rule.max_discount < 0)) {
      throw refuse(`The discount "${rule.name}" has no valid largest discount`);
    }
    if (rule.priority != null && !numeric(rule.priority)) {
      throw refuse(`The discount "${rule.name}" has no valid priority`);
    }
  }
}

const once = (rules) => {
  const seen = new Set();
  return rules.filter((rule) => rule.id == null || (!seen.has(rule.id) && seen.add(rule.id)));
};

export function applyDiscounts({ actual, quantity = 1, rules = [], stacking }) {
  checkInput({ actual, quantity, rules, stacking });
  const lineRules = once(rules.filter((rule) => rule.applies_per !== "bill"));
  const steps = [];
  let remaining = actual;
  const take = (step) => {
    if (!step) return;
    steps.push(step);
    remaining -= step.amount;
  };

  if (stacking === "best_only") {
    take(largest(lineRules, remaining, quantity));
  } else {
    take(
      largest(
        lineRules.filter((rule) => !rule.stackable),
        remaining,
        quantity,
      ),
    );
    for (const rule of lineRules.filter((r) => r.stackable).sort(byPriority)) {
      const amount = takes(rule, remaining, quantity);
      if (amount > 0) take({ rule, amount });
    }
  }

  return { discount: actual - remaining, applied: steps.map(applied) };
}
