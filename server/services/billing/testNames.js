export const normalizeTestName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const WORD_ALIASES = { vitamin: "vit" };

const words = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => WORD_ALIASES[w] ?? w);

const EXTRA_WORDS = /\b(with|plus|and)\b|\+/i;

const addsMoreThanItsBrackets = (name) => {
  const text = String(name ?? "");
  const afterLastBracket = text.slice(text.lastIndexOf(")") + 1);
  return /[a-z0-9]/i.test(afterLastBracket) || EXTRA_WORDS.test(text);
};

const bracketed = (name) =>
  addsMoreThanItsBrackets(name)
    ? []
    : [...String(name ?? "").matchAll(/\(([^)]+)\)/g)].map((m) => normalizeTestName(m[1]));

const wordKey = (name) => [...words(name)].sort().join(" ");

export function looksLikeSameTest(a, b) {
  if (normalizeTestName(a) === normalizeTestName(b)) return false;
  const na = normalizeTestName(a);
  const nb = normalizeTestName(b);
  if (bracketed(a).includes(nb) || bracketed(b).includes(na)) return true;
  const ka = wordKey(a);
  return ka.length > 0 && ka === wordKey(b);
}

const LAB_ALIASES = [
  [
    "glucosefasting",
    "fastingbloodsugar",
    "fbs",
    "bloodsugarfasting",
    "fastingglucose",
    "fastingplasmaglucose",
  ],
  [
    "glucosepostprandialpp",
    "glucosepostprandial",
    "postprandialbloodsugar",
    "ppbs",
    "glucosepp",
    "bloodsugarpp",
  ],
  ["glucoserandombloodsugar", "glucoserandom", "randombloodsugar", "rbs", "glucoserandomblood"],
];

const aliasOf = (name) => {
  const n = normalizeTestName(name);
  return LAB_ALIASES.find((group) => group.includes(n))?.[0] ?? n;
};

const allWords = (name) =>
  [
    ...new Set(
      String(name ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((w) => WORD_ALIASES[w] ?? w),
    ),
  ]
    .sort()
    .join(" ");

const outsideBrackets = (name) => normalizeTestName(String(name ?? "").replace(/\([^)]*\)/g, " "));

const bracketCodes = (name) =>
  [...String(name ?? "").matchAll(/\(([^)]+)\)/g)].map((m) => normalizeTestName(m[1]));

export function isSameLabTest(a, b) {
  if (!a || !b) return false;
  if (aliasOf(a) === aliasOf(b)) return true;
  if (allWords(a) === allWords(b)) return true;
  const outA = outsideBrackets(a);
  const outB = outsideBrackets(b);
  return (
    (outA.length >= 2 && bracketCodes(b).includes(outA)) ||
    (outB.length >= 2 && bracketCodes(a).includes(outB))
  );
}
