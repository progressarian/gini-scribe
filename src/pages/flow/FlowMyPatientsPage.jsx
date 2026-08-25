import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import usePatientStore from "../../stores/patientStore";
import { toast } from "../../stores/uiStore";
import {
  useFlowMyPatients,
  useFlowVisits,
  useFlowAcceptOffer,
  useFlowDeclineOffer,
} from "../../queries/hooks/useFlow";
import StationSwitcher from "../../components/flow/StationSwitcher";
import LabPanel from "../../components/flow/LabPanel";
import {
  CAPABILITIES as CAP,
  hasCapability,
  hasOwnConsultQueue,
} from "../../../shared/permissions";
import "../../styles/flow.css";

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const waitedMin = (t) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
const LIVE = ["waiting", "paused", "in_progress"];

// Whether the consultation itself is done, independent of the visit still being
// open for billing or pharmacy.
const consultState = (v) => {
  const sd = (v.steps || []).find((s) => s.assigned_role === "sd");
  if (!sd) return null;
  if (sd.status === "completed") return { label: "consultation done", cls: "fb-grn" };
  if (sd.status === "skipped") return { label: "consultation skipped", cls: "fb-ink" };
  if (sd.status === "in_progress") return { label: "with consultant now", cls: "fb-blu" };
  return { label: "waiting for consultation", cls: "fb-amb" };
};

// One chip for where the patient is. Position, lock and consultation status all
// describe the same fact when the running step IS the consultation — three
// chips saying "SD Consultation" read as three simultaneous places.
// Lab work still outstanding — the reason a gated consultation has not opened.
const labPending = (v) =>
  (v.steps || []).find((s) => s.is_background && !["completed", "skipped"].includes(s.status)) ||
  null;

const positionOf = (v, myRole) => {
  const steps = (v.steps || []).slice().sort((a, b) => a.step_order - b.step_order);
  const running = steps.find((s) => s.status === "in_progress");
  const next = steps.find((s) => ["ready", "pending"].includes(s.status));
  const where = running || next;
  if (!where) return null;
  // The lock means "another doctor has them", not merely "not with you yet".
  // Every patient sits at Vitals or Lab before reaching their consultant, so
  // flagging those would put a padlock on almost every row and mean nothing.
  const mineNow =
    (myRole === "chief" && where.assigned_role === "chief") ||
    (myRole === "sd" && where.assigned_role === "sd");
  const locked = !!running && !mineNow && ["sd", "chief"].includes(where.assigned_role);
  return {
    label: locked
      ? `🔒 at ${where.step_name} now`
      : running
        ? `at ${where.step_name} now`
        : `next: ${where.step_name}`,
    cls: locked ? "fb-amb" : running ? "fb-blu" : "fb-ink",
    // The consultation chip is redundant while they are actually in it.
    hidesConsultState: ["sd", "chief"].includes(where.assigned_role),
  };
};

function PatientRow({ visit, muted, children }) {
  const waited = waitedMin(visit.checkin_time);
  const urgency = visit._timing?.urgency;
  const pos = positionOf(visit, visit.my_role);
  const c = pos?.hidesConsultState ? null : consultState(visit);
  const live = LIVE.includes(visit.status);
  const lab = labPending(visit);
  return (
    <div
      className={`qrow${muted ? " qrow--muted" : urgency === "breach" ? " qrow--breach" : urgency === "atrisk" ? " qrow--atrisk" : ""}`}
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
          {visit.my_role === "chief" && (
            <span className="flow-badge fb-lv" title="You are the Chief on this visit">
              as Chief
            </span>
          )}
          {c && <span className={`flow-badge ${c.cls}`}>{c.label}</span>}
          {pos && <span className={`flow-badge ${pos.cls}`}>{pos.label}</span>}
          <LabPanel lab={visit.lab} compact />
          {lab && (
            <span className="flow-badge fb-amb" title="Consultation opens once results are in">
              🔒 reports pending
            </span>
          )}
          {live && (
            <span
              className={`flow-badge ${waited > 45 ? "fb-red" : waited > 25 ? "fb-amb" : "fb-ink"}`}
            >
              {waited}m in hospital
            </span>
          )}
        </div>
      </div>
      {children ? <div className="qrow-actions">{children}</div> : null}
    </div>
  );
}

