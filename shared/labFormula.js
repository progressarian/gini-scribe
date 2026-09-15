const TOKEN = /\s*(\d+(?:\.\d+)?|#\d+|[()+\-*/])/y;

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

export function evaluateFormula(formula, valuesById = {}) {
  const tokens = tokenise(formula);
  if (!tokens?.length) return null;

  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const primary = () => {
    const token = take();
    if (token === "(") {
      const value = expression();
      if (take() !== ")") return null;
      return value;
    }
    if (token === "-") {
      const value = primary();
      return value === null ? null : -value;
    }
    if (token?.startsWith("#")) {
      const raw = valuesById[token.slice(1)];
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      const text = String(raw ?? "").trim();
      if (!text) return null;
      const value = Number(text);
      return Number.isFinite(value) ? value : null;
    }
    const literal = Number(token);
    return Number.isFinite(literal) ? literal : null;
  };

  const term = () => {
    let left = primary();
    while (peek() === "*" || peek() === "/") {
      const op = take();
      const right = primary();
      if (left === null || right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };

  const expression = () => {
    let left = term();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const right = term();
      if (left === null || right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };

  const value = expression();
  if (at !== tokens.length || value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

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

export function computeFormulas(tests, values = {}) {
  const out = { ...values };
  for (const test of formulaOrder(tests.filter((t) => t.formula))) {
    out[String(test.id)] = evaluateFormula(test.formula, out);
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
  const n =
    typeof value === "number"
      ? value
      : Number(
          String(value ?? "")
            .replace(/^[<>]=?/, "")
            .trim(),
        );
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
