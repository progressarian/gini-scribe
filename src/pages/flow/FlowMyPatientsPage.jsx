import { useState } from "react";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import usePatientStore from "../../stores/patientStore";
import { toast } from "../../stores/uiStore";
import {
  useFlowMyPatients,
  useFlowAcceptOffer,
  useFlowDeclineOffer,
} from "../../queries/hooks/useFlow";
import StationSwitcher from "../../components/flow/StationSwitcher";
import "../../styles/flow.css";

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const waitedMin = (t) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));

const currentStepOf = (v) => {
  const steps = (v.steps || []).slice().sort((a, b) => a.step_order - b.step_order);
  return (
    steps.find((s) => s.status === "in_progress") ||
    steps.find((s) => ["ready", "pending"].includes(s.status)) ||
    null
  );
};

function PatientRow({ visit, children }) {
  const step = currentStepOf(visit);
  const waited = waitedMin(visit.checkin_time);
  const urgency = visit._timing?.urgency;
  return (
    <div
      className={`qrow${urgency === "breach" ? " qrow--breach" : urgency === "atrisk" ? " qrow--atrisk" : ""}`}
    >
      <span className="qrow-tok">{visit.token_number || "—"}</span>
      <div className="qrow-main">
        <div className="qrow-name">
          {visit.patient_name}
          {visit.is_vip && <span title="VIP">⭐</span>}
        </div>
        <div className="qrow-meta">
          {visit.patient_id}
          {visit.patient_age_sex ? ` · ${visit.patient_age_sex}` : ""} · in since{" "}
          {fmtTime(visit.checkin_time)}
        </div>
        <div className="qrow-chips">
          <span
            className={`flow-badge ${waited > 45 ? "fb-red" : waited > 25 ? "fb-amb" : "fb-ink"}`}
          >
            waiting {waited}m
          </span>
          <span className="flow-badge fb-ink">{step ? step.step_name : "journey not started"}</span>
          {visit.assigned_sd_name && (
            <span className="flow-badge fb-ink">SD {visit.assigned_sd_name}</span>
          )}
        </div>
      </div>
      <div className="qrow-actions">{children}</div>
    </div>
  );
}

export default function FlowMyPatientsPage() {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.currentDoctor);
  const loadPatientDB = usePatientStore((s) => s.loadPatientDB);
  const { data, isLoading } = useFlowMyPatients();
  const accept = useFlowAcceptOffer();
  const decline = useFlowDeclineOffer();
  const [busyId, setBusyId] = useState(null);

  const mine = data?.mine || [];
  const offers = data?.offers || [];

  // Same shape the Home appointment list hands in — the chart pages fetch the
  // rest from dbPatientId.
  const openPatient = async (visit) => {
    if (!visit.patient_db_id) {
      toast("This visit has no linked patient record", "warn");
      return;
    }
    const [age, sexInitial] = [
      (visit.patient_age_sex || "").replace(/\D/g, ""),
      (visit.patient_age_sex || "").slice(-1).toUpperCase(),
    ];
    await loadPatientDB({
      id: visit.patient_db_id,
      name: visit.patient_name,
      file_no: visit.patient_id,
      phone: visit.patient_phone,
      age: age || "",
      sex: sexInitial === "F" ? "Female" : sexInitial === "M" ? "Male" : "",
    });
    navigate("/consultant");
  };

  const onAccept = async (visit) => {
    setBusyId(visit.id);
    try {
      const res = await accept.mutateAsync(visit.id);
      toast(
        res?.no_appointment
          ? `${visit.patient_name} accepted — walk-in, so they stay off the appointment list`
          : `${visit.patient_name} is now your patient`,
        "success",
      );
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  };

  const onDecline = async (visit) => {
    setBusyId(visit.id);
    try {
      await decline.mutateAsync({ visitId: visit.id, reason: "" });
      toast(`${visit.patient_name} declined — sent back to reception`, "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div
          className="flow-header"
          style={{ background: "var(--fskl)", borderColor: "var(--fsk)" }}
        >
          <div>
            <div className="flow-title" style={{ color: "var(--fsk)" }}>
              🩺 My patients today
            </div>
            <div className="flow-sub">
              {me?.short_name || me?.name || "You"} · patients assigned to you, longest wait first
            </div>
          </div>
          <div className="flow-header-right">
            <div className="flow-stat" style={{ padding: "6px 12px", minWidth: 0 }}>
              <div className="flow-stat-val" style={{ fontSize: 20, color: "var(--fsk)" }}>
                {mine.length}
              </div>
              <div className="flow-stat-lbl">My queue</div>
            </div>
            <div
              className="flow-stat"
              style={{ padding: "6px 12px", minWidth: 0, borderColor: "var(--fam)" }}
            >
              <div className="flow-stat-val" style={{ fontSize: 20, color: "var(--fam)" }}>
                {offers.length}
              </div>
              <div className="flow-stat-lbl">Offered to you</div>
            </div>
          </div>
        </div>

        <StationSwitcher />

        {isLoading ? (
          <div className="flow-card flow-empty">Loading…</div>
        ) : (
          <>
            <div className="q-sec">
              <div className="q-sec-head">
                <span className="flow-sec-title" style={{ margin: 0 }}>
                  Offered to you
                  <span className="q-count">{offers.length}</span>
                </span>
              </div>
              {offers.length === 0 ? (
                <div className="flow-card flow-empty">No hand-overs waiting on you right now.</div>
              ) : (
                offers.map((v) => (
                  <PatientRow key={v.id} visit={v}>
                    <button
                      className="flow-btn flow-btn-grn"
                      disabled={busyId === v.id}
                      title={`Take over from ${v.offer?.from_name || "their consultant"}`}
                      onClick={() => onAccept(v)}
                    >
                      ✓ Accept
                    </button>
                    <button
                      className="flow-btn flow-btn-ghost"
                      disabled={busyId === v.id}
                      onClick={() => onDecline(v)}
                    >
                      ✕ Decline
                    </button>
                  </PatientRow>
                ))
              )}
            </div>

            <div className="q-sec">
              <div className="q-sec-head">
                <span className="flow-sec-title" style={{ margin: 0 }}>
                  My queue
                  <span className="q-count">{mine.length}</span>
                </span>
              </div>
              {mine.length === 0 ? (
                <div className="flow-card flow-empty">
                  No patients assigned to you in the building right now.
                </div>
              ) : (
                mine.map((v) => (
                  <PatientRow key={v.id} visit={v}>
                    <button className="flow-btn flow-btn-primary" onClick={() => openPatient(v)}>
                      Open chart →
                    </button>
                  </PatientRow>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
