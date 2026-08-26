import { useEffect, useMemo, useState } from "react";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";
import { useFlowOfferVisit, useFlowDeclineOffer } from "../../queries/hooks/useFlow";

const OFFER_STALE_MIN = 5;
const UNASSIGNED = "__unassigned";
const LIVE = ["waiting", "paused", "in_progress"];
const waitedMin = (t) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
const offerAgeMin = (o) => (o?.at ? waitedMin(o.at) : null);

const currentStepOf = (v) => {
  const steps = (v.steps || []).slice().sort((a, b) => a.step_order - b.step_order);
  return (
    steps.find((s) => s.status === "in_progress") ||
    steps.find((s) => ["ready", "pending"].includes(s.status)) ||
    null
  );
};
// A live offer sits on the SD step. Expired ones are ignored, matching the API.
const offerOf = (v) => {
  const sd = (v.steps || []).find((s) => s.assigned_role === "sd");
  const o = sd?.data?.offer;
  if (!o?.at) return null;
  return offerAgeMin(o) > OFFER_STALE_MIN ? null : o;
};
const sdStartedFor = (v) =>
  (v.steps || []).some((s) => s.assigned_role === "sd" && s.status === "in_progress");

// Admin view of who is carrying what, and the hand-over action. Sits under the
// doctor-load bars on the Flow Floor because that is where the pile-up shows.
export default function ConsultantLoadBoard({ visits }) {
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const fetchDoctorsList = useAuthStore((s) => s.fetchDoctorsList);
  const offer = useFlowOfferVisit();
  const withdraw = useFlowDeclineOffer();
  const [openDoctor, setOpenDoctor] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (!doctorsList?.length) fetchDoctorsList();
  }, [doctorsList, fetchDoctorsList]);

  // Consultants only — an MO is never an SD, and "Admin" should not be one.
  const consultants = useMemo(
    () => (doctorsList || []).filter((d) => (d.role || "").toLowerCase() === "consultant"),
    [doctorsList],
  );

  // Load per consultant, from the live floor rather than the roster, so a
  // doctor with nobody today still shows as free to receive.
  const load = useMemo(() => {
    const m = new Map();
    for (const d of consultants) m.set(String(d.id), { doctor: d, patients: [] });
    // Everyone still in the building, not just those mid-consultation — a
    // patient whose timer has not started is exactly who you might hand over.
    for (const v of visits.filter((v) => LIVE.includes(v.status))) {
      // Nobody assigned: their own bucket, so they can never be invisible here.
      const key = v.assigned_sd_name ? String(v.assigned_sd ?? v.assigned_sd_name) : UNASSIGNED;
      if (!m.has(key)) {
        m.set(key, {
          doctor:
            key === UNASSIGNED
              ? { id: UNASSIGNED, name: "No consultant" }
              : { id: v.assigned_sd, name: v.assigned_sd_name },
          patients: [],
        });
      }
      m.get(key).patients.push(v);
    }
    return [...m.values()]
      .map((e) => ({
        ...e,
        patients: e.patients.sort(
          (a, b) =>
            Number(!!b.is_vip) - Number(!!a.is_vip) ||
            new Date(a.checkin_time) - new Date(b.checkin_time),
        ),
      }))
      .sort(
        (a, b) =>
          // Unassigned first: nobody is coming for them.
          Number(b.doctor.id === UNASSIGNED) - Number(a.doctor.id === UNASSIGNED) ||
          b.patients.length - a.patients.length ||
          a.doctor.name.localeCompare(b.doctor.name),
      );
  }, [consultants, visits]);

  // Consultants with nobody get one summary line instead of a row each — with
  // 40 on the roster, a row each buries the one person who is overloaded.
  const busy = load.filter((l) => l.patients.length > 0);
  const free = load.filter((l) => l.patients.length === 0);

  const maxLoad = Math.max(1, ...load.map((l) => l.patients.length));
  const [showFree, setShowFree] = useState(false);

  const sendOffer = async (visit, toDoctor) => {
    setBusyId(visit.id);
    try {
      await offer.mutateAsync({
        visitId: visit.id,
        to_doctor_id: toDoctor.id,
        to_doctor_name: toDoctor.name,
        reason: "Consultant overloaded",
      });
      toast(
        `${visit.patient_name} offered to ${toDoctor.name} — awaiting their acceptance`,
        "success",
      );
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  };

  const withdrawOffer = async (visit) => {
    setBusyId(visit.id);
    try {
      await withdraw.mutateAsync({ visitId: visit.id, reason: "Withdrawn by admin" });
      toast(`Offer for ${visit.patient_name} withdrawn`, "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  };

  if (!busy.length && !free.length)
    return <div className="flow-muted">No consultants on today's flow yet.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="flow-muted">
        Click a consultant to see their patients. Offer one to a freer colleague — the patient moves
        only once that colleague accepts, and an unanswered offer lapses after {OFFER_STALE_MIN}{" "}
        min.
      </div>
      {busy.map(({ doctor, patients }) => {
        const open = openDoctor === String(doctor.id);
        const n = patients.length;
        const pending = patients.filter((v) => offerOf(v)).length;
        return (
          <div key={doctor.id} className="clb-card">
            <button
              className="clb-head"
              aria-expanded={open}
              onClick={() => setOpenDoctor(open ? null : String(doctor.id))}
            >
              <span className="clb-caret">{open ? "▾" : "▸"}</span>
              <span className="clb-name">
                {doctor.name}
                {doctor.specialty ? <em className="clb-spec"> · {doctor.specialty}</em> : null}
              </span>
              <span className="clb-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${(n / maxLoad) * 100}%`,
                    background: n === 0 ? "var(--fgn)" : n >= maxLoad ? "var(--fre)" : "var(--fam)",
                  }}
                />
              </span>
              <span
                className={`flow-badge ${n === 0 ? "fb-grn" : n >= maxLoad ? "fb-red" : "fb-amb"}`}
              >
                {n === 0 ? "free" : `${n} patient${n > 1 ? "s" : ""}`}
              </span>
              {pending > 0 && <span className="flow-badge fb-blu">{pending} offered</span>}
            </button>

            {open && (
              <div className="clb-body">
                {n === 0 ? (
                  <div className="flow-muted">
                    Nobody with them — a good target for a hand-over.
                  </div>
                ) : (
                  patients.map((v) => {
                    const o = offerOf(v);
                    const step = currentStepOf(v);
                    const started = sdStartedFor(v);
                    const waited = waitedMin(v.checkin_time);
                    return (
                      <div key={v.id} className="clb-row">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="qrow-name">
                            {v.token_number ? `#${v.token_number} · ` : ""}
                            {v.patient_name}
                            {v.is_vip && <span title="VIP">⭐</span>}
                          </div>
                          <div className="qrow-meta">
                            {v.patient_id}
                            {v.patient_age_sex ? ` · ${v.patient_age_sex}` : ""}
                          </div>
                          <div className="qrow-chips">
                            <span
                              className={`flow-badge ${waited > 45 ? "fb-red" : waited > 25 ? "fb-amb" : "fb-ink"}`}
                            >
                              waiting {waited}m
                            </span>
                            <span className="flow-badge fb-ink">
                              {step ? step.step_name : "journey not started"}
                            </span>
                            {o && (
                              <span className="flow-badge fb-blu">
                                offered to {o.to_name} · {offerAgeMin(o)}m ago
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="qrow-actions">
                          {o ? (
                            <button
                              className="flow-btn flow-btn-ghost"
                              disabled={busyId === v.id}
                              title="Withdraw this offer"
                              onClick={() => withdrawOffer(v)}
                            >
                              ✕ Withdraw
                            </button>
                          ) : started ? (
                            <span className="flow-muted">consultation started</span>
                          ) : (
                            <select
                              className="jb-addsel"
                              value=""
                              disabled={busyId === v.id}
                              onChange={(e) => {
                                const d = consultants.find((c) => String(c.id) === e.target.value);
                                if (d) sendOffer(v, d);
                                e.target.value = "";
                              }}
                            >
                              <option value="">→ Offer to…</option>
                              {load
                                .filter((l) => String(l.doctor.id) !== String(doctor.id))
                                .filter((l) =>
                                  consultants.some((c) => String(c.id) === String(l.doctor.id)),
                                )
                                // Freest first — the whole point is finding
                                // someone with capacity.
                                .sort((a, b) => a.patients.length - b.patients.length)
                                .map((l) => (
                                  <option key={l.doctor.id} value={l.doctor.id}>
                                    {l.doctor.name} · {l.patients.length}
                                    {l.doctor.specialty ? ` · ${l.doctor.specialty}` : ""}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}

      {free.length > 0 && (
        <div className="clb-card">
          <button
            className="clb-head"
            aria-expanded={showFree}
            onClick={() => setShowFree((v) => !v)}
          >
            <span className="clb-caret">{showFree ? "▾" : "▸"}</span>
            <span className="clb-name">
              {free.length} consultant{free.length > 1 ? "s" : ""} free
            </span>
            <span className="clb-bar" aria-hidden="true">
              <span style={{ width: "0%", background: "var(--fgn)" }} />
            </span>
            <span className="flow-badge fb-grn">nobody with them</span>
          </button>
          {showFree && (
            <div className="clb-body">
              <div className="flow-muted">
                All available to receive a hand-over — they are listed in every “Offer to…” picker.
              </div>
              <ul className="clb-free-grid">
                {free.map((l) => (
                  <li key={l.doctor.id} className="clb-free-item">
                    <span className="clb-free-name">{l.doctor.name}</span>
                    {l.doctor.specialty && (
                      <span className="clb-free-spec">{l.doctor.specialty}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
