import { useId, useState } from "react";
import { requestErrorOf } from "../../components/billing/format.js";
import { useFormulaFromText } from "../../queries/hooks/useLabCatalog.js";
import {
  PATIENT_VALUES,
  evaluateFormula,
  formulaAsNames,
  formulaInputs,
  formulaSyntaxError,
  formulaTokens,
} from "../../../shared/labFormula.js";

const OPERATORS = [
  { token: "+", label: "+", name: "plus", needs: "sign" },
  { token: "-", label: "−", name: "minus", needs: "sign" },
  { token: "*", label: "×", name: "times", needs: "sign" },
  { token: "/", label: "÷", name: "divided by", needs: "sign" },
  { token: "(", label: "(", name: "open bracket", needs: "value" },
  { token: ")", label: ")", name: "close bracket", needs: "close" },
  { token: "^", label: "^", name: "to the power of", needs: "sign" },
  { token: ",", label: ",", name: "comma", needs: "comma" },
];

const SIGNS = new Set(["+", "-", "*", "/", "^"]);
const FUNCTION_NAMES = new Set(["min", "max"]);

export function nextAllowed(tokens) {
  const open = [];
  let wantValue = true;
  tokens.forEach((t, i) => {
    if (FUNCTION_NAMES.has(t)) wantValue = true;
    else if (t === "(") {
      open.push({ fn: FUNCTION_NAMES.has(tokens[i - 1]), commas: 0 });
      wantValue = true;
    } else if (t === ")") {
      open.pop();
      wantValue = false;
    } else if (t === ",") {
      if (open.length) open[open.length - 1].commas += 1;
      wantValue = true;
    } else if (SIGNS.has(t)) wantValue = true;
    else wantValue = false;
  });
  const inner = open[open.length - 1];
  return {
    value: wantValue,
    sign: !wantValue,
    close: !wantValue && Boolean(inner) && (!inner.fn || inner.commas === 1),
    comma: !wantValue && Boolean(inner?.fn) && inner.commas === 0,
    openBrackets: open.length,
  };
}

const nextHint = (allowed, tokens) => {
  const step = !tokens.length
    ? "Start with a field, a number, a patient value or a bracket."
    : allowed.value
      ? "Next: a field, a number, a patient value or a bracket."
      : `Next: a sign${allowed.close ? ", or ) to close the bracket" : ""}${
          allowed.comma ? ", or a comma before the second value" : ""
        }.`;
  return step;
};

const NUMBER = /^-?\d+(\.\d+)?$/;

const FUNCTIONS = [
  { tokens: ["min", "("], label: "min(", name: "smaller of two values" },
  { tokens: ["max", "("], label: "max(", name: "larger of two values" },
];

const PATIENT_SAMPLE = { "@age": "age", "@female": "female", "@weight": "weight" };

const SHOWN = {
  "*": "×",
  "/": "÷",
  "-": "−",
  "@age": "age",
  "@female": "female",
  "@weight": "weight",
};

export const formulaUsable = (field) =>
  field.active && (field.type === "numeric" || field.type === "calculated");

export function dependentsOf(report, selfId) {
  const found = new Set();
  if (!selfId) return found;
  found.add(selfId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of report.fields) {
      if (found.has(f.id) || !f.formula) continue;
      if (f.formula.inputs.some((input) => found.has(input.id))) {
        found.add(f.id);
        grew = true;
      }
    }
  }
  return found;
}

export function nameLookup(report, extra = []) {
  const names = new Map(report.fields.map((f) => [f.id, f]));
  for (const input of extra)
    if (!names.has(input.id)) names.set(input.id, { ...input, unit: null });
  return names;
}

