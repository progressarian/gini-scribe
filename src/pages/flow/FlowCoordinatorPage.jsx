import { useMemo, useState } from "react";
import {
  useFlowVisits,
  useFlowStartTimer,
  useFlowStopTimer,
  useFlowCancel,
} from "../../queries/hooks/useFlow";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";
import VisitDetailModal from "../../components/flow/VisitDetailModal";
import "../../styles/flow.css";

// OPD/GHM-aligned stage labels — same vocabulary as the OPD pages.
const STAGE_LABEL = {
  waiting: "Waiting",
  checkedin: "Checked-in",
  in_visit: "In-visit",
  seen: "Seen",
  billing: "Billing",
  at_pharmacy: "At pharmacy",
  completed: "Done",
  cancelled: "Cancelled",
};

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const initials = (name) =>
  (name || "")
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

// One journey step → coloured pill. `now` is frozen (= paused_at) for paused
// visits so the in-progress step's overage stops growing while paused.
function StepPills({ steps, now = Date.now() }) {
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
              ? Math.round((now - new Date(s.started_at).getTime()) / 60000) -
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
  const { data: allVisits = [], isLoading, dataUpdatedAt } = useFlowVisits();
  // Cancelled check-ins (mistaken / not-present) don't belong on the live floor.
  const visits = useMemo(() => allVisits.filter((v) => v.status !== "cancelled"), [allVisits]);
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState("");
  const [cancelTarget, setCancelTarget] = useState(null); // visit pending cancel-confirm
  const startTimer = useFlowStartTimer();
  const stopTimer = useFlowStopTimer();
  const cancelVisit = useFlowCancel();

  // Free-text filter for the patient rows — name, file number, age/sex, visit
  // type, or assigned SD/Chief. Stats/occupancy/doctor-load stay on the full set.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visits;
    return visits.filter((v) =>
      [
        v.patient_name,
        v.patient_id,
        v.patient_age_sex,
        v.visit_type_id,
        v.assigned_sd_name,
        v.assigned_chief_name,
      ]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q)),
    );
  }, [visits, query]);

  const handleStartTimer = async (e, v) => {
    e.stopPropagation();
    try {
      await startTimer.mutateAsync(v.id);
      toast(
        v.status === "paused"
          ? `Resumed timer for ${v.patient_name}`
          : `Timer started for ${v.patient_name}`,
        "success",
      );
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const handleStopTimer = async (e, v) => {
    e.stopPropagation();
    try {
      const res = await stopTimer.mutateAsync(v.id);
      toast(
        res?.status === "paused"
          ? `Paused ${v.patient_name} — elapsed kept; press ▶ Resume to continue`
          : `Timer stopped — ${v.patient_name} back to waiting`,
        "success",
      );
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const confirmCancel = async () => {
    const v = cancelTarget;
    if (!v) return;
    try {
      await cancelVisit.mutateAsync({ visitId: v.id, reason: "coordinator_cancel" });
      toast(`Check-in cancelled for ${v.patient_name}`, "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setCancelTarget(null);
    }
  };

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
        <div
          className="flow-sec-title"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>
            All patients{" "}
            <span className="flow-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              sorted by urgency · click to manage
              {query.trim() ? ` · ${filtered.length}/${visits.length} shown` : ""}
            </span>
          </span>
          <div className="flow-field" style={{ position: "relative", minWidth: 220 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="🔍 Search name / file / doctor…"
              style={{ paddingRight: query ? 26 : undefined }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="Clear search"
                style={{
                  position: "absolute",
                  right: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: "var(--fink3)",
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
        {isLoading ? (
          <div className="flow-card flow-empty">Loading…</div>
        ) : visits.length === 0 ? (
          <div className="flow-card flow-empty">No patients in flow today.</div>
        ) : filtered.length === 0 ? (
          <div className="flow-card flow-empty">No patients match “{query.trim()}”.</div>
        ) : (
          filtered.map((v) => {
            const t = v._timing || {};
            // Paused visits freeze their step pills at paused_at.
            const rowNow =
              v.status === "paused" && v.paused_at ? new Date(v.paused_at).getTime() : undefined;
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
                    <StepPills steps={v.steps || []} now={rowNow} />
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
                  <div className={`cp-bignum ${numColour}`}>
                    {v.status === "waiting" ? "—" : `${t.elapsed_min}m`}
                  </div>
                  {v.status === "waiting" ? (
                    <span
                      className="flow-badge fb-amb"
                      style={{ marginTop: 3 }}
                      title="Timer not started yet"
                    >
                      ⏸ Waiting
                    </span>
                  ) : v.status === "paused" ? (
                    <span
                      className="flow-badge fb-amb"
                      style={{ marginTop: 3 }}
                      title="Timer paused — elapsed frozen"
                    >
                      ⏸ Paused
                    </span>
                  ) : (
                    <span
                      className={`flow-badge ${cls === "breach" ? "fb-red" : cls === "atrisk" ? "fb-amb" : v.status === "completed" ? "fb-grn" : "fb-blu"}`}
                      style={{ marginTop: 3 }}
                      title={
                        t.urgency === "breach"
                          ? "Over benchmark"
                          : t.urgency === "atrisk"
                            ? "Near benchmark"
                            : ""
                      }
                    >
                      {STAGE_LABEL[v.stage] || "Active"}
                      {t.urgency === "breach" ? " ⚠" : t.urgency === "atrisk" ? " ⏱" : ""}
                    </span>
                  )}
                  {(v.status === "waiting" || v.status === "paused") && (
                    <button
                      className="flow-btn flow-btn-primary"
                      style={{ marginTop: 6, padding: "3px 10px" }}
                      disabled={startTimer.isPending}
                      onClick={(e) => handleStartTimer(e, v)}
                      title={
                        v.status === "paused"
                          ? "Resume the timer (continues from where it paused)"
                          : "Start the visit timer now"
                      }
                    >
                      {v.status === "paused" ? "▶ Resume" : "▶ Start"}
                    </button>
                  )}
                  {v.status === "in_progress" && (
                    <button
                      className="flow-btn flow-btn-ghost"
                      style={{ marginTop: 6, padding: "3px 8px" }}
                      disabled={stopTimer.isPending}
                      onClick={(e) => handleStopTimer(e, v)}
                      title="Stop the timer — pauses if the journey has begun, else resets to waiting"
                    >
                      ⏸ Stop
                    </button>
                  )}
                  {(v.status === "in_progress" ||
                    v.status === "waiting" ||
                    v.status === "paused") && (
                    <button
                      className="flow-btn flow-btn-ghost"
                      style={{
                        marginTop: 6,
                        padding: "3px 8px",
                        color: "var(--fre)",
                        borderColor: "var(--fre)",
                      }}
                      disabled={cancelVisit.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCancelTarget(v);
                      }}
                      title="Cancel this check-in (mistaken / patient not present)"
                    >
                      ✕ Cancel
                    </button>
                  )}
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

      {openVisit && <VisitDetailModal visit={openVisit} onClose={() => setOpenId(null)} />}

      <ConfirmModal
        open={!!cancelTarget}
        title="Cancel check-in?"
        message={
          cancelTarget
            ? `Remove ${cancelTarget.patient_name} from the patient flow. Use this for a mistaken check-in or a patient who isn't present. This cannot be undone.`
            : ""
        }
        confirmLabel="Cancel check-in"
        cancelLabel="Keep"
        onConfirm={confirmCancel}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
