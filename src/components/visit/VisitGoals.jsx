import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";

const PRESET_MARKERS = [
  "HbA1c",
  "Blood pressure",
  "Weight",
  "LDL",
  "Triglycerides",
  "FBS",
  "BMI",
  "Waist",
];

export default function VisitGoals({ patientId, goals = [] }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [draft, setDraft] = useState({
    marker: "",
    target_value: "",
    current_value: "",
    timeline: "",
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["visit", String(patientId)] });

  const submit = async (e) => {
    e?.preventDefault();
    if (!draft.marker.trim() || !draft.target_value.trim()) {
      toast("Marker and target are required", "error");
      return;
    }
    setBusyId("new");
    try {
      await api.post(`/api/visit/${patientId}/goal`, draft);
      setDraft({ marker: "", target_value: "", current_value: "", timeline: "" });
      setAdding(false);
      refresh();
    } catch (err) {
      toast(`Could not save goal: ${err.message}`, "error");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this goal?")) return;
    setBusyId(id);
    try {
      await api.delete(`/api/visit/${patientId}/goal/${id}`);
      refresh();
    } catch (err) {
      toast(`Could not delete goal: ${err.message}`, "error");
    } finally {
      setBusyId(null);
    }
  };

  const activeGoals = goals.filter((g) => g.status !== "achieved" && g.status !== "missed");

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #dde3ea",
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2332" }}>
          🎯 Goals for next visit
          <span style={{ fontSize: 11, fontWeight: 400, color: "#6b7d90", marginLeft: 6 }}>
            ({activeGoals.length})
          </span>
        </div>
        {!adding && (
          <button
            className="btn"
            onClick={() => setAdding(true)}
            style={{ fontSize: 11, padding: "4px 10px" }}
          >
            + Add goal
          </button>
        )}
      </div>

      {activeGoals.length === 0 && !adding && (
        <div style={{ fontSize: 12, color: "#6b7d90", fontStyle: "italic" }}>
          No goals set. Click "Add goal" to set targets for next visit.
        </div>
      )}

      {activeGoals.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {activeGoals.map((g) => (
            <div
              key={g.id}
              style={{
                background: "#f0f4f7",
                borderRadius: 6,
                padding: "8px 10px",
                borderLeft: "3px solid #009e8c",
                position: "relative",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#009e8c",
                  marginBottom: 3,
                }}
              >
                {g.marker}
              </div>
              <div
                style={{
                  fontFamily: "DM Mono, monospace",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "#1a2332",
                }}
              >
                {g.target_value}
              </div>
              {g.current_value && (
                <div style={{ fontSize: 10, color: "#6b7d90", marginTop: 2 }}>
                  Today: {g.current_value}
                </div>
              )}
              {g.timeline && (
                <div style={{ fontSize: 10, color: "#6b7d90", marginTop: 1 }}>by {g.timeline}</div>
              )}
              <button
                onClick={() => remove(g.id)}
                disabled={busyId === g.id}
                title="Delete goal"
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  background: "transparent",
                  border: "none",
                  fontSize: 11,
                  color: "#d94f4f",
                  cursor: busyId === g.id ? "wait" : "pointer",
                  padding: 2,
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <form
          onSubmit={submit}
          style={{
            marginTop: 10,
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            padding: 10,
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "center",
          }}
        >
          <input
            type="text"
            list="goal-markers"
            placeholder="Marker"
            value={draft.marker}
            onChange={(e) => setDraft({ ...draft, marker: e.target.value })}
            style={inputStyle}
            autoFocus
          />
          <datalist id="goal-markers">
            {PRESET_MARKERS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <input
            type="text"
            placeholder="Target (e.g. < 7%)"
            value={draft.target_value}
            onChange={(e) => setDraft({ ...draft, target_value: e.target.value })}
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Today's value"
            value={draft.current_value}
            onChange={(e) => setDraft({ ...draft, current_value: e.target.value })}
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Timeline (3 months)"
            value={draft.timeline}
            onChange={(e) => setDraft({ ...draft, timeline: e.target.value })}
            style={inputStyle}
          />
          <button
            type="submit"
            className="btn-p"
            disabled={busyId === "new"}
            style={{ fontSize: 11, padding: "5px 10px" }}
          >
            {busyId === "new" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAdding(false);
              setDraft({ marker: "", target_value: "", current_value: "", timeline: "" });
            }}
            style={{ fontSize: 11, padding: "5px 10px" }}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

const inputStyle = {
  fontSize: 12,
  padding: "5px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  outline: "none",
  flex: "1 1 140px",
  minWidth: 0,
};
