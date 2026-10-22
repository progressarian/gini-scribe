import { useEffect, useState } from "react";
import api from "../../services/api";
import { capacityNote } from "../../../shared/slotCapacity";

const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function BookingAvailability({ doctorId, refresh }) {
  const [date, setDate] = useState(todayISO());
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .get(`/api/doctors/${doctorId}/availability?date=${date}`)
      .then((a) => setDay(a.data || null))
      .catch(() => setDay(null))
      .finally(() => setLoading(false));
  }, [doctorId, date, refresh]);

  const slots = day?.slots || [];
  const warnings = day?.warnings || [];
  const dayOff = slots.length > 0 && slots.every((s) => s.blocked_by === "day_off");
  const visible = slots.filter((s) => s.blocked_by !== "not_working");
  const open = visible.filter((s) => s.blocked_by !== "break");
  const freeCount = open.filter((s) => s.available).length;
  const breaks = visible.filter((s) => s.blocked_by === "break" && s.detail);

  return (
    <div>
      <div className="docmgmt-dayhead">
        <h3 className="docmgmt-subhead">Booking availability</h3>
        <div className="docmgmt-daynav">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => setDate(shiftDay(date, -1))}
          >
            ‹
          </button>
          <label>
            <span className="docmgmt-visually-hidden">Preview date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
          <button type="button" aria-label="Next day" onClick={() => setDate(shiftDay(date, 1))}>
            ›
          </button>
        </div>
      </div>
      <p className="docmgmt-hint">
        What patients can actually book with this doctor on the chosen day, including time off.
      </p>

      {!loading && day && !dayOff && (
        <div className="docmgmt-dayinfo">
          <span>
            <strong>{freeCount}</strong>/{open.length} slots open
          </span>
          {breaks.map((b) => (
            <span key={b.slot_label}>
              {b.detail} <strong>{b.slot_label}</strong>
            </span>
          ))}
        </div>
      )}
      {!loading && warnings.length > 0 && (
        <div className="docmgmt-note warn" role="status">
          <p>
            HealthRay bookings outside this schedule. Scribe can't move these — move them in
            HealthRay.
          </p>
          <ul>
            {warnings.map((w) => (
              <li key={w.message}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <p className="docmgmt-empty">Loading…</p>
      ) : slots.length === 0 ? (
        <p className="docmgmt-empty">Could not load the day.</p>
      ) : dayOff ? (
        <p className="docmgmt-empty">Day off — not a working day.</p>
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
                  : s.blocked_by === "break" && s.detail
                    ? s.detail
                    : labelReason(s.blocked_by)}
              </small>
              {s.available && capacityNote(s) && (
                <small className="slotpill-caps">{capacityNote(s)}</small>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
