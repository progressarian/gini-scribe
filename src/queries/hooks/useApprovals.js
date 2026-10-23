import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions";

export const APPROVALS_WAITING_KEY = ["billing", "approvals-waiting"];

const POLL_MS = 30_000;

export function useApprovalAccess() {
  const doctor = useAuthStore((s) => s.currentDoctor);
  const desk = hasCapability(doctor, CAP.BILLING_MASTER);
  const tests = hasCapability(doctor, CAP.GINIFLOW_TEST_CANCEL_DECIDE);
  const bookings = hasCapability(doctor, CAP.BOOKING_APPROVE);
  return { desk, tests, bookings, any: desk || tests || bookings };
}

export function useApprovalsWaiting() {
  const access = useApprovalAccess();
  const { data } = useQuery({
    queryKey: APPROVALS_WAITING_KEY,
    queryFn: async () => (await api.get("/api/approvals/waiting")).data,
    enabled: access.any,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const desk = data?.deskRequests ?? 0;
  const tests = data?.testCancellations ?? 0;
  const bookings = data?.bookingApprovals ?? 0;
  return {
    ...access,
    deskCount: desk,
    testsCount: tests,
    bookingsCount: bookings,
    total: desk + tests + bookings,
    loaded: !!data,
  };
}
