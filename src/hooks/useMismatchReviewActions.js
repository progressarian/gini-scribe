import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import { toast } from "../stores/uiStore";
import { qk } from "../queries/keys";

// Shared Accept/Reject logic for mismatch-review documents, usable from
// doctor-facing pages (Docs, Visit/docs, Visit/labs). The companion flow
// persists the raw extraction under `extracted_data.pending_payload` with
// `extraction_status: "mismatch_review"` — so accept/reject can be driven
// from any page by reading the stored payload, without touching the
// companion Zustand store.
function parseExtractedData(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

export function useMismatchReviewActions(patientId) {
  const queryClient = useQueryClient();
  const [review, setReview] = useState(null); // { action, doc }

  const invalidate = useCallback(() => {
    if (patientId) {
      queryClient.invalidateQueries({ queryKey: qk.patient.full(patientId) });
      queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientId) });
      queryClient.invalidateQueries({ queryKey: qk.visit.byPatient(patientId) });
    }
    queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
  }, [patientId, queryClient]);

  const acceptMutation = useMutation({
    mutationFn: async (doc) => {
      const ext = parseExtractedData(doc.extracted_data);
      const payload = ext?.pending_payload ? { ...ext.pending_payload } : null;
      if (!payload) {
        throw new Error("No pending extraction payload on this document");
      }
      const meta = ext?.pending_meta || {};
      const fileName = ext?.file_name || doc.file_name || doc.title;

      if ((payload.medications || []).length > 0 && doc.patient_id) {
        try {
          await api.post(`/api/patients/${doc.patient_id}/history`, {
            visit_date: meta?.date || payload.visit_date || new Date().toISOString().slice(0, 10),
            visit_type: "OPD",
            doctor_name: meta?.doctor || payload.doctor_name || "",
            specialty: meta?.specialty || payload.specialty || "",
            hospital_name: meta?.hospital || payload.hospital_name || "",
            diagnoses: payload.diagnoses || [],
            medications: payload.medications || [],
            labs: (payload.labs || []).map((l) => ({
              test_name: l.test_name,
              result: l.result,
              unit: l.unit,
              flag: l.flag,
              ref_range: l.ref_range,
            })),
            vitals: payload.vitals || {},
          });
        } catch (e) {
          console.warn(`History POST failed for doc ${doc.id}:`, e);
        }
      }

      if (payload.extraction_status === "pending") delete payload.extraction_status;
      await api.patch(`/api/documents/${doc.id}`, { extracted_data: payload });
      return { fileName };
    },
    onSuccess: ({ fileName }) => {
      toast(`Accepted extraction for ${fileName || "document"}`, "success");
      invalidate();
    },
    onError: (e) => {
      toast(`Failed to accept: ${e.response?.data?.error || e.message || "error"}`, "error");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (doc) => {
      const ext = parseExtractedData(doc.extracted_data);
      const fileName = ext?.file_name || doc.file_name || doc.title;
      await api.delete(`/api/documents/${doc.id}`);
      return { fileName };
    },
    onSuccess: ({ fileName }) => {
      toast(`Rejected & deleted ${fileName || "document"}`, "success");
      invalidate();
    },
    onError: (e) => {
      toast(`Failed to reject: ${e.response?.data?.error || e.message || "error"}`, "error");
    },
  });

  const openReview = useCallback((doc, action) => {
    setReview({ doc, action });
  }, []);
  const closeReview = useCallback(() => setReview(null), []);

  const confirmReview = useCallback(() => {
    if (!review) return;
    const { doc, action } = review;
    setReview(null);
    if (action === "accept") acceptMutation.mutate(doc);
    else rejectMutation.mutate(doc);
  }, [review, acceptMutation, rejectMutation]);

  const isBusy = (docId) => {
    const accepting = acceptMutation.isPending && acceptMutation.variables?.id === docId;
    const rejecting = rejectMutation.isPending && rejectMutation.variables?.id === docId;
    return accepting || rejecting;
  };

  return { review, openReview, closeReview, confirmReview, isBusy };
}

export { parseExtractedData };
