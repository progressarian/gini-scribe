import { useEffect, useMemo, useRef, useState } from "react";
import {
  useVitalsQueue,
  useVitalsPatient,
  useSaveVitals,
  useStartVitals,
} from "../../queries/hooks/useGiniflowVitals";
import { useVoiceVitals } from "../../hooks/useVoiceVitals";
import { SPOKEN_EXAMPLE } from "../../../shared/giniflowVitalsSpeech";
import "../../styles/giniflow-station.css";

const CATEGORY_BADGE = {
  worse_out_of_range: { cls: "b-red", label: "🔴 Red" },
  worse_in_range: { cls: "b-amb", label: "🟠 Amber" },
  getting_better: { cls: "b-amb", label: "🟡 Getting better" },
  in_control: { cls: "b-grn", label: "✅ Green" },
  no_reports: { cls: "b-blu", label: "🔵 No reports" },
};

// Physiological bounds, matching the server's Zod schema. A typo here becomes a
// number a doctor may act on, so the field says so before the save is allowed.
const BOUNDS = {
  weight: [1, 400],
  height: [30, 260],
  bpSys: [50, 300],
  bpDia: [20, 200],
  pulse: [20, 250],
  spo2: [50, 100],
  temp: [90, 115],
};

const EMPTY = { weight: "", height: "", bpSys: "", bpDia: "", pulse: "", spo2: "", temp: "" };

const FIELD_LABEL = {
  weight: "weight",
  height: "height",
  bpSys: "BP",
  bpDia: "BP",
  pulse: "pulse",
  spo2: "SpO2",
  temp: "temperature",
};

const FILLED_LABEL = (fields) => [...new Set(fields.map((f) => FIELD_LABEL[f] || f))].join(", ");

const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

const outOfRange = (field, value) => {
  const n = num(value);
  if (n === null || Number.isNaN(n)) return value !== "";
  const [lo, hi] = BOUNDS[field];
  return n < lo || n > hi;
};

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : null;

