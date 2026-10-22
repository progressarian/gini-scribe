import { useEffect, useRef, useState } from "react";
import {
  useMoAdviceChoices,
  useMoSuggestions,
  useSaveSuggestion,
} from "../../queries/hooks/useGiniflowMo";
import NextVisitPicker from "./NextVisitPicker";

const SAVE_DELAY_MS = 800;
const COMMON_SHOWN = 12;
const emptyGoal = () => ({ test: "", target: "", unit: "" });

const OUTCOME = {
  accepted: "✓ Accepted by the doctor",
  edited: "✓ Accepted with changes by the doctor",
  dismissed: "Dismissed by the doctor",
};

const lineKey = (line) =>
  String(line || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function initialValues(byField) {
  return {
    advice: byField.advice?.value ?? "",
    treatment: byField.treatment?.value ?? "",
    lifestyle: byField.lifestyle?.value ?? "",
    goals: byField.goals?.value?.length ? byField.goals.value : [emptyGoal()],
    next_visit: byField.next_visit?.value ?? { date: "", interval: "" },
  };
}

const toSend = (field, value) => {
  if (field === "goals") return value.filter((g) => g.test.trim());
  if (field === "next_visit") return { date: value.date || null, interval: value.interval || null };
  return value;
};

function Outcome({ suggestion }) {
  if (!suggestion || suggestion.status === "proposed") return null;
  return (
    <div className="cs-sub">
      {OUTCOME[suggestion.status]}
      {suggestion.decidedBy ? ` · ${suggestion.decidedBy}` : ""}
      {suggestion.note ? ` — ${suggestion.note}` : ""}
    </div>
  );
}

export default function ChiefSuggestions({ visitId, readOnly, onToast }) {
  const { data, isLoading, isError } = useMoSuggestions(visitId);
  const { data: choices } = useMoAdviceChoices(visitId);
  const save = useSaveSuggestion(visitId);
  const [values, setValues] = useState(null);
  const [savingField, setSavingField] = useState(null);
  const timers = useRef({});
  const pending = useRef({});

  const byField = Object.fromEntries((data?.suggestions || []).map((s) => [s.field, s]));
  const decided = (field) => byField[field] && byField[field].status !== "proposed";

  useEffect(() => {
    setValues(null);
  }, [visitId]);

  useEffect(() => {
    if (data && values === null) setValues(initialValues(byField));
  }, [data, values, byField]);

  const send = (field) => {
    clearTimeout(timers.current[field]);
    if (!(field in pending.current)) return;
    const value = pending.current[field];
    delete pending.current[field];
    setSavingField(field);
    save.mutate(
      { field, value: toSend(field, value) },
      {
        onSettled: () => setSavingField((f) => (f === field ? null : f)),
        onError: (e) => onToast?.(e?.response?.data?.error || "The suggestion was not saved"),
      },
    );
  };

  useEffect(() => {
    const queued = pending.current;
    return () => Object.keys(queued).forEach(send);
  }, [visitId]);

  const edit = (field, value) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    pending.current[field] = value;
    clearTimeout(timers.current[field]);
    timers.current[field] = setTimeout(() => send(field), SAVE_DELAY_MS);
  };

  if (isLoading || values === null) {
    return (
      <div className="dp-hint">{isError ? "Suggestions could not be loaded." : "Loading…"}</div>
    );
  }

  const locked = (field) => readOnly || decided(field);
  const state = (field) =>
    decided(field) ? null : savingField === field ? "Saving…" : byField[field] ? "Suggested" : "";
  const written = new Set(values.advice.split(/\n+/).map(lineKey).filter(Boolean));
  const common = (choices?.common || [])
    .filter((c) => !written.has(lineKey(c.line)))
    .slice(0, COMMON_SHOWN);

  return (
    <div>
      <div className="dp-hint">
        A suggestion, not a prescription — the doctor decides. Nothing here prints unless the doctor
        accepts it.
      </div>

      <label className="cp-lab" htmlFor={`sug-advice-${visitId}`}>
        Advice <span className="cs-sub">{state("advice")}</span>
      </label>
      <textarea
        id={`sug-advice-${visitId}`}
        className="cp-text"
        rows={3}
        value={values.advice}
        readOnly={locked("advice")}
        placeholder="One per line — e.g. Walk 30 minutes daily"
        onChange={(e) => edit("advice", e.target.value)}
      />
      <Outcome suggestion={byField.advice} />
      {!locked("advice") && common.length > 0 && (
        <div className="tst-list">
          {common.map((c) => (
            <button
              type="button"
              key={c.line}
              className="tst-chip"
              onClick={() => {
                const text = values.advice.replace(/\s+$/, "");
                edit("advice", text ? `${text}\n${c.line}` : c.line);
              }}
            >
              <span className="tst-name">+ {c.line}</span>
            </button>
          ))}
        </div>
      )}

      {[
        ["treatment", "Treatment", "e.g. Continue insulin, review dose at next visit"],
        ["lifestyle", "Lifestyle", "e.g. 1500 kcal diet, 8,000 steps a day"],
      ].map(([field, label, hint]) => (
        <div key={field}>
          <label className="cp-lab" htmlFor={`sug-${field}-${visitId}`}>
            {label} <span className="cs-sub">{state(field)}</span>
          </label>
          <textarea
            id={`sug-${field}-${visitId}`}
            className="cp-text"
            rows={2}
            value={values[field]}
            readOnly={locked(field)}
            placeholder={hint}
            onChange={(e) => edit(field, e.target.value)}
          />
          <Outcome suggestion={byField[field]} />
        </div>
      ))}

      <div className="cp-lab">
        Goals <span className="cs-sub">{state("goals")}</span>
      </div>
      {values.goals.map((goal, i) => (
        <div className="cp-goal" key={i}>
          {[
            ["test", "Test, e.g. HbA1c"],
            ["target", "Target, e.g. <7"],
            ["unit", "Unit, e.g. %"],
          ].map(([key, placeholder]) => (
            <input
              key={key}
              className="cp-inp"
              aria-label={`Goal ${i + 1} ${key}`}
              placeholder={placeholder}
              value={goal[key]}
              readOnly={locked("goals")}
              onChange={(e) =>
                edit(
                  "goals",
                  values.goals.map((g, j) => (j === i ? { ...g, [key]: e.target.value } : g)),
                )
              }
            />
          ))}
          {!locked("goals") && values.goals.length > 1 && (
            <button
              type="button"
              className="btn-sm"
              aria-label={`Remove goal ${i + 1}`}
              onClick={() =>
                edit(
                  "goals",
                  values.goals.filter((_, j) => j !== i),
                )
              }
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {!locked("goals") && (
        <button
          type="button"
          className="btn-sm"
          onClick={() => edit("goals", [...values.goals, emptyGoal()])}
        >
          + Add goal
        </button>
      )}
      <Outcome suggestion={byField.goals} />

      {state("next_visit") && <div className="cs-sub">Next visit · {state("next_visit")}</div>}
      <NextVisitPicker
        interval={values.next_visit.interval || ""}
        date={values.next_visit.date || ""}
        disabled={locked("next_visit")}
        onChange={(next) => edit("next_visit", next)}
      />
      <Outcome suggestion={byField.next_visit} />
    </div>
  );
}
