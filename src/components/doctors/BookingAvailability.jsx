import { useEffect, useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../ui/ConfirmModal";
import ReassignModal, { enrichAffected } from "./ReassignModal";
import { CAP_KEYS, PATIENT_TYPES, capacityNote } from "../../../shared/slotCapacity";
import SlotLimitsPanel from "./SlotLimitsPanel";

const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const nowClock = () =>
  new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

const longDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export default function BookingAvailability({ doctorId, doctor, refresh, onChange }) {
  const [date, setDate] = useState(todayISO());
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState([]);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [unblocking, setUnblocking] = useState(null);
  const [unblockBusy, setUnblockBusy] = useState(false);
  const [reassign, setReassign] = useState(null);
  const [limiting, setLimiting] = useState(null);
  const [limitBusy, setLimitBusy] = useState(false);

  const stopSelecting = () => {
    setSelecting(false);
    setPicked([]);
    setReason("");
  };

  useEffect(stopSelecting, [doctorId, date]);
  useEffect(() => setLimiting(null), [doctorId, date]);

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
  const past = (s) => date < todayISO() || (date === todayISO() && s.start_time <= nowClock());
  const blockable = (s) => (s.available || s.blocked_by === "full") && !past(s);
  const selectable = visible.filter(blockable);
  const skipped = visible.length - selectable.length;
  const limitable = (s) =>
    !!day?.from_template && !!s.caps && (s.available || s.blocked_by === "full") && !past(s);

  const saveLimits = async ({ caps, reason }) => {
    setLimitBusy(true);
    try {
      const { data } = await api.put(`/api/doctors/${doctorId}/slot-caps/${date}`, {
        reason,
        slots: [
          {
            start: limiting.start_time.slice(0, 5),
            ...Object.fromEntries(PATIENT_TYPES.map((t) => [CAP_KEYS[t], caps[t]])),
          },
        ],
      });
      setDay(data);
      toast(`${limiting.slot_label} changed for ${date} only`, "success");
      setLimiting(null);
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not save the numbers. Try again.", "error");
    } finally {
      setLimitBusy(false);
    }
  };

  const resetLimits = async () => {
    setLimitBusy(true);
    try {
      const { data } = await api.delete(
        `/api/doctors/${doctorId}/slot-caps/${date}/${limiting.start_time.slice(0, 5)}`,
      );
      setDay(data);
      toast(`${limiting.slot_label} back to the weekly numbers`, "success");
      setLimiting(null);
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not undo the change. Try again.", "error");
    } finally {
      setLimitBusy(false);
    }
  };

  const toggle = (label) =>
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));

  const block = async () => {
    if (!reason.trim()) return toast("Give a reason for the break, e.g. Ward round", "warn");
    setSaving(true);
    try {
      const ordered = visible.filter((s) => picked.includes(s.slot_label)).map((s) => s.slot_label);
      const { data } = await api.post(`/api/doctors/${doctorId}/break`, {
        start_date: date,
        end_date: date,
        slot_labels: ordered,
        reason: reason.trim(),
      });
      stopSelecting();
      onChange?.();
      if (data.requires_reassignment) {
        const enriched = await enrichAffected(data.affected, doctorId, doctor);
        setReassign({ affected: enriched, doctor, trigger: "break" });
      } else
        toast(
          `${ordered.length} slot${ordered.length === 1 ? "" : "s"} blocked: ${reason.trim()}`,
          "success",
        );
    } catch (e) {
      toast(
        e.response?.data?.message ||
          e.response?.data?.error ||
          "Could not block the slots. Try again.",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const unblock = async () => {
    setUnblockBusy(true);
    try {
      await api.patch(`/api/doctors/${doctorId}/unavailability/${unblocking.id}`, {
        status: "cancelled",
      });
      toast("Break removed — those slots can be booked again", "success");
      setUnblocking(null);
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not remove the break. Try again.", "error");
    } finally {
      setUnblockBusy(false);
    }
  };

  const openUnblock = (s) =>
    setUnblocking({
      id: s.time_off_id,
      reason: s.detail,
      labels: visible.filter((x) => x.time_off_id === s.time_off_id).map((x) => x.slot_label),
    });

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
      <div className="docmgmt-sectionhead docmgmt-availhead">
        <p className="docmgmt-hint">
          {selecting
            ? "Tick the slots to block on this day, give a reason, then block them."
            : "What patients can actually book with this doctor on the chosen day, including time off. Click an open slot to change its numbers for this date only, or a blocked slot to unblock it."}
        </p>
        {!selecting && !dayOff && slots.some(blockable) && (
          <button
            type="button"
            className="docmgmt-secondary docmgmt-small"
            onClick={() => setSelecting(true)}
          >
            Select slots to block
          </button>
        )}
      </div>

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
        <div className="docmgmt-slots" aria-label="Slots on this day">
          {visible.map((s) => {
            const on = picked.includes(s.slot_label);
            const pickable = selecting && blockable(s);
            const unblockable = !selecting && s.time_off_id && s.blocked_by === "break";
            const settable = !selecting && !unblockable && limitable(s);
            const Tag = pickable || unblockable || settable ? "button" : "div";
            return (
              <Tag
                key={s.slot_label}
                {...(Tag === "button"
                  ? {
                      type: "button",
                      "aria-pressed": pickable
                        ? on
                        : settable
                          ? limiting?.slot_label === s.slot_label
                          : undefined,
                      "aria-label": pickable
                        ? `${on ? "Unselect" : "Select"} ${s.slot_label}`
                        : settable
                          ? `Change patients per slot for ${s.slot_label} on this date`
                          : `Unblock ${s.slot_label}`,
                      onClick: () =>
                        pickable
                          ? toggle(s.slot_label)
                          : settable
                            ? setLimiting(s)
                            : openUnblock(s),
                    }
                  : {})}
                className={`slotpill ${s.available ? "free" : "blocked"}${on ? " picked" : ""}${
                  selecting && !pickable ? " dimmed" : ""
                }${Tag === "button" ? " clickable" : ""}`}
              >
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
                {s.cap_source === "date" && (
                  <small className="slotpill-changed" title={s.date_cap_reason || undefined}>
                    Changed for this date
                  </small>
                )}
              </Tag>
            );
          })}
        </div>
      )}

      {limiting && (
        <SlotLimitsPanel
          key={`${date}|${limiting.slot_label}`}
          title={limiting.slot_label}
          context={doctor?.name}
          note={`${longDay(date)} only · the weekly schedule is not changed`}
          caps={limiting.caps}
          needsReason
          busy={limitBusy}
          applyLabel="Save for this date"
          resetLabel={limiting.cap_source === "date" ? "Use the weekly numbers" : undefined}
          onReset={limiting.cap_source === "date" ? resetLimits : undefined}
          onApply={saveLimits}
          onCancel={() => setLimiting(null)}
        />
      )}

      {selecting && (
        <div className="docmgmt-savebar docmgmt-blockbar" role="region" aria-label="Block slots">
          <span className="docmgmt-hint">
            {picked.length} of {selectable.length} open slot{selectable.length === 1 ? "" : "s"}{" "}
            selected
            {skipped > 0 && ` · ${skipped} can't be blocked (already passed or already blocked)`}
          </span>
          <button
            type="button"
            className="docmgmt-linkbtn"
            disabled={saving}
            onClick={() =>
              setPicked(
                picked.length === selectable.length ? [] : selectable.map((x) => x.slot_label),
              )
            }
          >
            {picked.length === selectable.length ? "Clear all" : "Select all"}
          </button>
          <label className="docmgmt-blockreason">
            Reason (required)
            <input
              value={reason}
              maxLength={120}
              placeholder="e.g. Ward round"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="docmgmt-secondary"
            disabled={saving}
            onClick={stopSelecting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="docmgmt-primary"
            disabled={saving || !picked.length || !reason.trim()}
            onClick={block}
          >
            {saving
              ? "Blocking…"
              : `Block ${picked.length || ""} slot${picked.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      <ConfirmModal
        open={!!unblocking}
        title="Remove this break?"
        message={
          unblocking && (
            <div className="docmgmt-confirmbody">
              <p>
                {doctor?.name} · {date} · {unblocking.reason || "Break"}
              </p>
              <p>Slots: {unblocking.labels.join(", ")}</p>
              <p>
                These slots can be booked again. Patients already moved to another doctor stay where
                they are.
              </p>
            </div>
          )
        }
        confirmLabel="Remove break"
        cancelLabel="Keep it"
        busy={unblockBusy}
        onConfirm={unblock}
        onCancel={() => !unblockBusy && setUnblocking(null)}
      />

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
