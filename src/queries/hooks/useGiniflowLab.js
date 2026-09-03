import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { pollInterval } from "./giniflowPolling";

export function useLabQueue(date) {
  return useQuery({
    queryKey: ["giniflow", "lab", "queue", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/lab/queue", { params: date ? { date } : {} })).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

// Uploading is one call: the file is stored and the order advanced together, so
// a report can never sit in storage with the MO still waiting.
export function useUploadReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, file }) => {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });
      return (
        await api.post(`/api/giniflow/stations/lab/${orderId}/report`, {
          base64,
          fileName: file.name,
          mediaType: file.type || "application/pdf",
        })
      ).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}

export function useAdvanceSample() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, to, reportUrl }) =>
      (await api.post(`/api/giniflow/stations/lab/${orderId}/advance`, { to, reportUrl })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] });
      // Uploading turns the patient green on the board and the MO queue.
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
    },
  });
}

// Confirm-and-attribute on a hospital-lab case. Nothing reaches HealthRay — this
// records who chased the sample — so only the lab queries need refreshing.
export function useMarkLabCaseAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ caseNo, action, undo }) =>
      (await api.post(`/api/giniflow/stations/lab/case/${caseNo}/action`, { action, undo })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] }),
  });
}

// Admin override: attach a report to a HealthRay-run case the sync has not been
// able to fetch a PDF for.
export function useUploadLabCaseReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ caseNo, file }) => {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });
      return (
        await api.post(`/api/giniflow/stations/lab/case/${caseNo}/report`, {
          base64,
          fileName: file.name,
          mediaType: file.type || "application/pdf",
        })
      ).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] });
      // It can flip results_status, which is what the MO, doctor and board read.
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "mo"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor"] });
    },
  });
}

// Where "View uploaded report" points.
//
// NOT the stored `reportUrl`: `patient-files` is a private bucket, so the public
// object URL 404s with "Bucket not found". This hits the API, which proxies the
// bytes with the service key and echoes the stored object's real content type —
// the one report on file is a PNG, not a PDF, so the path is `.file`, not
// `.pdf`. `?token=` because a tab opened on a URL carries no header — the same self-authenticating form the referral letter and
// the document stream already use.
export const reportHref = (orderId) =>
  `${API_URL}/api/giniflow/stations/lab/${orderId}/report.file?token=${encodeURIComponent(
    localStorage.getItem("gini_auth_token") || "",
  )}`;
