import { useEffect, useRef, useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import { useOverLimitConfirm } from "../booking/OverLimitDialog";
import { PATIENT_TYPE_LABELS } from "../../../shared/slotCapacity";

export async function enrichAffected(affected, doctorId, doctor) {
  return Promise.all(
    affected.map(async (a) => {
      let suggested = [];
      if (!a.in_progress) {
        try {
          const { data } = await api.get(
            `/api/availability/doctors-for-slot?date=${a.appointment_date?.slice(0, 10)}&slot=${encodeURIComponent(
              a.time_slot,
            )}&exclude=${doctorId}&appointment=${a.appointment_id}${doctor?.specialty ? `&specialty=${encodeURIComponent(doctor.specialty)}` : ""}`,
          );
          suggested = data || [];
        } catch {
          suggested = [];
        }
      }
      return { ...a, suggested_doctors: suggested };
    }),
  );
}

export default function ReassignModal({
  affected,
  doctor,
  unavailability_id,
  trigger,
  saved = "The time off is already saved",
  onClose,
  onDone,
}) {
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(affected);

  const [confirmClose, setConfirmClose] = useState(false);
  const dialogRef = useRef(null);
  const overLimit = useOverLimitConfirm();

  const movable = rows.filter((r) => !r.in_progress);
  const pickable = movable.filter((r) => r.suggested_doctors?.length);
  const stranded = movable.length - pickable.length;
  const allPicked = pickable.length > 0 && pickable.every((r) => picks[r.appointment_id]);
  const unmoved = movable.filter((r) => !picks[r.appointment_id]).length;
  const requestClose = () => (unmoved ? setConfirmClose(true) : onClose());

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || busy || overLimit.open) return;
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const autofill = () => {
    const next = {};
    for (const r of movable) {
      const top = r.suggested_doctors?.find((d) => !d.over_limit);
      if (top)
        next[r.appointment_id] = { to_doctor_id: top.doctor_id, to_doctor_name: top.doctor_name };
    }
    setPicks(next);
  };

  const apply = async () => {
    const moves = Object.entries(picks).map(([appointment_id, v]) => ({
      appointment_id: Number(appointment_id),
      to_doctor_id: v.to_doctor_id,
      to_doctor_name: v.to_doctor_name,
      over_limit_reason: v.over_limit_reason,
    }));
    if (!moves.length) return toast("Pick at least one doctor", "warn");
    setBusy(true);
    try {
      const { data } = await api.post("/api/appointments/reassign", {
        trigger,
        unavailability_id,
        reason: `${doctor?.name} ${trigger}`,
        moves,
      });
      if (data.failed?.length) {
        const failedIds = new Set(data.failed.map((f) => f.appointment_id));
        setRows((rs) =>
          rs.filter((r) => failedIds.has(r.appointment_id) || !r.suggested_doctors?.length),
        );
        setPicks({});
        toast(
          `${data.moved.length} moved, ${data.failed.length} failed (slot full?). Retry those.`,
          "warn",
        );
      } else if (stranded > 0) {
        toast(
          `${moves.length} moved. ${stranded} patient(s) had no free doctor and are still booked with ${doctor?.name} — move them from Appointments.`,
          "warn",
        );
        onDone();
      } else {
        onDone();
      }
    } catch (e) {
      toast(e.response?.data?.error || "Reassign failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="docmgmt-modal-bg">
        <div
          className="docmgmt-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="docmgmt-reassign-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <h2 id="docmgmt-reassign-title">Reassign patients — {doctor?.name} unavailable</h2>
          <p className="docmgmt-hint">
            {movable.length} patient(s) need a new doctor. In-progress visits are locked.
          </p>
          <table className="docmgmt-list">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Date</th>
                <th>Slot</th>
                <th>Reassign to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.appointment_id} className={r.in_progress ? "locked" : ""}>
                  <td>
                    {r.patient_name}
                    {r.file_no ? <small> ({r.file_no})</small> : null}
                  </td>
                  <td>{r.appointment_date?.slice(0, 10)}</td>
                  <td>{r.time_slot}</td>
                  <td>
                    {r.in_progress ? (
                      <em>🔒 in progress</em>
                    ) : r.suggested_doctors?.length ? (
                      <select
                        value={picks[r.appointment_id]?.to_doctor_id || ""}
                        onChange={async (e) => {
                          const id = Number(e.target.value);
                          const d = r.suggested_doctors.find((x) => x.doctor_id === id);
                          const ok = await overLimit.confirm(
                            d && { slot_label: r.time_slot, over_limit: d.over_limit },
                            { doctorName: d?.doctor_name, patientName: r.patient_name },
                          );
                          if (!ok) return;
                          setPicks((p) => ({
                            ...p,
                            [r.appointment_id]: d
                              ? {
                                  to_doctor_id: d.doctor_id,
                                  to_doctor_name: d.doctor_name,
                                  over_limit_reason: ok.reason || null,
                                }
                              : undefined,
                          }));
                        }}
                      >
                        <option value="">— choose —</option>
                        {r.suggested_doctors.map((d) => (
                          <option key={d.doctor_id} value={d.doctor_id}>
                            {d.doctor_name}
                            {d.free_capacity != null ? ` (${d.free_capacity} free)` : ""}
                            {d.same_specialty ? " ⭐" : ""}
                            {d.over_limit
                              ? ` — full for ${PATIENT_TYPE_LABELS[d.over_limit.patient_type].toLowerCase()} patients (${d.over_limit.count}/${d.over_limit.limit})`
                              : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <em className="docmgmt-nofree">⚠ no doctor free this slot</em>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {confirmClose ? (
            <div className="docmgmt-modal-actions" role="alert">
              <p className="docmgmt-warnline">
                {unmoved} patient(s) will stay booked with {doctor?.name} while they are
                unavailable.
                {saved} — move them later from Appointments.
              </p>
              <div className="spacer" />
              <button type="button" onClick={() => setConfirmClose(false)}>
                Back to reassigning
              </button>
              <button type="button" className="docmgmt-danger" onClick={onClose}>
                Close without moving
              </button>
            </div>
          ) : (
            <div className="docmgmt-modal-actions">
              <button type="button" onClick={autofill} disabled={!pickable.length}>
                Auto-fill suggestions
              </button>
              <div className="spacer" />
              <button type="button" onClick={requestClose}>
                Close
              </button>
              <button
                type="button"
                className="docmgmt-primary"
                disabled={busy || !allPicked}
                onClick={apply}
              >
                {busy ? "Reassigning…" : stranded ? `Reassign ${pickable.length}` : "Reassign all"}
              </button>
            </div>
          )}
          {stranded > 0 && !confirmClose && (
            <p className="docmgmt-warnline">
              {stranded} patient(s) have no doctor free in their slot and will stay booked with{" "}
              {doctor?.name}. Move them from Appointments after this.
            </p>
          )}
          {!allPicked && pickable.length > 0 && !confirmClose && (
            <p className="docmgmt-warnline">
              Pick a doctor for every patient who has one free before you can finish.
            </p>
          )}
        </div>
      </div>
      {overLimit.dialog}
    </>
  );
}
