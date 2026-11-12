import { useId, useState } from "react";
import {
  PATIENT_VALUES,
  evaluateFormula,
  formulaAsNames,
  formulaInputs,
  formulaSyntaxError,
  formulaTokens,
} from "../../../shared/labFormula.js";

const OPERATORS = [
  { token: "+", label: "+", name: "plus" },
  { token: "-", label: "−", name: "minus" },
  { token: "*", label: "×", name: "times" },
  { token: "/", label: "÷", name: "divided by" },
  { token: "(", label: "(", name: "open bracket" },
  { token: ")", label: ")", name: "close bracket" },
  { token: "^", label: "^", name: "to the power of" },
  { token: ",", label: ",", name: "comma" },
];

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
  const [pick, setPick] = useState(choices[0]?.id || "");
  const [number, setNumber] = useState("");
  const [samples, setSamples] = useState({});
  const problem = formulaSyntaxError(value);
  const inputs = [...new Set(formulaInputs(value).map(String))];
  const patientUsed = PATIENT_VALUES.filter((p) => tokens.includes(p.token));
  const patientSample = Object.fromEntries(
    patientUsed.map((p) => [PATIENT_SAMPLE[p.token], samples[p.token]]),
  );
  const result = problem ? null : evaluateFormula(value, samples, decimals ?? 2, patientSample);

  const put = (next) => onChange(next.join(" "));
  const append = (...more) => put([...tokens, ...more]);
  const addNumber = () => {
    const n = number.trim();
    if (!/^\d+(\.\d+)?$/.test(n)) return;
    append(n);
    setNumber("");
  };

  return (
    <fieldset className="tdet__formula-builder">
      <legend className="tdet__optitle">Formula</legend>
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
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          {choices.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          disabled={!pick}
          onClick={() => append(`#${pick}`)}
        >
          Insert field
        </button>
        <span className="tdet__ops" role="group" aria-label="Patient values">
          {PATIENT_VALUES.map((p) => (
            <button
              key={p.token}
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Insert the patient's ${p.label}`}
              onClick={() => append(p.token)}
            >
              {SHOWN[p.token]}
            </button>
          ))}
        </span>
        <span className="tdet__ops" role="group" aria-label="Functions">
          {FUNCTIONS.map((f) => (
            <button
              key={f.label}
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Insert ${f.name}`}
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
          placeholder="e.g. 2.14"
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addNumber();
            }
          }}
        />
        <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={addNumber}>
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
      {!choices.length ? (
        <p className="tdet__issue">This report has no other number fields to calculate from.</p>
      ) : null}
      {problem && (touched || tokens.length) ? (
        <p className="tdet__issue" role="status">
          {problem}.
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
