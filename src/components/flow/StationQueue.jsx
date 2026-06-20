import { useEffect, useState } from "react";
import { toast } from "../../stores/uiStore";
import { useFlowQueue, useFlowAdvance, useFlowStartStep } from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// Friendly URL slug → the assigned_role stored on flow_visit_steps, plus the
// station's display title and which data-entry form to render. Shared by the
// standalone station page and the "Live Lab Queue" tab on /lab-requests.
export const ROLES = {
  vitals: { role: "vitals_associate", title: "⚖️ Vitals Station", form: "vitals" },
  mo: { role: "mo", title: "🩺 Medical Officer", form: "notes" },
  lab: { role: "lab_tech", title: "🔬 Lab & Tests", form: "lab" },
  dietitian: { role: "dietitian", title: "🥗 Dietitian", form: "notes" },
  rx: { role: "nurse", title: "💬 Prescription Explain", form: "rx" },
  pharmacy: { role: "pharmacist", title: "💊 Pharmacy — Final Step", form: "pharmacy" },
};

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Quick-pick reasons for skipping a step (free text still allowed). Mirrors the
// list in VisitDetailModal so skip reasons stay consistent across the app.
const SKIP_REASONS = ["Already done", "Not required", "Done elsewhere", "Patient declined"];

// The live execution queue for one station role: the active (in-progress)
// patient with a role-specific form + "advance", a call-in ready queue, and the
// pending list. Self-contained (owns its data + mutations) so it can be dropped
// into any page.
export default function StationQueue({ role, form, freeMove = false }) {
  const { data, isLoading } = useFlowQueue(role);
  const advance = useFlowAdvance();
  const startStep = useFlowStartStep();

  const active = data?.active?.[0] || null;
  const ready = data?.ready || [];
  const pending = data?.pending || [];

  // In free-move stations (vitals) the user picks who sits in the form box. The
  // box patient is a LOCAL selection (default: whoever is in_progress, else
  // none); clicking "Move in" on a queued patient just swaps them into the box
  // (and the previous one returns to the list) — it does NOT advance anyone.
  const [selectedId, setSelectedId] = useState(null);
  const queueItems = freeMove ? [...(data?.active || []), ...ready] : [];
  const boxPatient = freeMove ? queueItems.find((i) => i.id === selectedId) || active : active;
  const listItems = freeMove ? queueItems.filter((i) => i.id !== boxPatient?.id) : ready;

  const [formData, setFormData] = useState({});
  useEffect(() => setFormData({}), [boxPatient?.id]);

  // Skip-reason dialog — targets a specific step (the box patient OR any queued
  // patient), so anyone can be skipped at any time. Replaces the native prompt.
  const [skipTarget, setSkipTarget] = useState(null);
  const [skipReason, setSkipReason] = useState("");

  const callIn = async (stepId) => {
    try {
      await startStep.mutateAsync(stepId);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Bring a queued patient into the form box (and send whoever was in the box
  // back to the list). Pure client-side selection — does NOT advance them.
  const moveIntoBox = (s) => setSelectedId(s.id);

  const complete = async () => {
    if (!boxPatient) return;
    try {
      await advance.mutateAsync({
        visitId: boxPatient.visit_id,
        step_id: boxPatient.id,
        step_data: formData,
      });
      toast(`${boxPatient.patient_name} → next step`, "success");
      setFormData({});
      setSelectedId(null);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Skip a step (e.g. vitals already taken elsewhere / not applicable) — the
  // patient still advances. Confirmed via a dialog with quick-pick reasons.
  const confirmSkip = async () => {
    if (!skipTarget) return;
    try {
      await advance.mutateAsync({
        visitId: skipTarget.visit_id,
        step_id: skipTarget.id,
        skip: true,
        reason: skipReason.trim(),
      });
      toast(`${skipTarget.patient_name} — ${skipTarget.step_name} skipped → next step`, "success");
      if (skipTarget.id === boxPatient?.id) {
        setFormData({});
        setSelectedId(null);
      }
      setSkipTarget(null);
      setSkipReason("");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  if (isLoading) return <div className="flow-card flow-empty">Loading…</div>;

  return (
    <>
      {/* Patient in the form box */}
      {boxPatient ? (
        <div className="station-active">
          <div className="station-head">
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {boxPatient.patient_name} · Step {boxPatient.step_order} of {boxPatient.total_steps}
              </div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                {boxPatient.patient_age_sex || ""} · {boxPatient.file_no} ·{" "}
                {boxPatient.visit_type_id} · budget ≤ {boxPatient.planned_duration_min} min
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 14 }}>
                At station: {boxPatient.step_timing?.at_station_min ?? 0} min
              </div>
              <div style={{ fontSize: 10, opacity: 0.8 }}>
                Visit: {boxPatient.visit_remaining_min}m left
              </div>
            </div>
          </div>
          <div className="station-body">
            <StationForm key={boxPatient.id} form={form} value={formData} onChange={setFormData} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <button
                className={`flow-btn ${form === "pharmacy" ? "flow-btn-primary" : "flow-btn-grn"}`}
                style={{ padding: "8px 18px" }}
                disabled={advance.isPending}
                onClick={complete}
              >
                {form === "pharmacy"
                  ? "💊 Dispensed — Confirm Exit (stops clock)"
                  : "✓ Done — move to next step"}
              </button>
              <button
                className="flow-btn flow-btn-ghost"
                style={{ padding: "8px 14px" }}
                disabled={advance.isPending}
                onClick={() => setSkipTarget(boxPatient)}
                title="Skip this step — patient still advances"
              >
                ⏭ Skip
              </button>
              <span className="flow-muted">Patient auto-moves to their next station</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flow-card flow-empty">
          {freeMove
            ? "No patient selected. Pick one from the queue below."
            : "No patient in progress. Call in the next from your queue."}
        </div>
      )}

      {/* Queue — free-move: pick anyone into the box; else call-in order */}
      <div className="flow-sec-title">
        {freeMove ? "My queue — pick anyone" : "My queue — ready to call in"}
      </div>
      {listItems.length === 0 ? (
        <div className="flow-card flow-empty">No one waiting at this station.</div>
      ) : (
        listItems.map((s) => (
          <div
            key={s.id}
            className={`qitem${s.visit_urgency === "breach" ? " urgent" : s.visit_urgency === "atrisk" ? " amber" : ""}`}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>
                {s.patient_name} {s.is_vip ? "⭐" : ""}
              </div>
              <div className="flow-muted">
                {s.patient_age_sex || ""} · {s.file_no} · {s.visit_type_id} · Step {s.step_order} of{" "}
                {s.total_steps}
              </div>
              <div style={{ marginTop: 4 }}>
                <span className="flow-badge fb-ink">{s.visit_remaining_min}m left of visit</span>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="flow-muted">{fmtTime(s.checkin_time)}</div>
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  gap: 6,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                {freeMove ? (
                  <>
                    <button
                      className="flow-btn flow-btn-ghost"
                      disabled={advance.isPending}
                      title="Skip — patient still advances"
                      onClick={() => setSkipTarget(s)}
                    >
                      ⏭ Skip
                    </button>
                    <button
                      className="flow-btn flow-btn-primary"
                      title="Bring this patient into the form box"
                      onClick={() => moveIntoBox(s)}
                    >
                      ↑ Move in
                    </button>
                  </>
                ) : (
                  <button
                    className="flow-btn flow-btn-primary"
                    disabled={!!active || startStep.isPending}
                    title={active ? "Finish the current patient first" : "Call in"}
                    onClick={() => callIn(s.id)}
                  >
                    Call in
                  </button>
                )}
              </div>
            </div>
          </div>
        ))
      )}

      {/* Pending (waiting on a prior step — e.g. ABI queued after Blood Sample) */}
      {pending.length > 0 && (
        <>
          <div className="flow-sec-title" style={{ marginTop: 12 }}>
            Queued — waiting on an earlier step
          </div>
          {pending.map((s) => (
            <div key={s.id} className="qitem" style={{ opacity: 0.6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{s.patient_name}</div>
                <div className="flow-muted">
                  {s.file_no} · Step {s.step_order} of {s.total_steps} · queued after an earlier
                  step
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Skip-reason dialog (proper modal — replaces the native prompt) */}
      {skipTarget && (
        <div
          onClick={() => setSkipTarget(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.4)",
            zIndex: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flow-card"
            style={{ width: "100%", maxWidth: 380, borderRadius: 10 }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
              Skip “{skipTarget.step_name}”
            </div>
            <div className="flow-muted" style={{ marginBottom: 10 }}>
              {skipTarget.patient_name} · {skipTarget.file_no} — they’ll move to the next step. Pick
              or type a reason (optional).
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {SKIP_REASONS.map((r) => (
                <button
                  key={r}
                  className={`flow-btn ${skipReason === r ? "flow-btn-primary" : "flow-btn-ghost"}`}
                  style={{ padding: "5px 10px", fontSize: 12 }}
                  onClick={() => setSkipReason(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmSkip()}
              placeholder="Reason (optional)…"
              style={{ width: "100%", padding: "8px 10px", marginBottom: 12 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="flow-btn flow-btn-ghost" onClick={() => setSkipTarget(null)}>
                Cancel
              </button>
              <button
                className="flow-btn flow-btn-grn"
                disabled={advance.isPending}
                onClick={confirmSkip}
              >
                ⏭ Skip step
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Role-specific data-entry forms. Values are stored in step.data on advance.
function StationForm({ form, value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  if (form === "vitals") {
    return <VitalsForm value={value} onChange={onChange} />;
  }
  if (form === "lab") {
    return (
      <Field label="Result notes">
        <textarea
          rows={3}
          value={value.result_notes || ""}
          onChange={(e) => set("result_notes", e.target.value)}
          placeholder="Sample taken / result ready / notes…"
        />
      </Field>
    );
  }
  if (form === "pharmacy") {
    return (
      <Field label="Dispense notes">
        <textarea
          rows={2}
          value={value.dispense_notes || ""}
          onChange={(e) => set("dispense_notes", e.target.value)}
          placeholder="Medicines dispensed / stock notes…"
        />
      </Field>
    );
  }
  if (form === "rx") {
    return (
      <Field label="Explanation notes">
        <textarea
          rows={2}
          value={value.notes || ""}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Medicines explained · patient understood…"
        />
      </Field>
    );
  }
  return (
    <Field label="Notes">
      <textarea
        rows={3}
        value={value.notes || ""}
        onChange={(e) => set("notes", e.target.value)}
        placeholder="Notes / observations…"
      />
    </Field>
  );
}

// Core vitals (always shown) + an "+ Add vital" picker for extra standard or
// custom vitals, recorded per patient. Everything is stored in step.data, so
// any added key persists. Remounts per patient (keyed on the active step).
const OPTIONAL_VITALS = [
  ["temperature", "Temp (°F)"],
  ["rbs", "RBS (mg/dL)"],
  ["height", "Height (cm)"],
  ["bmi", "BMI"],
  ["waist", "Waist (cm)"],
  ["body_fat", "Body fat (%)"],
  ["muscle_mass", "Muscle mass (kg)"],
  ["resp_rate", "Resp. rate (/min)"],
  ["pain_score", "Pain (0–10)"],
];
const CORE_VITAL_KEYS = ["weight", "bp_sys", "bp_dia", "pulse", "spo2"];

function VitalsForm({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const removeKey = (k) => {
    const nv = { ...value };
    delete nv[k];
    onChange(nv);
    setExtras((a) => a.filter((e) => e.key !== k));
  };
  // Extra (optional/custom) vitals the associate has added for this patient.
  const [extras, setExtras] = useState(() =>
    Object.keys(value)
      .filter((k) => !CORE_VITAL_KEYS.includes(k))
      .map((k) => ({ key: k, label: OPTIONAL_VITALS.find((o) => o[0] === k)?.[1] || k })),
  );

  const addOptional = (key) => {
    const o = OPTIONAL_VITALS.find((x) => x[0] === key);
    if (!o || extras.some((e) => e.key === key)) return;
    setExtras((a) => [...a, { key, label: o[1] }]);
  };
  const addCustom = () => {
    const label = window.prompt("Name of vital (e.g. Grip strength, GRBS, Temp axilla):");
    if (!label || !label.trim()) return;
    const key =
      "x_" +
      label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    if (!key || extras.some((e) => e.key === key)) return;
    setExtras((a) => [...a, { key, label: label.trim() }]);
  };
  const remaining = OPTIONAL_VITALS.filter((o) => !extras.some((e) => e.key === o[0]));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <Field label="Weight (kg)">
          <input
            type="number"
            value={value.weight || ""}
            onChange={(e) => set("weight", e.target.value)}
          />
        </Field>
        <Field label="BP (mmHg)">
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Sys"
              value={value.bp_sys || ""}
              onChange={(e) => set("bp_sys", e.target.value)}
            />
            <span>/</span>
            <input
              type="number"
              placeholder="Dia"
              value={value.bp_dia || ""}
              onChange={(e) => set("bp_dia", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Pulse (bpm)">
          <input
            type="number"
            value={value.pulse || ""}
            onChange={(e) => set("pulse", e.target.value)}
          />
        </Field>
        <Field label="SpO2 (%)">
          <input
            type="number"
            value={value.spo2 || ""}
            onChange={(e) => set("spo2", e.target.value)}
          />
        </Field>
        {extras.map((ex) => (
          <Field
            key={ex.key}
            label={
              <span
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                {ex.label}
                <button
                  onClick={() => removeKey(ex.key)}
                  title="Remove"
                  style={{
                    border: "none",
                    background: "none",
                    color: "var(--fre)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              </span>
            }
          >
            <input value={value[ex.key] || ""} onChange={(e) => set(ex.key, e.target.value)} />
          </Field>
        ))}
      </div>
      <select
        className="jb-add"
        style={{ marginTop: 8, maxWidth: 260 }}
        value=""
        onChange={(e) => {
          if (e.target.value === "__custom") addCustom();
          else if (e.target.value) addOptional(e.target.value);
          e.target.value = "";
        }}
      >
        <option value="">+ Add vital…</option>
        {remaining.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
        <option value="__custom">Custom…</option>
      </select>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flow-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
