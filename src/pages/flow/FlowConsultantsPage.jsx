import { useMemo, useState } from "react";
import useAuthStore from "../../stores/authStore";
import { useFlowVisits } from "../../queries/hooks/useFlow";
import StationSwitcher from "../../components/flow/StationSwitcher";
import ConsultantLoadBoard from "../../components/flow/ConsultantLoadBoard";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions";
import "../../styles/flow.css";

const waitedMin = (t) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Where a patient is, and whether their consultation is done. The SD step is
// the one that matters here — the visit can still be open while the
// consultation itself is finished.
const consultState = (v) => {
  const sd = (v.steps || []).find((s) => s.assigned_role === "sd");
  if (!sd) return { label: "no consultation step", cls: "fb-ink" };
  if (sd.status === "completed") return { label: "consultation done", cls: "fb-grn" };
  if (sd.status === "skipped") return { label: "consultation skipped", cls: "fb-ink" };
  if (sd.status === "in_progress") return { label: "with the consultant now", cls: "fb-blu" };
  return { label: "waiting for consultation", cls: "fb-amb" };
};

// The visit record's own state. "visit closed" rather than "left": the record is
// usually closed by the HealthRay sync, not by anyone watching the patient walk
// out, so the label should not claim more than the data knows.
const visitState = (v) =>
  ({
    completed: { label: "visit closed", cls: "fb-grn" },
    cancelled: { label: "cancelled", cls: "fb-ink" },
    waiting: { label: "timer not started", cls: "fb-amb" },
    paused: { label: "paused", cls: "fb-amb" },
    in_progress: { label: "in the building", cls: "fb-blu" },
  })[v.status] || { label: v.status, cls: "fb-ink" };

const currentStepOf = (v) => {
  const steps = (v.steps || []).slice().sort((a, b) => a.step_order - b.step_order);
  return (
    steps.find((s) => s.status === "in_progress") ||
    steps.find((s) => ["ready", "pending"].includes(s.status)) ||
    null
  );
};

export default function FlowConsultantsPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canManage = hasCapability(role, CAP.FLOW_COORDINATOR);
  const { data: visits = [], isLoading } = useFlowVisits();
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return visits
      .filter((v) => {
        if (!term) return true;
        return [v.patient_name, v.patient_id, v.token_number, v.assigned_sd_name]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(term));
      })
      .sort(
        (a, b) =>
          Number(!!b.is_vip) - Number(!!a.is_vip) ||
          new Date(a.checkin_time) - new Date(b.checkin_time),
      );
  }, [visits, q]);

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div
          className="flow-header"
          style={{ background: "var(--fskl)", borderColor: "var(--fsk)" }}
        >
          <div>
            <div className="flow-title" style={{ color: "var(--fsk)" }}>
              👨‍⚕️ Consultant Station
            </div>
            <div className="flow-sub">
              {canManage
                ? "Consultant load, hand-overs, and every patient checked in today"
                : "Every patient checked in today and who is seeing them"}
            </div>
          </div>
          <div className="flow-header-right">
            <div className="flow-stat" style={{ padding: "6px 12px", minWidth: 0 }}>
              <div className="flow-stat-val" style={{ fontSize: 20, color: "var(--fsk)" }}>
                {visits.length}
              </div>
              <div className="flow-stat-lbl">Checked in today</div>
            </div>
          </div>
        </div>

        <StationSwitcher />

        {canManage && (
          <div className="flow-card" style={{ marginBottom: 12 }}>
            <div className="flow-sec-title">Consultants — load &amp; hand-over</div>
            <ConsultantLoadBoard visits={visits} />
          </div>
        )}

        <div className="q-sec">
          <div className="q-sec-head">
            <span className="flow-sec-title" style={{ margin: 0 }}>
              All patients today
              <span className="q-count">{rows.length}</span>
            </span>
            <div className="q-search">
              <span aria-hidden="true">🔎</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search patient, file no, token or consultant…"
                aria-label="Search today's patients"
              />
              {q && (
                <button className="q-search-x" title="Clear search" onClick={() => setQ("")}>
                  ✕
                </button>
              )}
            </div>
          </div>

          {isLoading ? (
            <div className="flow-card flow-empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="flow-card flow-empty">No patient matches this view.</div>
          ) : (
            rows.map((v) => {
              const c = consultState(v);
              const s = visitState(v);
              const step = currentStepOf(v);
              const waited = waitedMin(v.checkin_time);
              const live = ["waiting", "paused", "in_progress"].includes(v.status);
              return (
                <div key={v.id} className={`qrow${live ? "" : " qrow--muted"}`}>
                  <span className="qrow-tok">{v.token_number || "—"}</span>
                  <div className="qrow-main">
                    <div className="qrow-name">
                      {v.patient_name}
                      {v.is_vip && <span title="VIP">⭐</span>}
                    </div>
                    <div className="qrow-meta">
                      {v.patient_id}
                      {v.patient_age_sex ? ` · ${v.patient_age_sex}` : ""} · in since{" "}
                      {fmtTime(v.checkin_time)}
                    </div>
                    <div className="qrow-chips">
                      <span className={`flow-badge ${c.cls}`}>{c.label}</span>
                      {!v.assigned_sd_name && (
                        <span className="flow-badge fb-red">no consultant</span>
                      )}
                      <span className={`flow-badge ${s.cls}`}>{s.label}</span>
                      {step && <span className="flow-badge fb-ink">at {step.step_name}</span>}
                      {live && (
                        <span
                          className={`flow-badge ${waited > 45 ? "fb-red" : waited > 25 ? "fb-amb" : "fb-ink"}`}
                        >
                          {waited}m in hospital
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="qrow-actions">
                    <span
                      className={`flow-badge ${v.assigned_sd_name ? "fb-ink" : "fb-red"}`}
                      title="Assigned consultant"
                    >
                      {v.assigned_sd_name || "no consultant"}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