export default function VitalsStationPage() {
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [toast, setToast] = useState("");
  const [spokeAnything, setSpokeAnything] = useState(false);
  const toastTimer = useRef(null);

  const { data: queueData, isLoading } = useVitalsQueue();
  const saveVitals = useSaveVitals();
  const startVitals = useStartVitals();

  const queue = queueData?.queue || [];

  // Derived, not set in an effect: the screen opens on whoever is at the station
  // with no click and no flash of the empty state.
  const activeVisitId = selected ?? queue[0]?.visitId ?? null;
  const { data: patient } = useVitalsPatient(activeVisitId);

  // A different patient means a fresh form — never carry one patient's numbers
  // onto another's record.
  useEffect(() => {
    if (!patient) return;
    const r = patient.recorded;
    setForm(
      r
        ? {
            weight: r.weight ?? "",
            height: r.height ?? "",
            bpSys: r.bp_sys ?? "",
            bpDia: r.bp_dia ?? "",
            pulse: r.pulse ?? "",
            spo2: r.spo2 ?? "",
            temp: r.temp ?? "",
          }
        : { ...EMPTY, height: patient.lastVisit?.height ?? "" },
    );
    setSpokeAnything(false);
  }, [patient?.visitId, patient?.recorded, patient?.lastVisit?.height]);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  // Voice fills the fields it heard and leaves the rest alone, so a nurse can
  // speak the four common readings and type the two that vary.
  const voice = useVoiceVitals({
    onFields: (values) => {
      setForm((f) => {
        const next = { ...f };
        for (const [k, v] of Object.entries(values)) next[k] = String(v);
        return next;
      });
      setSpokeAnything(true);
    },
  });

  const bmi = useMemo(() => {
    const w = num(form.weight);
    const h = num(form.height);
    if (!w || !h) return null;
    return (w / (h / 100) ** 2).toFixed(1);
  }, [form.weight, form.height]);

  const last = patient?.lastVisit;
  const weightDelta = useMemo(() => {
    const w = num(form.weight);
    if (!w || !last?.weight) return null;
    const d = w - Number(last.weight);
    if (Math.abs(d) < 0.05) return "same as last visit";
    return `${d > 0 ? "↑" : "↓"} ${Math.abs(d).toFixed(1)} kg from last visit`;
  }, [form.weight, last]);

  const selectedId = activeVisitId;

  const invalid = Object.keys(BOUNDS).filter((f) => form[f] !== "" && outOfRange(f, form[f]));
  const anyEntered = Object.values(form).some((v) => v !== "");
  const canSave = anyEntered && invalid.length === 0 && !saveVitals.isPending;

  const pick = (visitId) => {
    setSelected(visitId);
    startVitals.mutate(visitId);
  };

  const submit = () => {
    saveVitals.mutate(
      {
        visitId: selectedId,
        weight: num(form.weight),
        height: num(form.height),
        bpSys: num(form.bpSys),
        bpDia: num(form.bpDia),
        pulse: num(form.pulse),
        spo2: num(form.spo2),
        temp: num(form.temp),
        source: spokeAnything ? "voice" : "manual",
      },
      {
        onSuccess: () => {
          showToast(`✓ ${patient?.name?.split(" ")[0] || "Patient"} moved to the MO queue`);
          // Auto-advance to the next patient, as the prototype does.
          const next = queue.find((q) => q.visitId !== selectedId);
          setSelected(next ? next.visitId : null);
        },
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not save — nothing was recorded"),
      },
    );
  };

  const badge = CATEGORY_BADGE[patient?.category] || null;

  return (
    <div className="gf">
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--blu-l)", color: "var(--blu)" }}>
          ⚖️ Vitals Station
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge b-blu">{queue.length} in queue</span>
          <span className="badge b-grn">{queueData?.doneToday ?? 0} done today</span>
          {/* A real link, not a router push: this is navigation to another page,
              it works without JS, and it keeps the station screen free of a
              router dependency. */}
          <a className="tr-back" href="/giniflow/manager">
            ← Board
          </a>
        </div>
      </div>

      <div className="station-layout">
        <div className="squeue">
          <div className="sq-header">
            <div className="sq-title">Vitals queue</div>
            <div className="sq-sub">Tap patient to start</div>
          </div>
          {isLoading && <div className="sq-foot">Loading…</div>}
          {!isLoading && queue.length === 0 && (
            <div className="sq-foot">Nobody waiting for vitals right now.</div>
          )}
          {queue.map((q) => (
            <button
              type="button"
              key={q.visitId}
              className={`sq-item${q.visitId === activeVisitId ? " active" : ""}`}
              onClick={() => pick(q.visitId)}
            >
              <div className="si-slot">{q.slot}</div>
              <div className="si-name">{q.name}</div>
              <div className="si-meta">
                {q.age}
                {(q.sex || "")[0] || ""} · {q.fileNo} · Visit {q.visitNumber}
                {CATEGORY_BADGE[q.category] ? ` · ${CATEGORY_BADGE[q.category].label}` : ""}
              </div>
              {q.bios?.length > 0 && (
                <div className="si-bios">
                  {q.bios.map((b) => (
                    <span key={b.label} className={`sbio sbio-${b.tone}`}>
                      {b.label}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
          <div className="sq-foot">✓ Done today: {queueData?.doneToday ?? 0} patients</div>
        </div>

        <div className="station-detail">
          {!patient && <div className="sd-empty">Select a patient from the queue.</div>}
          {patient && (
            <>
              <div className="sd-header">
                <div className="sdh-body">
                  <div className="sdh-name">{patient.name}</div>
                  <div className="sdh-meta">
                    {patient.age}
                    {(patient.sex || "")[0] || ""} · {patient.fileNo} · Visit {patient.visitNumber}
                    {clock(patient.checkedInAt)
                      ? ` · Checked in ${clock(patient.checkedInAt)}`
                      : ""}
                  </div>
                </div>
                <div className="sdh-acts">
                  {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
                </div>
              </div>

              <div className="sd-body">
                <div className="voice-bar">
                  <button
                    className={`voice-pill${voice.listening ? " listening" : ""}`}
                    onClick={voice.toggle}
                    disabled={voice.busy}
                  >
                    <span className="voice-dot" />{" "}
                    {voice.busy ? "Reading back…" : voice.listening ? "Stop" : "Speak vitals"}
                  </button>
                  <div className="vb-desc">
                    {voice.listening ? (
                      <>
                        <strong>Listening…</strong>{" "}
                        {voice.live
                          ? "say it in one go — the words appear below as you speak."
                          : "say it in one go, then press Stop."}
                      </>
                    ) : (
                      <>
                        <strong>Just say it:</strong> "{SPOKEN_EXAMPLE}" — the fields fill
                        themselves. Check them before pressing Done.
                      </>
                    )}
                  </div>
                </div>

                {/* The live caption: what the recogniser is hearing, right now. A
                    wrong number is visible while the nurse is still speaking,
                    instead of after the form has been filled from it. */}
                {(voice.listening || voice.caption) && (
                  <div className={`caption${voice.listening ? " live" : ""}`}>
                    {voice.listening && <span className="cap-dot" />}
                    <span className="cap-text">
                      {voice.caption ||
                        (voice.live ? "Listening…" : "Recording — press Stop when done")}
                    </span>
                    {!voice.listening && (
                      <button className="cap-clear" onClick={voice.clear} aria-label="Clear">
                        ✕
                      </button>
                    )}
                  </div>
                )}

                {voice.error && <div className="voice-note voice-err">⚠ {voice.error}</div>}

                {voice.result && (
                  <div className="voice-note">
                    <div className="vn-detail">
                      {voice.result.filled.length
                        ? `Filled ${FILLED_LABEL(voice.result.filled)} — check each one against what you said.`
                        : "No readings recognised — type them instead."}
                      {voice.result.rejected.length
                        ? ` Ignored ${voice.result.rejected
                            .map((r) => `${r.field} "${r.heard}"`)
                            .join(", ")} as a mishearing.`
                        : ""}
                    </div>
                  </div>
                )}

                {last ? (
                  <div className="last-visit">
                    Last visit:{" "}
                    <strong>
                      {[
                        last.weight != null ? `Weight ${Number(last.weight).toFixed(1)} kg` : null,
                        last.bp_sys && last.bp_dia ? `BP ${last.bp_sys}/${last.bp_dia}` : null,
                        last.pulse != null ? `Pulse ${last.pulse}` : null,
                        last.spo2 != null ? `SpO2 ${last.spo2}%` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "no readings recorded"}
                    </strong>
                  </div>
                ) : (
                  <div className="last-visit">No previous vitals on record for this patient.</div>
                )}

                <div className="vitals-grid">
                  <div className="vf">
                    <div className="vf-lbl">Weight (kg)</div>
                    <input
                      className={`vf-inp${outOfRange("weight", form.weight) ? " bad" : form.weight ? " ok" : ""}`}
                      type="number"
                      step="0.1"
                      inputMode="decimal"
                      value={form.weight}
                      onChange={set("weight")}
                    />
                    <div className="vf-unit">{weightDelta || "kg"}</div>
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Height (cm)</div>
                    <input
                      className={`vf-inp${outOfRange("height", form.height) ? " bad" : form.height ? " ok" : ""}`}
                      type="number"
                      inputMode="decimal"
                      value={form.height}
                      onChange={set("height")}
                    />
                    <div className="vf-unit">{bmi ? `BMI auto: ${bmi}` : "cm"}</div>
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Blood pressure</div>
                    <div className="vf-bp">
                      <input
                        className={`vf-inp${outOfRange("bpSys", form.bpSys) ? " bad" : ""}`}
                        type="number"
                        inputMode="numeric"
                        placeholder="Sys"
                        style={{ flex: 1 }}
                        value={form.bpSys}
                        onChange={set("bpSys")}
                      />
                      <span>/</span>
                      <input
                        className={`vf-inp${outOfRange("bpDia", form.bpDia) ? " bad" : ""}`}
                        type="number"
                        inputMode="numeric"
                        placeholder="Dia"
                        style={{ flex: 1 }}
                        value={form.bpDia}
                        onChange={set("bpDia")}
                      />
                    </div>
                    <div className="vf-unit">
                      mmHg{last?.bp_sys ? ` · Last: ${last.bp_sys}/${last.bp_dia}` : ""}
                    </div>
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Pulse (bpm)</div>
                    <input
                      className={`vf-inp${outOfRange("pulse", form.pulse) ? " bad" : ""}`}
                      type="number"
                      inputMode="numeric"
                      placeholder="e.g. 82"
                      value={form.pulse}
                      onChange={set("pulse")}
                    />
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">SpO2 (%)</div>
                    <input
                      className={`vf-inp${outOfRange("spo2", form.spo2) ? " bad" : ""}`}
                      type="number"
                      inputMode="numeric"
                      placeholder="e.g. 98"
                      value={form.spo2}
                      onChange={set("spo2")}
                    />
                  </div>
                  <div className="vf">
                    <div className="vf-lbl">Temperature (°F)</div>
                    <input
                      className={`vf-inp${outOfRange("temp", form.temp) ? " bad" : ""}`}
                      type="number"
                      step="0.1"
                      inputMode="decimal"
                      placeholder="98.6"
                      value={form.temp}
                      onChange={set("temp")}
                    />
                  </div>
                </div>

                <div className={`done-bar${canSave ? "" : " pending"}`}>
                  <div className="db-text">
                    <div className="db-title">
                      {invalid.length
                        ? "⚠ Check the highlighted readings"
                        : anyEntered
                          ? "✓ Vitals done"
                          : "Enter the readings"}
                    </div>
                    <div className="db-sub">
                      {invalid.length
                        ? "A value is outside the plausible range — correct it before saving"
                        : "Patient moves to the MO queue automatically"}
                    </div>
                  </div>
                  <button className="db-btn" disabled={!canSave} onClick={submit}>
                    {saveVitals.isPending ? "Saving…" : "Done →"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
