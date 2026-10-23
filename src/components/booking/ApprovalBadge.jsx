import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../../queries/keys";
import { PATIENT_TYPE_LABELS } from "../../../shared/slotCapacity";

const ApprovalsContext = createContext(new Map());

export function useLatestApprovals(ids) {
  const key = useMemo(
    () => [...new Set((ids || []).filter((id) => Number(id) > 0))].sort((a, b) => a - b),
    [ids],
  );
  const { data } = useQuery({
    queryKey: qk.bookingApprovals.latest(key),
    queryFn: async () => (await api.get(`/api/booking-approvals/latest?ids=${key.join(",")}`)).data,
    enabled: key.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return useMemo(() => new Map((data || []).map((a) => [a.appointment_id, a])), [data]);
}

export function ApprovalsProvider({ ids, children }) {
  const approvals = useLatestApprovals(ids);
  return <ApprovalsContext.Provider value={approvals}>{children}</ApprovalsContext.Provider>;
}

const TONES = {
  pending: { color: "#92400e", background: "#fffbeb", borderColor: "#fde68a" },
  approved: { color: "#047857", background: "#f0fdf4", borderColor: "#a7f3d0" },
  rejected: { color: "#b91c1c", background: "#fef2f2", borderColor: "#fecaca" },
};

export function ApprovalBadge({ appointmentId, timeSlot }) {
  const approval = useContext(ApprovalsContext).get(appointmentId);
  if (!approval) return null;
  if (approval.status === "rejected" && timeSlot) return null;
  const type = (PATIENT_TYPE_LABELS[approval.patient_type] || "").toLowerCase();
  const text =
    approval.status === "pending"
      ? "Pending approval"
      : approval.status === "approved"
        ? "Approved over limit"
        : "Rejected — choose another slot";
  const title =
    approval.status === "rejected"
      ? `Over the ${type} limit (${approval.limit}) in ${approval.slot_label}. ${approval.reason || ""}`
      : `Over the ${type} limit (${approval.limit}) in ${approval.slot_label}${approval.request_reason ? `. Reason: ${approval.request_reason}` : ""}`;
  return (
    <span
      title={title.trim()}
      style={{
        display: "inline-block",
        padding: "1px 7px",
        border: "1px solid",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        ...TONES[approval.status],
      }}
    >
      {text}
      {approval.status === "rejected" && approval.reason ? ` · ${approval.reason}` : ""}
    </span>
  );
}
