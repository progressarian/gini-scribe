import { useEffect, useMemo, useState, useCallback } from "react";
import api from "../services/api";
import useAuthStore from "../stores/authStore";
import { toast } from "../stores/uiStore";
import "./DoctorManagementPage.css";

const todayISO = () => new Date().toISOString().split("T")[0];

export default function DoctorManagementPage() {
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const fetchDoctorsList = useAuthStore((s) => s.fetchDoctorsList);
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const [doctorId, setDoctorId] = useState(null);
  const [slots, setSlots] = useState([]); // slot_catalog
  // Bumped after any mutation so every section re-fetches (one-page layout).
  const [refresh, setRefresh] = useState(0);
  const onChange = () => setRefresh((n) => n + 1);

  // On a hard refresh straight to this route, LoginPage never mounts, so the
  // doctors list may be empty — load it here (same pattern as Find/Dashboard).
  useEffect(() => {
    if (!doctorsList?.length) fetchDoctorsList();
  }, [doctorsList?.length, fetchDoctorsList]);

  useEffect(() => {
    api
      .get("/api/slot-catalog")
      .then((r) => setSlots(r.data || []))
      .catch(() => setSlots([]));
  }, []);

  // Default to the logged-in user's own profile, so it opens pre-filled.
  useEffect(() => {
    if (doctorId) return;
    if (currentDoctor?.id) setDoctorId(currentDoctor.id);
    else if (doctorsList?.length) setDoctorId(doctorsList[0].id);
  }, [currentDoctor, doctorsList, doctorId]);

  const doctor = useMemo(
    () => doctorsList?.find((d) => d.id === doctorId) || null,
    [doctorsList, doctorId],
  );

  return (
    <div className="docmgmt">
      <div className="docmgmt-head">
        <h1>Doctor Management</h1>
        <label className="docmgmt-docpick">
          Doctor:
          <select value={doctorId || ""} onChange={(e) => setDoctorId(Number(e.target.value))}>
            {(doctorsList || []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.specialty ? ` — ${d.specialty}` : ""}
                {d.is_chief ? " · Chief" : ""}
              </option>
            ))}
          </select>
        </label>
        {doctor && (
          <label
            className="docmgmt-docpick"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            title="Mark this doctor as a Chief consultant (used by patient-flow check-in)"
          >
            <input
              type="checkbox"
              checked={!!doctor.is_chief}
              onChange={async (e) => {
                try {
                  await api.patch(`/api/doctors/${doctor.id}`, { is_chief: e.target.checked });
                  await fetchDoctorsList();
                  toast(
                    `${doctor.short_name || doctor.name} ${e.target.checked ? "marked as" : "removed as"} Chief`,
                    "success",
                  );
                } catch (err) {
                  toast(err?.response?.data?.error || "Update failed", "error");
                }
              }}
            />
            Chief consultant
          </label>
        )}
      </div>

      {!doctorId ? (
        <p className="docmgmt-empty">Select a doctor.</p>
      ) : (
        <div className="docmgmt-body">
          <section className="docmgmt-section">
            <h2 className="docmgmt-section-title">🗓️ Working Profile</h2>
            <ProfileTab doctorId={doctorId} doctor={doctor} refresh={refresh} onChange={onChange} />
          </section>
          <section className="docmgmt-section">
            <h2 className="docmgmt-section-title">⏸️ Extra Break</h2>
            <BreakTab doctorId={doctorId} doctor={doctor} refresh={refresh} onChange={onChange} />
          </section>
          <section className="docmgmt-section">
            <h2 className="docmgmt-section-title">🏖️ Time Off — Leave / Holiday / Emergency</h2>
            <TimeOffTab doctorId={doctorId} doctor={doctor} refresh={refresh} onChange={onChange} />
          </section>
          <section className="docmgmt-section">
            <h2 className="docmgmt-section-title">👁️ Day View</h2>
            <DayViewTab doctorId={doctorId} refresh={refresh} />
          </section>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Working Profile ─────────────────────
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (t) => (t ? String(t).slice(0, 5) : ""); // "HH:MM:SS" → "HH:MM"
const toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// Overnight-aware: is time t inside [ws, we] (window wraps midnight if we<=ws)?
const withinWork = (ws, we, t) => {
  const s = toMin(ws),
    e0 = toMin(we),
    x0 = toMin(t);
  if (s == null || e0 == null || x0 == null) return true;
  let e = e0,
    x = x0;
  if (e <= s) e += 1440;
  if (x < s) x += 1440;
  return x >= s && x <= e;
};

function ProfileTab({ doctorId, doctor, refresh, onChange }) {
  const [offDays, setOffDays] = useState([0]);
  const [workStart, setWorkStart] = useState("");
  const [workEnd, setWorkEnd] = useState("");
  const [lunchStart, setLunchStart] = useState("");
  const [lunchEnd, setLunchEnd] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load the doctor's saved profile (or defaults) — prefills the form.
  useEffect(() => {
    setLoading(true);
    api
      .get(`/api/doctors/${doctorId}/profile`)
      .then((r) => {
        const p = r.data || {};
        setOffDays(p.off_weekdays ?? [0]);
        setWorkStart(hhmm(p.work_start));
        setWorkEnd(hhmm(p.work_end));
        setLunchStart(hhmm(p.lunch_start));
        setLunchEnd(hhmm(p.lunch_end));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [doctorId, refresh]);

  const isWorking = (d) => !offDays.includes(d);
  const toggleDay = (d) =>
    setOffDays((o) => (o.includes(d) ? o.filter((x) => x !== d) : [...o, d]));

  const overnight = workStart && workEnd && toMin(workEnd) <= toMin(workStart);

  const save = async () => {
    if ((workStart && !workEnd) || (!workStart && workEnd))
      return toast("Enter both working start and end times", "warn");
    if (workStart && workEnd && workStart === workEnd)
      return toast("Working start and end can't be the same", "warn");
    if ((lunchStart && !lunchEnd) || (!lunchStart && lunchEnd))
      return toast("Enter both lunch start and end times", "warn");
    if (
      workStart &&
      workEnd &&
      lunchStart &&
      lunchEnd &&
      (!withinWork(workStart, workEnd, lunchStart) || !withinWork(workStart, workEnd, lunchEnd))
    )
      return toast("Lunch break must be within working hours", "warn");
    setSaving(true);
    try {
      await api.put(`/api/doctors/${doctorId}/profile`, {
        off_weekdays: offDays,
        work_start: workStart || null,
        work_end: workEnd || null,
        lunch_start: lunchStart || null,
        lunch_end: lunchEnd || null,
      });
      toast("Profile saved", "success");
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || e.response?.data?.details?.[0] || "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="docmgmt-empty">Loading…</p>;

  return (
    <div>
      <p className="docmgmt-hint">
        {doctor?.name} is available by default on working days. Set the days off, the working hours,
        and a recurring lunch break. Leave / holiday / one-off breaks for specific dates are on the
        other tabs.
      </p>

      <h3 className="docmgmt-subhead">Working days</h3>
      <div className="docmgmt-slotmulti">
        {WEEKDAYS.map((label, d) => (
          <label key={d} className={isWorking(d) ? "on" : ""}>
            <input type="checkbox" checked={isWorking(d)} onChange={() => toggleDay(d)} />
            {label}
          </label>
        ))}
      </div>

      <h3 className="docmgmt-subhead">Working hours</h3>
      <div className="docmgmt-form wrap">
        <label>
          From{" "}
          <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} />
        </label>
        <label>
          To <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} />
        </label>
        <span className="docmgmt-hint" style={{ padding: 0 }}>
          {overnight
            ? "Overnight shift — ends next day."
            : "Leave blank = available all day. Overnight (e.g. 17:00–01:00) is supported."}
        </span>
      </div>

      <h3 className="docmgmt-subhead">Lunch break (recurring, every working day)</h3>
      <div className="docmgmt-form wrap">
        <label>
          From{" "}
          <input type="time" value={lunchStart} onChange={(e) => setLunchStart(e.target.value)} />
        </label>
        <label>
          To <input type="time" value={lunchEnd} onChange={(e) => setLunchEnd(e.target.value)} />
        </label>
        <span className="docmgmt-hint" style={{ padding: 0 }}>
          {workStart && workEnd
            ? `Must be within working hours (${workStart}–${workEnd}).`
            : "Optional."}
        </span>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="docmgmt-primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save Profile"}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── Extra Break (single day) ────────────
function BreakTab({ doctorId, doctor, refresh, onChange }) {
  const [list, setList] = useState([]);
  const [date, setDate] = useState(todayISO());
  const [pickedSlots, setPickedSlots] = useState([]);
  const [reason, setReason] = useState("");
  const [reassign, setReassign] = useState(null);
  const [fullDayLeave, setFullDayLeave] = useState(null); // blocks adding a break
  const [daySlots, setDaySlots] = useState([]); // resolved availability for the date

  const load = useCallback(() => {
    api
      .get(`/api/doctors/${doctorId}/unavailability`)
      .then((r) => setList((r.data || []).filter((u) => u.type === "break")))
      .catch(() => setList([]));
  }, [doctorId, refresh]);
  useEffect(load, [load]);

  // Resolve the day: which slots are within working hours and currently open.
  useEffect(() => {
    setPickedSlots([]);
    api
      .get(`/api/doctors/${doctorId}/availability?date=${date}`)
      .then((r) => setDaySlots(r.data?.slots || []))
      .catch(() => setDaySlots([]));
    api
      .get(`/api/doctors/${doctorId}/unavailability?from=${date}&to=${date}`)
      .then((r) =>
        setFullDayLeave(
          (r.data || []).find((u) => u.slot_labels == null && u.type !== "break") || null,
        ),
      )
      .catch(() => setFullDayLeave(null));
  }, [doctorId, date, refresh]);

  // Only offer slots inside working hours that are still open (not lunch/leave).
  const openSlots = daySlots.filter((s) => s.available).map((s) => ({ label: s.slot_label }));
  const dayOff = daySlots.length > 0 && daySlots.every((s) => s.blocked_by === "day_off");

  const add = async () => {
    if (date < todayISO()) return toast("Cannot select a past date", "warn");
    if (fullDayLeave)
      return toast(
        `Doctor has full-day ${fullDayLeave.type} on this date — cannot add a break.`,
        "warn",
      );
    if (!pickedSlots.length) return toast("Pick the slot(s) for the break", "warn");
    try {
      const { data } = await api.post(`/api/doctors/${doctorId}/break`, {
        start_date: date,
        end_date: date,
        slot_labels: pickedSlots,
        reason,
      });
      setReason("");
      setPickedSlots([]);
      onChange?.();
      if (data.requires_reassignment) {
        const enriched = await enrichAffected(data.affected, doctorId, doctor);
        setReassign({ affected: enriched, doctor });
      } else {
        toast("Break added", "success");
      }
    } catch (e) {
      toast(
        e.response?.data?.message ||
          e.response?.data?.error ||
          e.response?.data?.details?.[0] ||
          "Failed",
        "error",
      );
    }
  };
  const cancel = async (u) => {
    await api.patch(`/api/doctors/${doctorId}/unavailability/${u.id}`, { status: "cancelled" });
    onChange?.();
  };

  return (
    <div>
      <p className="docmgmt-hint">
        An <strong>extra</strong> one-off break on a single day (the daily lunch break is set in the
        Profile tab). The chosen slots can't be booked that day and show a “break” label on the Day
        View.
      </p>
      {fullDayLeave && (
        <div className="docmgmt-leavebanner">
          🚫 Doctor has full-day {fullDayLeave.type}
          {fullDayLeave.reason ? ` (${fullDayLeave.reason})` : ""} on this date — a break can't be
          added. They're already off the whole day.
        </div>
      )}
      <div className="docmgmt-form wrap">
        <label>
          Date{" "}
          <input
            type="date"
            min={todayISO()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {!dayOff && !fullDayLeave && openSlots.length > 0 && (
          <SlotMultiSelect slots={openSlots} value={pickedSlots} onChange={setPickedSlots} />
        )}
        <input
          placeholder="Reason (e.g. Meeting)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="docmgmt-primary"
          onClick={add}
          disabled={!!fullDayLeave || dayOff || openSlots.length === 0}
        >
          Add Break
        </button>
      </div>
      {dayOff && (
        <p className="docmgmt-empty">
          Doctor is not working this day (day off) — no slots to break.
        </p>
      )}
      {!dayOff && !fullDayLeave && openSlots.length === 0 && (
        <p className="docmgmt-empty">No open slots on this day to add a break.</p>
      )}

      <table className="docmgmt-list">
        <thead>
          <tr>
            <th>Date</th>
            <th>Slots</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan="4" className="docmgmt-empty">
                No extra breaks added.
              </td>
            </tr>
          )}
          {list.map((u) => (
            <tr key={u.id}>
              <td>{u.start_date?.slice(0, 10)}</td>
              <td>{(u.slot_labels || []).join(", ")}</td>
              <td>{u.reason || "Break"}</td>
              <td>
                <button className="docmgmt-del" onClick={() => cancel(u)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {reassign && (
        <ReassignModal
          {...reassign}
          trigger="break"
          onClose={() => setReassign(null)}
          onDone={() => {
            setReassign(null);
            toast("Reassignment complete", "success");
            onChange?.();
          }}
        />
      )}
    </div>
  );
}

// ───────────────── Time Off (leave / holiday / emergency) ───────
function TimeOffTab({ doctorId, doctor, refresh, onChange }) {
  const [list, setList] = useState([]);
  const [type, setType] = useState("leave");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const [fromNow, setFromNow] = useState(true);
  const [reason, setReason] = useState("");
  const [reassign, setReassign] = useState(null);
  const isEmergency = type === "emergency";

  const load = useCallback(() => {
    api
      .get(`/api/doctors/${doctorId}/unavailability`)
      .then((r) => setList(r.data || []))
      .catch(() => setList([]));
  }, [doctorId, refresh]);
  useEffect(load, [load]);

  const submit = async () => {
    if (start < todayISO()) return toast("Cannot select a past date", "warn");
    if (!end || end < start) return toast("To date must be on or after From", "warn");
    try {
      if (isEmergency) {
        const { data } = await api.post(`/api/doctors/${doctorId}/emergency-leave`, {
          start_date: start,
          end_date: end,
          from_now: fromNow,
          slot_labels: null,
          reason,
        });
        setReason("");
        onChange?.();
        if (data.affected?.length) {
          setReassign({
            affected: data.affected,
            doctor,
            unavailability_id: data.unavailability_id,
            trigger: "emergency_leave",
          });
        } else {
          toast("Emergency leave set — no patients were booked in that window.", "success");
        }
      } else {
        const { data } = await api.post(`/api/doctors/${doctorId}/unavailability`, {
          type,
          start_date: start,
          end_date: end,
          slot_labels: null,
          reason,
        });
        setReason("");
        onChange?.();
        if (data.requires_reassignment) {
          const enriched = await enrichAffected(data.affected, doctorId, doctor);
          setReassign({ affected: enriched, doctor, trigger: "planned_leave" });
        } else {
          toast(`${type === "holiday" ? "Holiday" : "Leave"} added`, "success");
        }
      }
    } catch (e) {
      toast(
        e.response?.data?.message ||
          e.response?.data?.error ||
          e.response?.data?.details?.[0] ||
          "Failed",
        "error",
      );
    }
  };
  const cancel = async (u) => {
    await api.patch(`/api/doctors/${doctorId}/unavailability/${u.id}`, { status: "cancelled" });
    onChange?.();
  };

  return (
    <div>
      <p className="docmgmt-hint">
        Mark the doctor off for a date range. <strong>Leave</strong> / <strong>Holiday</strong> are
        planned; <strong>Emergency</strong> is for right now. If patients are already booked you'll
        be prompted to reassign them.
      </p>
      <div className={`docmgmt-form wrap${isEmergency ? " docmgmt-emergency" : ""}`}>
        <label>
          Type{" "}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="leave">Leave</option>
            <option value="holiday">Holiday</option>
            <option value="emergency">Emergency (now)</option>
          </select>
        </label>
        <label>
          From{" "}
          <input
            type="date"
            min={todayISO()}
            value={start}
            onChange={(e) => {
              const v = e.target.value;
              setStart(v);
              if (end && end < v) setEnd("");
            }}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            min={start || todayISO()}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        {isEmergency && (
          <label className="docmgmt-check">
            <input
              type="checkbox"
              checked={fromNow}
              onChange={(e) => setFromNow(e.target.checked)}
            />
            Only remaining time today
          </label>
        )}
        <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className={isEmergency ? "docmgmt-danger" : "docmgmt-primary"} onClick={submit}>
          {isEmergency ? "Mark Emergency" : type === "holiday" ? "Add Holiday" : "Add Leave"}
        </button>
      </div>

      <table className="docmgmt-list">
        <thead>
          <tr>
            <th>Type</th>
            <th>From</th>
            <th>To</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                No time off scheduled.
              </td>
            </tr>
          )}
          {list.map((u) => (
            <tr key={u.id}>
              <td>{u.type}</td>
              <td>{u.start_date?.slice(0, 10)}</td>
              <td>{u.end_date?.slice(0, 10)}</td>
              <td>{u.reason || "—"}</td>
              <td>
                <button className="docmgmt-del" onClick={() => cancel(u)}>
                  Cancel
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {reassign && (
        <ReassignModal
          {...reassign}
          onClose={() => setReassign(null)}
          onDone={() => {
            setReassign(null);
            toast("Reassignment complete", "success");
            onChange?.();
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── Day View (read-only) ────────────────
function DayViewTab({ doctorId, refresh }) {
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get(`/api/doctors/${doctorId}/availability?date=${date}`),
      api.get(`/api/doctors/${doctorId}/profile`),
    ])
      .then(([a, p]) => {
        setSlots(a.data?.slots || []);
        setProfile(p.data || null);
      })
      .catch(() => {
        setSlots([]);
        setProfile(null);
      })
      .finally(() => setLoading(false));
  }, [doctorId, date, refresh]);

  // Only show slots inside working hours — hide "not a working slot".
  const dayOff = slots.length > 0 && slots.every((s) => s.blocked_by === "day_off");
  const visible = slots.filter((s) => s.blocked_by !== "not_working");
  const freeCount = visible.filter((s) => s.available).length;
  const t = (x) => (x ? String(x).slice(0, 5) : null);
  const hours =
    profile && t(profile.work_start) && t(profile.work_end)
      ? `${t(profile.work_start)}–${t(profile.work_end)}`
      : "All day";
  const lunch =
    profile && t(profile.lunch_start) && t(profile.lunch_end)
      ? `${t(profile.lunch_start)}–${t(profile.lunch_end)}`
      : null;

  return (
    <div>
      <p className="docmgmt-hint">What booking sees for this doctor on a given day.</p>
      <label className="docmgmt-form">
        Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>

      {!loading && profile && (
        <div className="docmgmt-dayinfo">
          <span>
            🕐 Working hours: <strong>{hours}</strong>
          </span>
          {lunch && (
            <span>
              🍽 Lunch: <strong>{lunch}</strong>
            </span>
          )}
          <span>
            ✅ <strong>{freeCount}</strong>/{visible.length} slots open
          </span>
        </div>
      )}

      {loading ? (
        <p className="docmgmt-empty">Loading…</p>
      ) : slots.length === 0 ? (
        <p className="docmgmt-empty">Could not load the day.</p>
      ) : dayOff ? (
        <p className="docmgmt-empty">🚫 Day off — the doctor is not working this day.</p>
      ) : (
        <div className="docmgmt-slots">
          {visible.map((s) => (
            <div key={s.slot_label} className={`slotpill ${s.available ? "free" : "blocked"}`}>
              <span>{s.slot_label}</span>
              <small>
                {s.available
                  ? s.capacity == null
                    ? `Available${s.booked ? ` · ${s.booked} booked` : ""}`
                    : `Available · ${s.booked}/${s.capacity} booked`
                  : labelReason(s.blocked_by)}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Reassignment Modal ──────────────────
function ReassignModal({ affected, doctor, unavailability_id, trigger, onClose, onDone }) {
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(affected);

  const movable = rows.filter((r) => !r.in_progress);
  const allPicked = movable.every((r) => picks[r.appointment_id]);

  const autofill = () => {
    const next = {};
    for (const r of movable) {
      const top = r.suggested_doctors?.[0];
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
        setRows((rs) => rs.filter((r) => failedIds.has(r.appointment_id)));
        setPicks({});
        toast(
          `${data.moved.length} moved, ${data.failed.length} failed (slot full?). Retry those.`,
          "warn",
        );
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
    <div className="docmgmt-modal-bg" onClick={onClose}>
      <div className="docmgmt-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Reassign patients — {doctor?.name} unavailable</h2>
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
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        const d = r.suggested_doctors.find((x) => x.doctor_id === id);
                        setPicks((p) => ({
                          ...p,
                          [r.appointment_id]: d
                            ? { to_doctor_id: d.doctor_id, to_doctor_name: d.doctor_name }
                            : undefined,
                        }));
                      }}
                    >
                      <option value="">— choose —</option>
                      {r.suggested_doctors.map((d) => (
                        <option key={d.doctor_id} value={d.doctor_id}>
                          {d.doctor_name} ({d.free_capacity} free){d.same_specialty ? " ⭐" : ""}
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
        <div className="docmgmt-modal-actions">
          <button onClick={autofill}>Auto-fill suggestions</button>
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="docmgmt-primary" disabled={busy || !allPicked} onClick={apply}>
            {busy ? "Reassigning…" : "Reassign all"}
          </button>
        </div>
        {!allPicked && (
          <p className="docmgmt-warnline">
            Every movable patient must have a doctor before you can finish.
          </p>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── helpers ─────────────────────────────
function SlotMultiSelect({ slots, value, onChange }) {
  const toggle = (label) =>
    onChange(value.includes(label) ? value.filter((l) => l !== label) : [...value, label]);
  return (
    <div className="docmgmt-slotmulti">
      {slots.map((s) => (
        <label key={s.label} className={value.includes(s.label) ? "on" : ""}>
          <input
            type="checkbox"
            checked={value.includes(s.label)}
            onChange={() => toggle(s.label)}
          />
          {s.label}
        </label>
      ))}
    </div>
  );
}

// For planned-leave affected lists that arrive without suggestions, fetch them.
async function enrichAffected(affected, doctorId, doctor) {
  const out = [];
  for (const a of affected) {
    let suggested = [];
    if (!a.in_progress) {
      try {
        const { data } = await api.get(
          `/api/availability/doctors-for-slot?date=${a.appointment_date?.slice(0, 10)}&slot=${encodeURIComponent(
            a.time_slot,
          )}&exclude=${doctorId}${doctor?.specialty ? `&specialty=${encodeURIComponent(doctor.specialty)}` : ""}`,
        );
        suggested = data || [];
      } catch {
        suggested = [];
      }
    }
    out.push({ ...a, suggested_doctors: suggested });
  }
  return out;
}

function labelReason(reason) {
  const map = {
    day_off: "Day off",
    not_working: "Not a working slot",
    clinic_holiday: "Clinic holiday",
    leave: "On leave",
    break: "Break",
    emergency: "Emergency leave",
    holiday: "Doctor holiday",
    manual_block: "Blocked",
    full: "Full",
  };
  return map[reason] || reason || "Unavailable";
}
