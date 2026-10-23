// Shared booking-slot availability helpers for the manual booking screens
// (GHM/OPD have their own inline copies; Find + Dashboard use this).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "../services/api.js";
import { qk } from "../queries/keys.js";
import queryClient from "../queries/client.js";
import { capacityNote, PATIENT_TYPE_LABELS } from "../../shared/slotCapacity.js";
import { toast } from "../stores/uiStore.js";

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
  const type = s.patient_type;
  if (type) {
    const limit = s.caps?.[type];
    if (limit == null) return s.slot_label;
    const label = PATIENT_TYPE_LABELS[type];
    return s.over_limit
      ? `${s.slot_label} — ${label} ${s.over_limit.count}/${limit} full · over the limit`
      : `${s.slot_label} — ${label} ${s.counts?.[type] ?? 0}/${limit}`;
  }
  const note = capacityNote(s);
  return note ? `${s.slot_label} — ${note}` : s.slot_label;
};

export const availabilityQuery = (doctorName, date, patient = {}) => {
  const q = new URLSearchParams({ doctor: doctorName, date });
  if (patient.patientId) q.set("patient_id", patient.patientId);
  if (patient.fileNo) q.set("file_no", patient.fileNo);
  if (patient.walkin) q.set("walkin", "1");
  if (patient.visitType) q.set("visit_type", patient.visitType);
  if (patient.exclude) q.set("exclude", patient.exclude);
  return `/api/availability/day?${q}`;
};

export const patientKey = (p = {}) =>
  [p.patientId, p.fileNo, p.walkin ? 1 : 0, p.visitType, p.exclude].map((v) => v ?? "").join("|");

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
export function useDayAvailability(doctorName, date, patient) {
  const [slots, setSlots] = useState(null);
  useEffect(() => {
    if (!doctorName || !date) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    api
      .get(availabilityQuery(doctorName, date, patient))
      .then(({ data }) => {
        if (!cancelled) setSlots(data?.resolved ? data.slots || [] : null);
      })
      .catch(() => {
        if (!cancelled) setSlots(null);
      });
    return () => {
      cancelled = true;
    };
  }, [doctorName, date, patientKey(patient)]);
  return slots;
}

export const notifyApproval = (appointment) => {
  const a = appointment?.approval;
  if (!a) return;
  queryClient.invalidateQueries({ queryKey: qk.bookingApprovals.all });
  if (a.status !== "pending") return;
  toast(
    `Booked, pending admin approval: the ${PATIENT_TYPE_LABELS[a.patient_type].toLowerCase()} limit of ${a.limit} for this slot is reached.`,
    "warn",
    8000,
  );
};
