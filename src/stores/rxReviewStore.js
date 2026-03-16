import { create } from "zustand";
import api from "../services/api.js";
import { sa, ts } from "../config/constants.js";
import useAuthStore from "./authStore.js";

const useRxReviewStore = create((set, get) => ({
  // ── Rx Review state ──
  rxReview: null,
  rxReviewLoading: false,

  // ── Clinical Reasoning state ──
  crExpanded: false,
  crText: "",
  crCondition: "",
  crTags: [],
  crSaving: false,
  crSaved: null,
  crRecording: false,
  crAudioBlob: null,
  crAudioUrl: null,
  crTranscribing: false,

  // ── Rx Feedback state ──
  rxFbAgreement: null,
  rxFbText: "",
  rxFbCorrect: "",
  rxFbReason: "",
  rxFbTags: [],
  rxFbSeverity: null,
  rxFbSaving: false,
  rxFbSaved: null,

  // ── simple setters ──
  setRxReview: (val) => set({ rxReview: val }),
  setRxReviewLoading: (val) => set({ rxReviewLoading: val }),
  setCrExpanded: (val) => set({ crExpanded: val }),
  setCrText: (val) =>
    set(typeof val === "function" ? (state) => ({ crText: val(state.crText) }) : { crText: val }),
  setCrCondition: (val) => set({ crCondition: val }),
  setCrTags: (val) =>
    set(typeof val === "function" ? (state) => ({ crTags: val(state.crTags) }) : { crTags: val }),
  setCrSaving: (val) => set({ crSaving: val }),
  setCrSaved: (val) => set({ crSaved: val }),
  setCrRecording: (val) => set({ crRecording: val }),
  setCrAudioBlob: (val) => set({ crAudioBlob: val }),
  setCrAudioUrl: (val) => set({ crAudioUrl: val }),
  setCrTranscribing: (val) => set({ crTranscribing: val }),
  setRxFbAgreement: (val) => set({ rxFbAgreement: val }),
  setRxFbText: (val) => set({ rxFbText: val }),
  setRxFbCorrect: (val) => set({ rxFbCorrect: val }),
  setRxFbReason: (val) => set({ rxFbReason: val }),
  setRxFbTags: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ rxFbTags: val(state.rxFbTags) })
        : { rxFbTags: val },
    ),
  setRxFbSeverity: (val) => set({ rxFbSeverity: val }),
  setRxFbSaving: (val) => set({ rxFbSaving: val }),
  setRxFbSaved: (val) => set({ rxFbSaved: val }),

  // ── actions ──

  runRxReview: async (patient, vitals, moData, conData, patientFullData) => {
    const { conName } = useAuthStore.getState();
    set({ rxReviewLoading: true, rxReview: null });
    let ctx = "";
    if (patient.name) ctx += `Patient: ${patient.name}, ${patient.age}Y/${patient.sex}\n`;
    const allDiags = sa(moData, "diagnoses");
    if (allDiags.length)
      ctx += `Diagnoses: ${allDiags.map((d) => `${d.label} (${d.status})`).join(", ")}\n`;
    const meds =
      sa(conData, "medications_confirmed").length > 0
        ? sa(conData, "medications_confirmed")
        : sa(moData, "previous_medications");
    if (meds.length)
      ctx += `Current Meds: ${meds.map((m) => `${m.name} ${m.dose} ${m.frequency || m.timing || ""}`).join(", ")}\n`;
    if (moData?.investigations?.length)
      ctx += `Recent Labs: ${moData.investigations.map((i) => `${i.test}: ${i.value} ${i.unit || ""} (ref: ${i.ref || ""})`).join(", ")}\n`;
    if (vitals.bp_sys)
      ctx += `Vitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, Wt ${vitals.weight}kg, BMI ${vitals.bmi}\n`;
    if (moData?.complications?.length)
      ctx += `Complications: ${moData.complications.map((c) => `${c.name}: ${c.status} ${c.detail || ""}`).join(", ")}\n`;
    if (patientFullData?.lab_results?.length) {
      const recent = patientFullData.lab_results
        .slice(0, 15)
        .map((l) => `${l.test_name}: ${l.result} ${l.unit || ""} (${l.test_date || ""})`);
      ctx += `Lab History: ${recent.join(", ")}\n`;
    }
    if (conData?.investigations_ordered?.length)
      ctx += `Investigations Ordered: ${conData.investigations_ordered.map(ts).join(", ")}\n`;
    if (conData?.follow_up)
      ctx += `Follow-up: ${conData.follow_up.duration || ""} ${conData.follow_up.date || ""}\n`;
    if (conData?.diet_lifestyle?.length)
      ctx += `Lifestyle: ${conData.diet_lifestyle.map((l) => (typeof l === "string" ? l : l.advice)).join(", ")}\n`;
    if (conData?.goals?.length)
      ctx += `Goals: ${conData.goals.map((g) => `${g.marker}: ${g.current} \u2192 ${g.target}`).join(", ")}\n`;

    const reviewPrompt = `You are a clinical pharmacist and quality reviewer auditing a prescription at Gini Advanced Care Hospital.
Review the prescription below and return a JSON array of findings. Each finding is an object:
{"type":"warning"|"suggestion"|"good"|"missing","category":"Medication"|"Lab"|"Diagnosis"|"Monitoring"|"Guidelines","text":"concise finding","detail":"1-2 line explanation","priority":"high"|"medium"|"low"}

CHECK FOR:
1. MISSING MEDICATIONS \u2014 based on diagnoses, are any standard-of-care drugs missing? (e.g., DM2 patient without statin, HTN without ACEi/ARB, CKD without SGLT2i if eGFR allows)
2. DRUG INTERACTIONS \u2014 any known interactions between current meds?
3. MISSING LABS \u2014 based on diagnoses, any overdue screenings? (e.g., annual UACR for diabetes, annual lipids, periodic TFTs for thyroid patients, HbA1c every 3-6 months)
4. DOSE ISSUES \u2014 any dose adjustments needed based on labs? (e.g., Metformin dose vs eGFR, statin dose vs LDL target)
5. GUIDELINE COMPLIANCE \u2014 ADA 2024, ESC, KDIGO guidelines: is the prescription following current guidelines? Where is it deviating?
6. WHAT'S DONE WELL \u2014 acknowledge good practices (e.g., appropriate insulin titration, comprehensive lab panel ordered)
7. MONITORING GAPS \u2014 any vitals or home monitoring missing? (e.g., SMBG for insulin patients, home BP monitoring for HTN)
8. PERSONALIZATION \u2014 note any areas where the doctor has made personalized choices that differ from standard guidelines but may be clinically appropriate

Return ONLY valid JSON array. No markdown, no explanation outside the JSON.
Example: [{"type":"warning","category":"Medication","text":"No statin prescribed","detail":"ADA recommends statin therapy for all DM patients >40y with any ASCVD risk factor","priority":"high"}]`;

    try {
      const r = await api.post("/api/ai/complete", {
        messages: [{ role: "user", content: ctx }],
        system: reviewPrompt,
        model: "sonnet",
        maxTokens: 3000,
      });
      const text = r.data.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const flags = JSON.parse(clean);
      set({ rxReview: Array.isArray(flags) ? flags : [] });
    } catch (e) {
      set({
        rxReview: [
          {
            type: "warning",
            text: "Review failed: " + (e.response?.data?.error || e.message),
            detail: "",
            priority: "high",
          },
        ],
      });
    }
    set({ rxReviewLoading: false });
  },

  saveClinicalReasoning: async (
    dbPatientId,
    patientFullData,
    patient,
    conName,
    dgKey,
    whisperKey,
    transcribeDeepgram,
    transcribeWhisper,
  ) => {
    const { crText, crCondition, crTags, crAudioBlob } = get();
    const { currentDoctor } = useAuthStore.getState();
    const conId = patientFullData?.consultations?.[0]?.id;
    set({ crSaving: true });
    try {
      const body = {
        patient_id: dbPatientId || null,
        doctor_id: currentDoctor?.id || null,
        doctor_name: conName || currentDoctor?.name || "",
        reasoning_text: crText,
        primary_condition: crCondition,
        reasoning_tags: crTags,
        capture_method: crAudioBlob ? (crText ? "both" : "audio") : "text",
        patient_context: !dbPatientId
          ? `Patient: ${patient.name || "?"}, ${patient.age || "?"}Y/${patient.sex || "?"}, Phone: ${patient.phone || "?"}`
          : undefined,
      };

      // Use consultation-linked endpoint if available, otherwise standalone
      const url = conId ? `/api/consultations/${conId}/reasoning` : `/api/reasoning`;

      const resp = await api.post(url, body);
      const saved = resp.data;
      if (saved.error) {
        alert("Save failed: " + saved.error);
        set({ crSaving: false });
        return;
      }
      set({ crSaved: saved });

      // Upload audio if exists
      if (crAudioBlob && saved.id) {
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = reader.result.split(",")[1];
          await api.post(`/api/reasoning/${saved.id}/audio`, {
            base64,
            duration: Math.round(crAudioBlob.size / 3200),
          });
          // Save transcript to audio_transcript field too
          if (crText) {
            await api.put(`/api/reasoning/${saved.id}`, {
              audio_transcript: crText,
              transcription_status: "completed",
            });
          }
        };
        reader.readAsDataURL(crAudioBlob);
      }
    } catch (e) {
      alert("Save failed: " + (e.response?.data?.error || e.message));
    }
    set({ crSaving: false });
  },

  startCrRecording: async (dgKey, whisperKey, transcribeDeepgram, transcribeWhisper) => {
    // Store refs on the store instance for stopCrRecording to access
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt });
      const chunks = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: mt });
        set({ crAudioBlob: blob, crAudioUrl: URL.createObjectURL(blob) });
        stream.getTracks().forEach((t) => t.stop());
        // Auto-transcribe
        set({ crTranscribing: true });
        try {
          let transcript = "";
          if (dgKey) {
            transcript = await transcribeDeepgram(blob, dgKey, "en");
          } else if (whisperKey) {
            transcript = await transcribeWhisper(blob, whisperKey, "en");
          }
          if (transcript) {
            set((state) => ({
              crText: state.crText ? state.crText + "\n\n" + transcript : transcript,
            }));
          }
        } catch (e) {
          console.log("CR transcription failed:", e.message);
        }
        set({ crTranscribing: false });
      };
      // Store recorder reference for stop
      get()._crRecorder = rec;
      rec.start(250);
      set({ crRecording: true });
    } catch (e) {
      alert("Microphone access denied");
    }
  },

  stopCrRecording: () => {
    const rec = get()._crRecorder;
    if (rec?.state === "recording") rec.stop();
    set({ crRecording: false });
  },

  saveRxFeedback: async (dbPatientId, patientFullData, conData, moData, conName) => {
    const {
      rxFbAgreement,
      rxFbText,
      rxFbCorrect,
      rxFbReason,
      rxFbTags,
      rxFbSeverity,
      rxReview,
      crCondition,
    } = get();
    const { currentDoctor } = useAuthStore.getState();
    if (!dbPatientId || !rxFbAgreement) return;
    const conId = patientFullData?.consultations?.[0]?.id;
    if (!conId) return;
    set({ rxFbSaving: true });
    try {
      const body = {
        patient_id: dbPatientId,
        doctor_id: currentDoctor?.id || null,
        doctor_name: conName || currentDoctor?.name || "",
        ai_rx_analysis: JSON.stringify(rxReview),
        ai_model: "claude-sonnet-4.5",
        agreement_level: rxFbAgreement,
        feedback_text: rxFbText,
        correct_approach: rxFbCorrect,
        reason_for_difference: rxFbReason,
        disagreement_tags: rxFbTags,
        primary_condition: crCondition || sa(moData, "diagnoses")?.[0]?.label || "",
        medications_involved: sa(conData, "medications_confirmed")
          .map((m) => m.name)
          .filter(Boolean),
        severity: rxFbSeverity,
      };
      const resp = await api.post(`/api/consultations/${conId}/rx-feedback`, body);
      set({ rxFbSaved: resp.data });
    } catch (e) {
      alert("Save failed: " + (e.response?.data?.error || e.message));
    }
    set({ rxFbSaving: false });
  },
}));

export default useRxReviewStore;