export default function FormulaBuilder({
  report,
  selfId = null,
  value,
  onChange,
  decimals,
  unit,
  extraInputs = [],
  touched,
}) {
  const id = useId();
  const tokens = formulaTokens(value) || [];
  const fields = nameLookup(report, extraInputs);
  const loopsBack = dependentsOf(report, selfId);
  const choices = report.fields.filter((f) => formulaUsable(f) && !loopsBack.has(f.id));
  const [number, setNumber] = useState("");
  const [samples, setSamples] = useState({});
  const [words, setWords] = useState("");
  const [fromAi, setFromAi] = useState(null);
  const ai = useFormulaFromText();
  const allowed = nextAllowed(tokens);
  const [patientOn, setPatientOn] = useState(() => tokens.some((t) => t.startsWith("@")));
  const showPatient = patientOn || tokens.some((t) => t.startsWith("@"));
  const afterDivide = tokens[tokens.length - 1] === "/";
  const problem = formulaSyntaxError(value);
  const inputs = [...new Set(formulaInputs(value).map(String))];
  const patientUsed = PATIENT_VALUES.filter((p) => tokens.includes(p.token));
  const patientSample = Object.fromEntries(
    patientUsed.map((p) => [PATIENT_SAMPLE[p.token], samples[p.token]]),
  );
  const result = problem ? null : evaluateFormula(value, samples, decimals ?? 2, patientSample);

  const put = (next) => {
    setFromAi(null);
    onChange(next.join(" "));
  };
  const askAi = () =>
    ai.mutate(
      { reportId: report.id, text: words, fieldId: selfId },
      {
        onSuccess: (r) => {
          onChange(r.formula);
          setFromAi(words.trim());
          setSamples({});
        },
      },
    );
  const append = (...more) => put([...tokens, ...more]);
  const addNumber = () => {
    const n = number.trim();
    if (!NUMBER.test(n) || !allowed.value) return;
    append(n);
    setNumber("");
  };

  return (
    <fieldset className="tdet__formula-builder">
      <legend className="tdet__optitle">Formula</legend>
      <div className="tdet__words">
        <label htmlFor={`${id}-words`} className="tdet__label">
          Write it in words (AI fills the formula below for you to check)
        </label>
        <div className="tdet__wordsrow">
          <input
            id={`${id}-words`}
            className="jb-assign"
            maxLength={500}
            value={words}
            placeholder="e.g. Neutrophil % times TLC divided by 100000"
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (words.trim() && !ai.isPending) askAi();
              }
            }}
          />
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            disabled={!words.trim() || ai.isPending}
            onClick={askAi}
          >
            {ai.isPending ? "Reading…" : "Make formula"}
          </button>
        </div>
        {ai.isError ? (
          <p className="tdet__issue" role="alert">
            {requestErrorOf(ai.error, "Could not make a formula from that")}
          </p>
        ) : null}
        {fromAi ? (
          <p className="tdet__note" role="status">
            Made by AI from “{fromAi}”. Check “Reads as” and try sample values before saving.
          </p>
        ) : null}
      </div>
      <div className="tdet__formula-chips" aria-live="polite" aria-label="Formula so far">
        {tokens.length ? (
          tokens.map((t, i) =>
            t.startsWith("#") ? (
              <span key={`${t}-${i}`} className="tdet__chip">
                {fields.get(t.slice(1))?.name || `missing field ${t.slice(1)}`}
              </span>
            ) : (
              <span key={`${t}-${i}`} className="tdet__op">
                {SHOWN[t] || t}
              </span>
            ),
          )
        ) : (
          <span className="tdet__muted">Empty — add a field to start</span>
        )}
      </div>
      <div className="tdet__formula-tools">
        <label htmlFor={`${id}-field`} className="tdet__label">
          Field
        </label>
        <select
          id={`${id}-field`}
          className="jb-assign"
          value=""
          disabled={!choices.length || !allowed.value}
          onChange={(e) => e.target.value && append(`#${e.target.value}`)}
        >
          <option value="">Pick a field to add…</option>
          {choices.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {showPatient ? (
          <span className="tdet__ops" role="group" aria-label="Patient values">
            {PATIENT_VALUES.map((p) => (
              <button
                key={p.token}
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                aria-label={`Insert the patient's ${p.label}`}
                disabled={!allowed.value || (afterDivide && p.token === "@female")}
                onClick={() => append(p.token)}
              >
                {SHOWN[p.token]}
              </button>
            ))}
          </span>
        ) : null}
        <span className="tdet__ops" role="group" aria-label="Functions">
          {FUNCTIONS.map((f) => (
            <button
              key={f.label}
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Insert ${f.name}`}
              disabled={!allowed.value}
              onClick={() => append(...f.tokens)}
            >
              {f.label}
            </button>
          ))}
        </span>
        <span className="tdet__ops" role="group" aria-label="Operators">
          {OPERATORS.map((o) => (
            <button
              key={o.token}
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini tdet__icon"
              aria-label={`Insert ${o.name}`}
              disabled={!allowed[o.needs]}
              onClick={() => append(o.token)}
            >
              {o.label}
            </button>
          ))}
        </span>
        <label htmlFor={`${id}-num`} className="tdet__label">
          Number
        </label>
        <input
          id={`${id}-num`}
          className="jb-assign tdet__cellinput"
          inputMode="decimal"
          value={number}
          placeholder="e.g. 2.14 or -1.2"
          disabled={!allowed.value}
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addNumber();
            }
          }}
        />
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          disabled={!allowed.value || !NUMBER.test(number.trim())}
          onClick={addNumber}
        >
          Insert number
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          disabled={!tokens.length}
          onClick={() => put(tokens.slice(0, -1))}
        >
          Remove last
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          disabled={!tokens.length}
          onClick={() => put([])}
        >
          Clear
        </button>
      </div>
      <label className="tdet__check">
        <input
          type="checkbox"
          checked={showPatient}
          disabled={tokens.some((t) => t.startsWith("@"))}
          onChange={(e) => setPatientOn(e.target.checked)}
        />
        Uses the patient&apos;s age, sex or weight (only for equations like eGFR or creatinine
        clearance)
      </label>
      <p className="tdet__muted">
        {nextHint(allowed, tokens)}
        {allowed.openBrackets ? (
          <strong className="tdet__openbrackets">
            {" "}
            {allowed.openBrackets} bracket{allowed.openBrackets === 1 ? "" : "s"} still open — close
            with )
          </strong>
        ) : null}
      </p>
      {!choices.length ? (
        <p className="tdet__issue">This report has no other number fields to calculate from.</p>
      ) : null}
      {problem && (touched || tokens.length) ? (
        <p className="tdet__issue tdet__formula-problem" role="status">
          {touched ? "" : "Not finished yet: "}
          {touched ? problem : problem.charAt(0).toLowerCase() + problem.slice(1)}.
        </p>
      ) : null}
      {!problem ? (
        <div className="tdet__preview">
          <p className="tdet__muted">
            Reads as: <strong>{formulaAsNames(value, (key) => fields.get(key)?.name)}</strong>
          </p>
          <p className="tdet__label">Try it with sample values</p>
          <div className="tdet__grid">
            {patientUsed.map((p) => (
              <div key={p.token} className="fset__field">
                <label htmlFor={`${id}-s-${p.token.slice(1)}`}>Patient {p.label}</label>
                <input
                  id={`${id}-s-${p.token.slice(1)}`}
                  className="jb-assign"
                  inputMode="decimal"
                  value={samples[p.token] ?? ""}
                  onChange={(e) => setSamples((s) => ({ ...s, [p.token]: e.target.value }))}
                />
              </div>
            ))}
            {inputs.map((key) => {
              const f = fields.get(key);
              return (
                <div key={key} className="fset__field">
                  <label htmlFor={`${id}-s-${key}`}>
                    {f?.name || key}
                    {f?.unit ? ` (${f.unit})` : f?.noUnit ? " (no unit)" : ""}
                  </label>
                  <input
                    id={`${id}-s-${key}`}
                    className="jb-assign"
                    inputMode="decimal"
                    value={samples[key] ?? ""}
                    onChange={(e) => setSamples((s) => ({ ...s, [key]: e.target.value }))}
                  />
                </div>
              );
            })}
          </div>
          <p className="tdet__result">
            Result: <strong>{result === null ? "—" : result}</strong>
            {result !== null && unit ? ` ${unit}` : ""}
            {result === null && Object.keys(samples).length ? (
              <span className="tdet__muted"> (needs every value, and no division by zero)</span>
            ) : null}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
