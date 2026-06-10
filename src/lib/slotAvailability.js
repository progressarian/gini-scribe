// Shared booking-slot availability helpers for the manual booking screens
// (GHM/OPD have their own inline copies; Find + Dashboard use this).
import { useEffect, useState } from "react";
import api from "../services/api.js";

// The 24h catalog labels — fallback when a doctor's availability isn't loaded.
export const SLOT_CATALOG = [
  "9:30 AM to 10 AM",
  "10 AM to 11 AM",
  "11 AM to 12 PM",
  "12 PM to 1 PM",
  "1 PM to 2 PM",
  "2 PM to 2:30 PM",
  "2:30 PM to 3 PM",
  "3 PM to 3:30 PM",
  "3:30 PM to 4 PM",
  "4 PM to 4:30 PM",
  "4:30 PM to 5 PM",
  "5 PM to 6 PM",
  "6 PM to 7 PM",
  "7 PM to 8 PM",
  "8 PM to 9 PM",
  "9 PM to 10 PM",
  "10 PM to 11 PM",
  "11 PM to 12 AM",
  "12 AM to 1 AM",
  "1 AM to 2 AM",
  "2 AM to 3 AM",
  "3 AM to 4 AM",
  "4 AM to 5 AM",
  "5 AM to 6 AM",
  "6 AM to 7 AM",
  "7 AM to 8 AM",
  "8 AM to 9 AM",
  "9 AM to 9:30 AM",
];

// Why a slot is unavailable (from the doctor-availability resolver).
export const SLOT_REASON = {
  day_off: "Day off",
  not_working: "Not working",
  clinic_holiday: "Clinic holiday",
  break: "Break",
  leave: "On leave",
  emergency: "Emergency leave",
  holiday: "Holiday",
  manual_block: "Blocked",
  full: "Full",
};

// Hide non-clinical staff from a doctor picker; keep doctors (incl. odd roles).
export const isClinicalDoctor = (d) =>
  d?.name &&
  !["nurse", "lab", "tech", "reception", "pharmacy", "coordinator", "admin", "guest"].includes(
    String(d.role || "").toLowerCase(),
  );

// Options for the slot dropdown: all catalog slots annotated, with the
// out-of-hours ("not_working") ones removed. Available ones are selectable;
// the rest carry a reason for greying out.
export const slotOptions = (slots) =>
  (slots || SLOT_CATALOG.map((s) => ({ slot_label: s, available: true }))).filter(
    (s) => s.blocked_by !== "not_working",
  );

/**
 * Live day availability for a doctor name + date.
 * @returns slots array (annotated) | null (no doctor/date, or unknown doctor → all slots).
 */
export function useDayAvailability(doctorName, date) {
  const [slots, setSlots] = useState(null);
  useEffect(() => {
    if (!doctorName || !date) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    api
      .get(`/api/availability/day?doctor=${encodeURIComponent(doctorName)}&date=${date}`)
      .then(({ data }) => {
        if (!cancelled) setSlots(data?.resolved ? data.slots || [] : null);
      })
      .catch(() => {
        if (!cancelled) setSlots(null);
      });
    return () => {
      cancelled = true;
    };
  }, [doctorName, date]);
  return slots;
}
