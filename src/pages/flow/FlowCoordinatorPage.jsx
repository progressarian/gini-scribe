import { useMemo, useState } from "react";
import { toast } from "../../stores/uiStore";
import {
  useFlowVisits,
  useFlowAdvance,
  useFlowEditDuration,
  useFlowRemoveStep,
} from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const initials = (name) =>
  (name || "")
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

// One journey step → coloured pill.
function StepPills({ steps }) {
  return (
    <div className="j-steps">
      {steps
        .filter((s) => s.status !== "skipped")
        .map((s, i, arr) => {
          let cls = "j-next";
          let label = s.step_name;
          if (s.status === "completed") {
            cls = "j-done";
            label = `${shorten(s.step_name)} ✓`;
          } else if (s.status === "in_progress") {
            const over = s.started_at
              ? Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000) -
                s.planned_duration_min
              : 0;
            cls = over > 5 ? "j-over" : "j-now";
            label = over > 5 ? `${shorten(s.step_name)} ⚠ ${over}m` : `🔸 ${shorten(s.step_name)}`;
          } else {
            label = shorten(s.step_name);
          }
          return (
            <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              <span className={`j-step ${cls}`}>{label}</span>
              {i < arr.length - 1 && <span className="j-arrow">→</span>}
            </span>
          );
        })}
    </div>
  );
}
const shorten = (n) =>
  n
    .replace(/ \(.*\)$/, "")
    .replace("Prescription Explain", "Rx")
    .replace("Pharmacy / Exit", "Pharmacy");

