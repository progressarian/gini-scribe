import { useState } from "react";
import { useDoctorSuggestions } from "../../../queries/hooks/useGiniflowDoctor";

const LABEL = {
  advice: "Advice",
  treatment: "Treatment",
  lifestyle: "Lifestyle",
  goals: "Goals",
  next_visit: "Next visit",
};

const OUTCOME = { accepted: "Accepted", edited: "Accepted with changes", dismissed: "Dismissed" };

const goalText = (g) => [g.test, g.target, g.unit].filter(Boolean).join(" ");

function valueText(field, value) {
  if (!value) return "";
  if (field === "goals") return value.map(goalText).join(" · ");
  if (field === "next_visit") return value.date || value.interval || "";
  return value;
}

const editable = (field, value) => {
  if (field === "goals") return value.map(goalText).join("\n");
  if (field === "next_visit") return value.date || value.interval || "";
  return value;
};

function edited(field, text) {
  if (field === "goals") {
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [test, target = "", unit = ""] = line.split(/\s+/);
        return { test, target, unit };
      });
  }
  if (field === "next_visit") {
    const typed = text.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(typed)
      ? { date: typed, interval: null }
      : { date: null, interval: typed };
  }
  return text;
}

function Pending({ suggestion, readOnly, deciding, onDecide }) {
  const [mode, setMode] = useState(null);
  const [text, setText] = useState("");
  const label = LABEL[suggestion.field];

  const decide = async (decision) => {
    const ok = await onDecide({ suggestionId: suggestion.id, ...decision });
    if (ok) setMode(null);
  };

  return (
    <div className="prop" aria-label={`Chief suggestion: ${label}`}>
      <div className="prop-main">
        <strong>{label}</strong>
        <div className="prop-why">{valueText(suggestion.field, suggestion.value)}</div>
        <div className="prop-by">
          suggested by {suggestion.proposedBy || "the Chief Endocrinologist"}
        </div>
      </div>
      {!readOnly && mode === null && (
        <div className="prop-acts">
          <button
            type="button"
            className="btn-sm on"
            disabled={deciding}
            onClick={() => decide({ status: "accepted" })}
          >
            Accept
          </button>
          <button
            type="button"
            className="btn-sm"
            disabled={deciding}
            onClick={() => {
              setText(editable(suggestion.field, suggestion.value));
              setMode("edit");
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn-sm"
            disabled={deciding}
            onClick={() => {
              setText("");
              setMode("dismiss");
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {mode && (
        <form
          className="prop-form"
          onSubmit={(e) => {
            e.preventDefault();
            decide(
              mode === "edit"
                ? { status: "edited", value: edited(suggestion.field, text) }
                : { status: "dismissed", note: text.trim() || null },
            );
          }}
        >
          {mode === "edit" ? (
            <textarea
              className="cp-text"
              rows={suggestion.field === "next_visit" ? 1 : 3}
              aria-label={`Edit ${label}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <input
              className="cp-inp"
              aria-label={`Why dismiss ${label}`}
              placeholder="Reason (optional)"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <button
            type="submit"
            className="btn-sm on"
            disabled={deciding || (mode === "edit" && !text.trim())}
          >
            {mode === "edit" ? "Save and accept" : "Dismiss"}
          </button>
          <button type="button" className="btn-sm" onClick={() => setMode(null)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

export default function PlanSuggestions({ visitId, readOnly, deciding, onDecide }) {
  const { data } = useDoctorSuggestions(visitId);
  const all = data?.suggestions || [];
  if (!all.length) return null;
  const pending = all.filter((s) => s.status === "proposed");
  const decided = all.filter((s) => s.status !== "proposed");

  return (
    <section className="csec" aria-label="Chief Endocrinologist suggestions">
      <div className="cs-head">
        <h2>🩺 Chief Endo suggested — advice &amp; care plan</h2>
        <span className="cs-sub">
          {pending.length
            ? `${pending.length} to decide before finishing · accepted text is added to your advice and care plan`
            : "all decided"}
        </span>
      </div>
      {pending.map((s) => (
        <Pending
          key={s.id}
          suggestion={s}
          readOnly={readOnly}
          deciding={deciding}
          onDecide={onDecide}
        />
      ))}
      {decided.length > 0 && (
        <div className="cs-sub">
          {decided
            .map((s) => `${LABEL[s.field]}: ${OUTCOME[s.status]}${s.note ? ` (${s.note})` : ""}`)
            .join(" · ")}
        </div>
      )}
    </section>
  );
}
