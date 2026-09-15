import {
  evaluateFormula,
  computeFormulas,
  formulaInputs,
  rangeText,
  flagFor,
} from "../../shared/labFormula.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("── HealthRay's own formulas ────────────────────────────────");
const values = {
  143039: 150,
  143038: 200,
  143031: 50,
  143034: 120,
  154821: 90,
  347783: 10,
  143141: 7,
};
check("VLDL = TG / 5", evaluateFormula("#143039 / 5", values) === 30);
check("Non-HDL = Total - HDL", evaluateFormula("#143038 - #143031", values) === 150);
check("LDL / HDL", evaluateFormula("#143034 / #143031", values) === 2.4);
check("HOMA-IR", evaluateFormula("#154821 *  #347783 / 405", values) === 2.22);
check("HOMA-B", evaluateFormula("(360 *   #347783 ) / ( #154821 -63)", values) === 133.33);
check("Mean blood glucose", evaluateFormula("#143141   * 35.6 - 77.3", values) === 171.9);

console.log("\n── Nothing invented ────────────────────────────────────────");
check("a missing input gives no value", evaluateFormula("#111 / 5", values) === null);
check("text in an input gives no value", evaluateFormula("#1 / 5", { 1: "ABSENT" }) === null);
check("divide by zero gives no value", evaluateFormula("360 / (#1 - 63)", { 1: 63 }) === null);
check("an empty formula gives no value", evaluateFormula("", values) === null);
check("nothing is executed", evaluateFormula("process.exit(1)", values) === null);
check("an unbalanced bracket gives no value", evaluateFormula("(#143039 / 5", values) === null);
check(
  "inputs are listed",
  formulaInputs("(360 * #347783) / (#154821 - 63)").join() === "347783,154821",
);

console.log("\n── A chain of formulas ─────────────────────────────────────");
const chain = [
  { id: 1, formula: null },
  { id: 2, formula: "#1 * 2.14" },
  { id: 3, formula: "#2 / #1" },
];
const done = computeFormulas(chain, { 1: 10 });
check(
  "a formula that feeds another is worked out first",
  done[2] === 21.4 && done[3] === 2.14,
  JSON.stringify(done),
);
const loop = [
  { id: 1, formula: "#2 + 1" },
  { id: 2, formula: "#1 + 1" },
];
check("a loop does not hang", computeFormulas(loop, {})[1] === null);

console.log("\n── Ranges and flags ────────────────────────────────────────");
check("both ends", rangeText({ minValue: 4.5, maxValue: 6.5 }) === "4.5 - 6.5");
check("top only", rangeText({ maxValue: 200 }) === "< 200");
check("bottom only", rangeText({ minValue: 40 }) === "> 40");
check("no range", rangeText({}) === "");
check("in range is not flagged", flagFor(5, { minValue: 4, maxValue: 6 }).flag === null);
check("above the range is H", flagFor(7.4, { minValue: 4, maxValue: 6 }).flag === "H");
check("below the range is L", flagFor(3, { minValue: 4, maxValue: 6 }).flag === "L");
check(
  "a critical value says so",
  flagFor(500, { maxValue: 200, maxCritical: 400 }).critical === true,
);
check(
  "'<0.20' reads as a number",
  flagFor("<0.20", { minValue: 2.6, maxValue: 24.9 }).flag === "L",
);
check("text is never flagged", flagFor("ABSENT", { minValue: 1, maxValue: 2 }).flag === null);
check("no range, no flag", flagFor(9999, {}).flag === null);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