export default function FlowCoordinatorPage() {
  const { data: visits = [], isLoading, dataUpdatedAt } = useFlowVisits();
  const [openId, setOpenId] = useState(null);

  const stats = useMemo(() => {
    const active = visits.filter((v) => v.status === "in_progress");
    const completed = visits.filter((v) => v.status === "completed");
    const breached = active.filter((v) => v._timing?.urgency === "breach");
    const atrisk = active.filter((v) => v._timing?.urgency === "atrisk");
    const withDocs = active.filter((v) => {
      const cur = v.steps?.find((s) => s.status === "in_progress");
      return cur && ["sd", "chief"].includes(cur.assigned_role);
    });
    const avgWait = completed.length
      ? Math.round(
          completed.reduce((a, v) => a + (v._timing?.elapsed_min || 0), 0) / completed.length,
        )
      : 0;
    return { active, completed, breached, atrisk, withDocs, avgWait };
  }, [visits]);

  const occupancy = useMemo(() => {
    const m = {};
    visits
      .filter((v) => v.status === "in_progress")
      .forEach((v) => {
        const cur = v.steps?.find((s) => s.status === "in_progress");
        if (cur) m[cur.station] = (m[cur.station] || 0) + 1;
      });
    return m;
  }, [visits]);

  // Per-doctor load from active visits: how many patients assigned to each
  // SD/Chief, how many are with them right now, and how many overdue.
  const doctorLoad = useMemo(() => {
    const m = {};
    const bump = (name, role, v) => {
      if (!name) return;
      m[name] = m[name] || { name, assigned: 0, withPatient: 0, overdue: 0 };
      m[name].assigned++;
      const cur = v.steps?.find((s) => s.status === "in_progress");
      if (cur && cur.assigned_role === role) {
        m[name].withPatient++;
        const over = cur.started_at
          ? Math.round((Date.now() - new Date(cur.started_at).getTime()) / 60000) -
            cur.planned_duration_min
          : 0;
        if (over > 5) m[name].overdue++;
      }
    };
    visits
      .filter((v) => v.status === "in_progress")
      .forEach((v) => {
        bump(v.assigned_sd_name, "sd", v);
        bump(v.assigned_chief_name, "chief", v);
      });
    return Object.values(m).sort((a, b) => b.assigned - a.assigned);
  }, [visits]);
  const maxAssigned = Math.max(1, ...doctorLoad.map((d) => d.assigned));

  const breaching = stats.breached.concat(stats.atrisk);
  const openVisit = visits.find((v) => v.id === openId);

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div
          className="flow-header"
          style={{ background: "var(--faml)", borderColor: "var(--fam)" }}
        >
          <div>
            <div className="flow-title" style={{ color: "var(--fam)" }}>
              📋 Flow Coordinator
            </div>
            <div className="flow-sub">Real-time floor · time tracking · bottleneck alerts</div>
          </div>
          <div className="flow-header-right">
            <span className="flow-live">
              <span className="flow-dot" /> Live · 15s
            </span>
            {dataUpdatedAt ? (
              <span className="flow-muted">updated {fmtTime(dataUpdatedAt)}</span>
            ) : null}
          </div>
        </div>

        {/* Stats */}
        <div className="flow-stats">
          <div className="flow-stat">
            <div className="flow-stat-val">{stats.active.length}</div>
            <div className="flow-stat-lbl">Active</div>
          </div>
          <div className="flow-stat" style={{ borderColor: "var(--fgn)" }}>
            <div className="flow-stat-val f-grn">{stats.completed.length}</div>
            <div className="flow-stat-lbl">Completed</div>
            <div className="flow-stat-sub">Avg {stats.avgWait}m</div>
          </div>
          <div
            className="flow-stat"
            style={{ borderColor: "var(--fre)", background: "var(--frel)" }}
          >
            <div className="flow-stat-val f-red">{stats.breached.length}</div>
            <div className="flow-stat-lbl">Breached</div>
          </div>
          <div className="flow-stat" style={{ borderColor: "var(--fam)" }}>
            <div className="flow-stat-val f-amb">{stats.atrisk.length}</div>
            <div className="flow-stat-lbl">At risk</div>
          </div>
          <div className="flow-stat" style={{ borderColor: "var(--flv)" }}>
            <div className="flow-stat-val" style={{ color: "var(--flv)" }}>
              {stats.withDocs.length}
            </div>
            <div className="flow-stat-lbl">With doctors</div>
          </div>
        </div>

        {/* Breach alerts */}
        {breaching.length > 0 && (
          <div className="flow-alert flow-alert-red">
            <span style={{ fontSize: 16 }}>⚠</span>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                {breaching.length} patient(s) need attention
              </div>
              {breaching.slice(0, 4).map((v) => (
                <div key={v.id}>
                  <b>{v.patient_name}</b> — {v.visit_type_id} · {v._timing.elapsed_min}/
                  {v.max_time_min} min
                  {v.bottleneck
                    ? ` · stuck at "${shorten(v.bottleneck.step_name)}" ${v.bottleneck.at_station_min}m (budget ${v.bottleneck.planned_duration_min})`
                    : ""}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Patient flow rows */}
        <div className="flow-sec-title">
          All patients{" "}
          <span className="flow-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
            sorted by urgency · click to manage
          </span>
        </div>
        {isLoading ? (
          <div className="flow-card flow-empty">Loading…</div>
        ) : visits.length === 0 ? (
          <div className="flow-card flow-empty">No patients in flow today.</div>
        ) : (
          visits.map((v) => {
            const t = v._timing || {};
            const cls =
              v.status === "completed"
                ? "done"
                : t.urgency === "breach"
                  ? "breach"
                  : t.urgency === "atrisk"
                    ? "atrisk"
                    : "";
            const tb =
              t.urgency === "breach" ? "tb-red" : t.urgency === "atrisk" ? "tb-amb" : "tb-grn";
            const numColour =
              t.urgency === "breach"
                ? "f-red"
                : t.urgency === "atrisk"
                  ? "f-amb"
                  : v.status === "completed"
                    ? "f-grn"
                    : "";
            return (
              <div key={v.id} className={`cp-row ${cls}`} onClick={() => setOpenId(v.id)}>
                <div className="cp-left">
                  <div className="cp-avatar">{initials(v.patient_name)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="cp-name">
                      {v.patient_name}{" "}
                      {v.is_vip ? <span className="flow-badge fb-amb">⭐ VIP</span> : null}
                    </div>
                    <div className="cp-meta">
                      {v.patient_age_sex || ""} · {v.visit_type_id} · {v.patient_id} · In{" "}
                      {fmtTime(v.checkin_time)}
                    </div>
                    <StepPills steps={v.steps || []} />
                  </div>
                </div>
                <div className="cp-center">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 10,
                      color: "var(--fink3)",
                      marginBottom: 3,
                    }}
                  >
                    <span>
                      Elapsed <b className={numColour}>{t.elapsed_min}m</b>
                    </span>
                    <span>Target {v.max_time_min}m</span>
                    <span className={numColour} style={{ fontWeight: 700 }}>
                      {v.status === "completed" ? "✓ done" : `${t.remaining_min}m left`}
                    </span>
                  </div>
                  <div className="time-bar">
                    <div
                      className={`time-bar-fill ${tb}`}
                      style={{ width: `${Math.min(100, t.pct_elapsed || 0)}%` }}
                    />
                  </div>
                  {v.bottleneck && (
                    <div
                      style={{ fontSize: 10, color: "var(--fre)", marginTop: 4, fontWeight: 700 }}
                    >
                      ⚠ {shorten(v.bottleneck.step_name)} — {v.bottleneck.at_station_min}m on{" "}
                      {v.bottleneck.planned_duration_min}m budget
                    </div>
                  )}
                </div>
                <div className="cp-right">
                  <div className={`cp-bignum ${numColour}`}>{t.elapsed_min}m</div>
                  <span
                    className={`flow-badge ${cls === "breach" ? "fb-red" : cls === "atrisk" ? "fb-amb" : v.status === "completed" ? "fb-grn" : "fb-blu"}`}
                    style={{ marginTop: 3 }}
                  >
                    {v.status === "completed" ? "DONE" : (t.urgency || "active").toUpperCase()}
                  </span>
                </div>
              </div>
            );
          })
        )}

        {/* Station occupancy */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div className="flow-card">
            <div className="flow-sec-title">Station occupancy · live</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {Object.keys(occupancy).length === 0 && (
                <div className="flow-muted">All stations idle.</div>
              )}
              {Object.entries(occupancy).map(([station, n]) => (
                <div
                  key={station}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "var(--fskl)",
                    border: "1px solid var(--fsk)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700 }}>{station}</span>
                  <span className="flow-badge fb-blu">{n} active</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flow-card">
            <div className="flow-sec-title">Doctor load · live</div>
            {doctorLoad.length === 0 ? (
              <div className="flow-muted">No doctors assigned in today's flow yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {doctorLoad.map((d) => {
                  const idle = d.withPatient === 0;
                  const colour = d.overdue ? "var(--fre)" : idle ? "var(--fgn)" : "var(--fam)";
                  const note = d.overdue
                    ? `${d.overdue} overdue`
                    : idle
                      ? "IDLE ← can reassign here"
                      : `${d.withPatient} with patient`;
                  return (
                    <div key={d.name}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11,
                          marginBottom: 3,
                        }}
                      >
                        <span style={{ fontWeight: 700 }}>{d.name}</span>
                        <span style={{ color: colour }}>
                          {d.assigned} assigned · {note}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 6,
                          background: "var(--fbd)",
                          borderRadius: 3,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.round((d.assigned / maxAssigned) * 100)}%`,
                            background: colour,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {openVisit && <DetailModal visit={openVisit} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// Lightweight patient detail / management modal.
function DetailModal({ visit, onClose }) {
  const advance = useFlowAdvance();
  const editDur = useFlowEditDuration();
  const removeStep = useFlowRemoveStep();

  const act = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 500,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        overflow: "auto",
      }}
    >
      <div
        className="flow-root"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: "100%", padding: 0, borderRadius: 10, minHeight: 0 }}
      >
        <div className="flow-card" style={{ borderRadius: 10 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <div>
              <div className="flow-title" style={{ fontSize: 16 }}>
                {visit.patient_name} {visit.is_vip ? "⭐" : ""}
              </div>
              <div className="flow-sub">
                {visit.patient_id} · {visit.visit_type_id} · {visit._timing?.elapsed_min}/
                {visit.max_time_min} min
              </div>
            </div>
            <button className="flow-btn flow-btn-ghost" onClick={onClose}>
              ✕ Close
            </button>
          </div>

          {visit.steps?.map((s) => (
            <div key={s.id} className="jb-step">
              <span
                className="jb-name"
                style={{
                  textDecoration: s.status === "skipped" ? "line-through" : "none",
                  opacity: s.status === "skipped" ? 0.5 : 1,
                }}
              >
                {s.step_order}. {s.step_name}
                <span
                  className={`flow-badge ${s.status === "completed" ? "fb-grn" : s.status === "in_progress" ? "fb-blu" : "fb-ink"}`}
                  style={{ marginLeft: 6 }}
                >
                  {s.status}
                </span>
              </span>
              <input
                className="jb-dur"
                type="number"
                min="0"
                defaultValue={s.planned_duration_min}
                disabled={s.status === "completed"}
                onBlur={(e) => {
                  const v = parseInt(e.target.value);
                  if (v !== s.planned_duration_min)
                    act(
                      () => editDur.mutateAsync({ stepId: s.id, new_duration_min: v }),
                      "Duration updated",
                    );
                }}
              />
              {!["completed", "skipped"].includes(s.status) && (
                <button
                  className="jb-remove"
                  title="Remove / skip step"
                  onClick={() => act(() => removeStep.mutateAsync(s.id), "Step removed")}
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          {visit.status === "in_progress" && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                className="flow-btn flow-btn-grn"
                style={{ flex: 1 }}
                disabled={advance.isPending}
                onClick={() => act(() => advance.mutateAsync({ visitId: visit.id }), "Advanced")}
              >
                ✓ Force-advance current step
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
