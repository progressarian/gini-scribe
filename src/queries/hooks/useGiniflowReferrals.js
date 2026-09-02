import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { pollInterval } from "./giniflowPolling";

// Referrals — docs/gini-flow/19-REFERRALS-STATION-PLAN.md §10.
//
// A referral never moves a patient's status, so nothing here needs the board's
// mutations. It does invalidate the board and the launcher summary: the tile's
// count and the Finalize panel's named specialties both read this list.

const base = "/api/giniflow/referrals";

export function useReferrals(date, q) {
  const search = q?.trim() || undefined;
  return useQuery({
    queryKey: ["giniflow", "referrals", "list", date || "today", search || ""],
    queryFn: async () =>
      (
        await api.get(base, {
          params: { ...(date ? { date } : {}), ...(search ? { q: search } : {}) },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

// The create form's patient picker. Two characters is the floor the API also
// enforces, so the query simply does not run below it.
export function useReferralPatientSearch(q, date) {
  const search = q?.trim() || "";
  return useQuery({
    queryKey: ["giniflow", "referrals", "patients", date || "today", search],
    queryFn: async () =>
      (await api.get(`${base}/patients`, { params: { q: search, ...(date ? { date } : {}) } })).data
        .patients,
    enabled: search.length >= 2,
    staleTime: 30_000,
  });
}

// What the consultant's chips read back — which specialties this visit already
// carries, so a chip cannot look unselected while a letter exists behind it.
export function useVisitReferrals(visitId) {
  return useQuery({
    queryKey: ["giniflow", "referrals", "visit", visitId],
    queryFn: async () => (await api.get(`${base}/visit/${visitId}`)).data.referrals,
    enabled: !!visitId,
  });
}

const useReferralAction = (fn) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "referrals"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "stations", "summary"] });
    },
  });
};

export const useCreateReferral = () =>
  useReferralAction(async (body) => (await api.post(base, body)).data);

export const useToggleReferralChip = () =>
  useReferralAction(async ({ visitId, specialty, urgency = "routine" }) =>
    api.post(`${base}/visit/${visitId}`, { specialty, urgency }).then((r) => r.data),
  );

export const useRemoveReferral = () =>
  useReferralAction(async (id) => (await api.delete(`${base}/${id}`)).data);

export const useGenerateLetter = () =>
  useReferralAction(
    async ({ id, force = false }) => (await api.post(`${base}/${id}/letter`, { force })).data,
  );

export const useSendLetter = () =>
  useReferralAction(
    async ({ id, to = "patient", force = false }) =>
      (await api.post(`${base}/${id}/send`, { to, force })).data,
  );

export const useBookReferralAppointment = () =>
  useReferralAction(
    async ({ id, date, note }) =>
      (await api.post(`${base}/${id}/appointment`, { date, note: note || null })).data,
  );

export const useCompleteReferral = () =>
  useReferralAction(
    async (id) => (await api.post(`${base}/${id}/complete`, { confirm: true })).data,
  );

// The letter opens in a new tab, so it must carry the token itself — the same
// `?token=` self-authenticating URL shape image and PDF links already use.
export const letterHref = (id) =>
  `${API_URL}${base}/${id}/letter.pdf?token=${encodeURIComponent(localStorage.getItem("gini_auth_token") || "")}`;
