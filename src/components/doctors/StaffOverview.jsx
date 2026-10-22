import { useEffect, useState } from "react";
import api from "../../services/api";
import { formatTime, toMinutes } from "../../../shared/slotTemplates";
import { SCHEDULED_ROLES, staffRoleLabel } from "../../../shared/staffRoles";

const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const TIME_OFF_LABEL = {
  leave: "Leave",
  holiday: "Holiday",
  emergency: "Emergency leave",
  break: "Break",
};
const OFF_DAY = ["leave", "holiday", "emergency"];

const shortDate = (iso) =>
  new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const clock = (t) => formatTime(toMinutes(String(t).slice(0, 5)));

function todayText(slots) {
  if (!slots.length) return { status: "Unknown", detail: "Could not read today's slots." };
  if (slots.every((s) => s.blocked_by === "day_off"))
    return { status: "Day off", detail: "Not a working day." };
  if (slots.every((s) => s.blocked_by === "clinic_holiday"))
    return { status: "Clinic holiday", detail: "The clinic is closed today." };
  const working = slots.filter((s) => s.blocked_by !== "break" && s.blocked_by !== "not_working");
  const off = working.find((s) => OFF_DAY.includes(s.blocked_by));
  if (working.length && working.every((s) => OFF_DAY.includes(s.blocked_by)))
    return {
      status: TIME_OFF_LABEL[off.blocked_by],
      detail: off.detail || "Not bookable today.",
    };
  const open = working.filter((s) => s.available).length;
  const breaks = slots.filter((s) => s.blocked_by === "break" && s.detail);
  return {
    status: open ? "Available" : "Fully booked or blocked",
    hours: !working.length
      ? null
      : String(working[0].start_time) === String(working.at(-1).end_time)
        ? "All day"
        : `${clock(working[0].start_time)} – ${clock(working.at(-1).end_time)}`,
    detail: [
      `${open} of ${working.length} slots open`,
      ...breaks.map((b) => `${b.detail} ${b.slot_label}`),
    ].join(" · "),
  };
}

function Stat({ label, children, sub }) {
  return (
    <div className="docmgmt-stat">
      <dt>{label}</dt>
      <dd>
        <span className="docmgmt-stat-value">{children}</span>
        {sub && <span className="docmgmt-stat-sub">{sub}</span>}
      </dd>
    </div>
  );
}

export default function StaffOverview({
  doctor,
  refresh,
  hasSettings,
  onEditSchedule,
  onAddTimeOff,
  onSettings,
}) {
  const scheduled = SCHEDULED_ROLES.includes(doctor.role);
  const [today, setToday] = useState(null);
  const [future, setFuture] = useState(null);
  const [timeOff, setTimeOff] = useState(null);

  useEffect(() => {
    if (!scheduled) return;
    setToday(null);
    setFuture(null);
    setTimeOff(null);
    const date = todayISO();
    api
      .get(`/api/doctors/${doctor.id}/availability?date=${date}`)
      .then((r) => setToday(todayText(r.data?.slots || [])))
      .catch(() => setToday({ status: "Unknown", detail: "Could not load today's slots." }));
    api
      .get(`/api/doctors/${doctor.id}/removal`)
      .then((r) => setFuture(r.data?.future_appointments ?? 0))
      .catch(() => setFuture("error"));
    api
      .get(`/api/doctors/${doctor.id}/unavailability`)
      .then((r) =>
        setTimeOff((r.data || []).filter((u) => String(u.end_date).slice(0, 10) >= date)),
      )
      .catch(() => setTimeOff("error"));
  }, [doctor.id, scheduled, refresh]);

  if (!scheduled)
    return (
      <div className="docmgmt-overview">
        <p className="docmgmt-hint">
          {staffRoleLabel(doctor.role)} staff have no schedule or time off here. What they can open
          is set by their role.
        </p>
        {hasSettings && (
          <div className="docmgmt-quick">
            <button type="button" className="docmgmt-secondary" onClick={onSettings}>
              Open settings
            </button>
          </div>
        )}
      </div>
    );

  const next = Array.isArray(timeOff) ? timeOff[0] : null;

  return (
    <div className="docmgmt-overview">
      <dl className="docmgmt-stats">
        <Stat label="Today" sub={today?.detail}>
          {today ? (
            <>
              {today.status}
              {today.hours && <small> · {today.hours}</small>}
            </>
          ) : (
            "Loading…"
          )}
        </Stat>
        <Stat label="Booked from today" sub="Appointments not yet seen or cancelled">
          {future === null ? "Loading…" : future === "error" ? "Could not load" : future}
        </Stat>
        <Stat
          label="Upcoming time off"
          sub={
            next
              ? `Next: ${TIME_OFF_LABEL[next.type] || next.type} ${shortDate(next.start_date)}${
                  String(next.end_date).slice(0, 10) !== String(next.start_date).slice(0, 10)
                    ? ` – ${shortDate(next.end_date)}`
                    : ""
                }`
              : null
          }
        >
          {timeOff === null
            ? "Loading…"
            : timeOff === "error"
              ? "Could not load"
              : timeOff.length || "None"}
        </Stat>
      </dl>
      <div className="docmgmt-quick" role="group" aria-label="Quick actions">
        <button type="button" className="docmgmt-secondary" onClick={onEditSchedule}>
          Edit schedule
        </button>
        <button type="button" className="docmgmt-secondary" onClick={onAddTimeOff}>
          Add time off
        </button>
        {hasSettings && (
          <button type="button" className="docmgmt-secondary" onClick={onSettings}>
            Settings
          </button>
        )}
      </div>
    </div>
  );
}
