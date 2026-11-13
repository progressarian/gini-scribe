const TOKEN = /\s*(\d+(?:\.\d+)?|#\d+|@(?:age|female|weight)\b|(?:min|max)(?=\s*\()|[()+\-*/^,])/y;

const tokenise = (formula) => {
  const tokens = [];
  let at = 0;
  const text = String(formula || "");
  while (at < text.length) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(text);
    if (!match) return null;
    tokens.push(match[1]);
    at = TOKEN.lastIndex;
  }
  return tokens;
};

export function formulaInputs(formula) {
  return [...String(formula || "").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

const roundTo = (value, decimals) => {
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 4 ? decimals : 2;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export const PATIENT_VALUES = [
  { token: "@age", label: "age (years)" },
  { token: "@female", label: "female (1) / male (0)" },
  { token: "@weight", label: "weight today (kg)" },
];

export function formulaPatient({ sex = null, ageYears = null, weightKg = null } = {}) {
  const number = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    age: number(ageYears),
    female: sex === "Female" ? 1 : sex === "Male" ? 0 : null,
    weight: number(weightKg),
  };
}

function walk(tokens, { value, patient, fn }) {
  let at = 0;
  let problem = null;
  const fault = (message) => {
    problem ??= message;
    return null;
  };
  const both = (a, b, f) => (a === null || b === null ? null : f(a, b));

  const expression = () => {
    let left = term();
    while (tokens[at] === "+" || tokens[at] === "-") {
      const op = tokens[at++];
      const right = term();
      left = both(left, right, (a, b) => (op === "+" ? a + b : a - b));
    }
    return left;
  };
  const term = () => {
    let left = unary();
    while (tokens[at] === "*" || tokens[at] === "/") {
      const op = tokens[at++];
      const right = unary();
      left = both(left, right, (a, b) => (op === "*" ? a * b : b === 0 ? null : a / b));
    }
    return left;
  };
  const unary = () => {
    if (tokens[at] === "-") {
      at += 1;
      const v = unary();
      return v === null ? null : -v;
    }
    return power();
  };
  const power = () => {
    const base = primary();
    if (tokens[at] !== "^") return base;
    at += 1;
    const exponent = unary();
    return both(base, exponent, (a, b) => a ** b);
  };
  const primary = () => {
    const token = tokens[at++];
    if (token === undefined) return fault("The formula ends too early");
    if (token === "(") {
      const v = expression();
      if (tokens[at++] !== ")") return fault("A bracket is not closed");
      return v;
    }
    if (token === "min" || token === "max") {
      if (tokens[at++] !== "(") return fault(`${token} needs brackets: ${token}(a, b)`);
      const a = expression();
      if (tokens[at++] !== ",") return fault(`${token} needs two values separated by a comma`);
      const b = expression();
      if (tokens[at++] !== ")") return fault("A bracket is not closed");
      return both(a, b, (x, y) => fn[token](x, y));
    }
    if (token.startsWith("#")) return value(token.slice(1));
    if (token.startsWith("@")) return patient(token.slice(1));
    if (/^\d/.test(token)) return Number(token);
    return fault(`Something is missing before “${token}”`);
  };

  const result = expression();
  if (!problem && at < tokens.length) {
    fault(
      tokens[at] === ")"
        ? "A closing bracket has no opening one"
        : tokens[at] === ","
          ? "A comma can only be used inside min( , ) or max( , )"
          : "Two values need a sign between them",
    );
  }
  return { result, problem };
}

const asNumber = (raw) => {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

export function evaluateFormula(formula, valuesById = {}, decimals = 2, patient = {}) {
  const tokens = tokenise(String(formula || "").trim());
  if (!tokens?.length) return null;
  const { result, problem } = walk(tokens, {
    value: (id) => asNumber(valuesById[id]),
    patient: (key) => asNumber(patient[key]),
    fn: { min: Math.min, max: Math.max },
  });
  if (problem || result === null || !Number.isFinite(result)) return null;
  return roundTo(result, decimals);
}

export const formulaUsesPatient = (formula) => /@(age|female|weight)\b/.test(String(formula || ""));

export function formulaOrder(tests) {
  const byId = new Map(tests.map((t) => [String(t.id), t]));
  const done = new Set();
  const order = [];
  const visit = (id, seen) => {
    const test = byId.get(String(id));
    if (!test || done.has(String(id)) || seen.has(String(id))) return;
    seen.add(String(id));
    for (const input of formulaInputs(test.formula)) visit(input, seen);
    done.add(String(id));
    order.push(test);
  };
  tests.forEach((t) => visit(t.id, new Set()));
  return order;
}

export function computeFormulas(tests, values = {}, patient = {}) {
  const out = { ...values };
  for (const test of formulaOrder(tests.filter((t) => t.formula))) {
    out[String(test.id)] = evaluateFormula(test.formula, out, test.decimals ?? 2, patient);
  }
  return out;
}

export function rangeText({ minValue = null, maxValue = null, textRange = null } = {}) {
  if (textRange) return textRange;
  const min = minValue === null || minValue === undefined ? null : Number(minValue);
  const max = maxValue === null || maxValue === undefined ? null : Number(maxValue);
  if (min !== null && max !== null) return `${min} - ${max}`;
  if (max !== null) return `< ${max}`;
  if (min !== null) return `> ${min}`;
  return "";
}

export function flagFor(
  value,
  { minValue = null, maxValue = null, minCritical = null, maxCritical = null } = {},
) {
  const typed =
    typeof value === "number"
      ? null
      : String(value ?? "")
          .replace(/^[<>]=?/, "")
          .trim();
  if (typed === "") return { flag: null, critical: false };
  const n = typed === null ? value : Number(typed);
  if (!Number.isFinite(n)) return { flag: null, critical: false };
  const min = minValue === null ? null : Number(minValue);
  const max = maxValue === null ? null : Number(maxValue);
  const lowCritical = minCritical === null ? null : Number(minCritical);
  const highCritical = maxCritical === null ? null : Number(maxCritical);
  const critical =
    (lowCritical !== null && n <= lowCritical) || (highCritical !== null && n >= highCritical);
  if (max !== null && n > max) return { flag: "H", critical };
  if (min !== null && n < min) return { flag: "L", critical };
  return { flag: null, critical };
}

const SHOWN_OPERATOR = { "*": "×", "/": "÷", "-": "−", "+": "+", ",": "," };
const SHOWN_PATIENT = { "@age": "age", "@female": "female", "@weight": "weight" };

export function formulaAsNames(formula, nameOf = () => null) {
  const tokens = tokenise(formula);
  if (!tokens) return String(formula || "");
  return tokens
    .map((token) => {
      if (token.startsWith("#"))
        return nameOf(token.slice(1)) || `[missing field ${token.slice(1)}]`;
      return SHOWN_PATIENT[token] ?? SHOWN_OPERATOR[token] ?? token;
    })
    .join(" ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .replace(/ ,/g, ",")
    .replace(/(min|max) \(/g, "$1(");
}

export const formulaTokens = (formula) => tokenise(String(formula || "").trim()) || null;

export function formulaSyntaxError(formula) {
  const text = String(formula || "").trim();
  if (!text) return "The formula is empty";
  const tokens = tokenise(text);
  if (!tokens) return "The formula has characters it cannot use";
  const { problem } = walk(tokens, {
    value: () => 1,
    patient: () => 1,
    fn: { min: () => 1, max: () => 1 },
  });
  if (problem) return problem;
  if (!formulaInputs(text).length) return "Use at least one field";
  return null;
}

export const LAB_NUMBER = /^(?:[<>]=?\s*)?-?\d+(?:\.\d+)?$/;

export const notANumber = (value) => {
  const raw = String(value ?? "").trim();
  return raw !== "" && !LAB_NUMBER.test(raw);
};
