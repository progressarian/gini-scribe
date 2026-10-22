// Shared booking-slot availability helpers for the manual booking screens
// (GHM/OPD have their own inline copies; Find + Dashboard use this).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "../services/api.js";
import { qk } from "../queries/keys.js";
import { capacityNote } from "../../shared/slotCapacity.js";

export function useSlotCatalog() {
  const { data } = useQuery({
    queryKey: qk.slotCatalog,
    queryFn: async () => (await api.get("/api/slot-catalog")).data.map((s) => s.label),
    staleTime: 60 * 60 * 1000,
  });
  return data || [];
}

export const ARRIVAL_TIME_RANGES = [
  "8 AM to 9 AM",
  "9 AM to 10 AM",
  "10 AM to 11 AM",
  "11 AM to 12 PM",
  "12 PM to 1 PM",
  "1 PM to 2 PM",
  "2 PM to 3 PM",
  "3 PM to 4 PM",
  "4 PM to 5 PM",
  "5 PM to 6 PM",
  "6 PM to 7 PM",
  "7 PM to 8 PM",
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

export const slotOptionLabel = (s) => {
  if (!s.available) return `${s.slot_label} — ${SLOT_REASON[s.blocked_by] || "Unavailable"}`;
  const note = capacityNote(s);
  return note ? `${s.slot_label} — ${note}` : s.slot_label;
};

// Hide non-clinical staff from a doctor picker; keep doctors (incl. odd roles).
export const isClinicalDoctor = (d) =>
  d?.name &&
  ![
    "nurse",
    "lab",
    "tech",
    "reception",
    "pharmacy",
    "rx",
    "coordinator",
    "admin",
    "guest",
  ].includes(String(d.role || "").toLowerCase());

// Options for the slot dropdown: the doctor's day annotated, or the catalog
// when no doctor/date is known, with out-of-hours ("not_working") ones removed.
export const slotOptions = (slots, catalog = []) =>
  (slots || catalog.map((s) => ({ slot_label: s, available: true }))).filter(
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