export default function FlowMyPatientsPage() {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.currentDoctor);
  const role = me?.role;
  const loadPatientDB = usePatientStore((s) => s.loadPatientDB);
  const { data, isLoading } = useFlowMyPatients();
  const { data: allVisits = [] } = useFlowVisits();
  const accept = useFlowAcceptOffer();
  const decline = useFlowDeclineOffer();
  const [busyId, setBusyId] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleGroup = (name) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const mine = data?.mine || [];
  const offers = data?.offers || [];

  // Everyone else's patients — the floor-wide view, minus anyone already on my
  // side of the screen so a patient never appears in both columns.
  const others = useMemo(() => {
    // Only my own SD patients leave the floor list. One I merely cover as Chief
    // is still their SD's patient — hiding them understated that SD's load,
    // which is the one thing this column exists to show.
    const skip = new Set([...mine.filter((v) => v.my_role === "sd"), ...offers].map((v) => v.id));
    const term = q.trim().toLowerCase();
    return allVisits
      .filter((v) => !skip.has(v.id))
      .filter((v) =>
        !term
          ? true
          : [v.patient_name, v.patient_id, v.token_number, v.assigned_sd_name]
              .filter(Boolean)
              .some((f) => String(f).toLowerCase().includes(term)),
      )
      .sort(
        (a, b) =>
          Number(LIVE.includes(b.status)) - Number(LIVE.includes(a.status)) ||
          Number(!!b.is_vip) - Number(!!a.is_vip) ||
          new Date(a.checkin_time) - new Date(b.checkin_time),
      );
  }, [allVisits, mine, offers, q]);

  // Grouped by consultant, busiest first — the point of this column is seeing
  // who is carrying what, which a flat list buries.
  const groups = useMemo(() => {
    const m = new Map();
    for (const v of others) {
      const key = v.assigned_sd_name || "No consultant";
      if (!m.has(key)) m.set(key, { name: key, patients: [], live: 0 });
      const g = m.get(key);
      g.patients.push(v);
      if (LIVE.includes(v.status)) g.live++;
    }
    return [...m.values()].sort(
      (a, b) =>
        b.live - a.live || b.patients.length - a.patients.length || a.name.localeCompare(b.name),
    );
  }, [others]);

  // loadPatientDB fetches the full record itself; it only reports a failed fetch
  // when handed a toast, so pass one — otherwise a broken load lands the doctor
  // on a half-populated chart with no warning.
  const openPatient = async (visit) => {
    if (!visit.patient_db_id) {
      toast("This visit has no linked patient record", "warn");
      return;
    }
    const age = (visit.patient_age_sex || "").replace(/\D/g, "");
    const sexInitial = (visit.patient_age_sex || "").slice(-1).toUpperCase();
    setOpeningId(visit.id);
    try {
      await loadPatientDB(
        {
          id: visit.patient_db_id,
          name: visit.patient_name,
          file_no: visit.patient_id,
          phone: visit.patient_phone,
          age: age || "",
          sex: sexInitial === "F" ? "Female" : sexInitial === "M" ? "Male" : "",
        },
        undefined,
        toast,
      );
      navigate("/consultant");
    } catch (e) {
      toast(e?.message || `Could not open ${visit.patient_name}'s chart`, "error");
    } finally {
      setOpeningId(null);
    }
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

  // This is a personal consultation queue. Admin holds ALL, so the route
  // capability alone lets them in — but they do not consult, and their list is
  // only ever the 73 visits mis-assigned to an Admin account. Send them to the
  // floor-wide view, which is the equivalent screen for their job.
  if (!hasOwnConsultQueue(role)) {
    return (
      <Navigate
        to={hasCapability(role, CAP.FLOW_CONSULTANTS) ? "/flow/consultants" : "/"}
        replace
      />
    );
  }

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
              {me?.short_name || me?.name || "You"} · your queue on the left, the rest of the floor
              on the right
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

        <div className="mp-split">
          <section>
            {offers.length > 0 && (
              <div className="q-sec" style={{ marginTop: 0 }}>
                <div className="q-sec-head">
                  <span className="flow-sec-title" style={{ margin: 0 }}>
                    Offered to you
                    <span className="q-count">{offers.length}</span>
                  </span>
                </div>
                {offers.map((v) => (
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
                ))}
              </div>
            )}

            <div className="q-sec" style={{ marginTop: offers.length ? undefined : 0 }}>
              <div className="q-sec-head">
                <span className="flow-sec-title" style={{ margin: 0 }}>
                  My queue
                  <span className="q-count">{mine.length}</span>
                </span>
              </div>
              {isLoading ? (
                <div className="flow-card flow-empty">Loading…</div>
              ) : mine.length === 0 ? (
                <div className="flow-card flow-empty">
                  No patients assigned to you in the building right now.
                </div>
              ) : (
                mine.map((v) => (
                  <PatientRow key={v.id} visit={v}>
                    <button
                      className="flow-btn flow-btn-primary"
                      disabled={openingId === v.id}
                      onClick={() => openPatient(v)}
                    >
                      {openingId === v.id ? "Opening…" : "Open chart →"}
                    </button>
                  </PatientRow>
                ))
              )}
            </div>
          </section>

          <section>
            <div className="q-sec" style={{ marginTop: 0 }}>
              <div className="q-sec-head">
                <span className="flow-sec-title" style={{ margin: 0 }}>
                  Other consultants&rsquo; patients
                  <span className="q-count">{others.length}</span>
                </span>
                <div className="q-search">
                  <span aria-hidden="true">🔎</span>
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search patient, file no or consultant…"
                    aria-label="Search the rest of the floor"
                  />
                  {q && (
                    <button className="q-search-x" title="Clear search" onClick={() => setQ("")}>
                      ✕
                    </button>
                  )}
                </div>
              </div>
              {others.length === 0 ? (
                <div className="flow-card flow-empty">Nobody else is checked in today.</div>
              ) : (
                groups.map((g) => {
                  // A search should reveal what it matched, not hide it behind
                  // a collapsed header the user has to hunt for.
                  const open = !!q.trim() || !collapsed.has(g.name);
                  return (
                    <div key={g.name} className="mp-group">
                      <button
                        className="mp-group-head"
                        aria-expanded={open}
                        onClick={() => toggleGroup(g.name)}
                      >
                        <span className="clb-caret">{open ? "▾" : "▸"}</span>
                        <span className={g.name === "No consultant" ? "f-red" : undefined}>
                          {g.name}
                        </span>
                        <span className="q-count">{g.patients.length}</span>
                      </button>
                      {open &&
                        g.patients.map((v) => (
                          <PatientRow key={v.id} visit={v} muted={!LIVE.includes(v.status)} />
                        ))}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
