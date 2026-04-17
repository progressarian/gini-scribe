import api from "./api.js";

const CLASSIFY_PROMPT = `You are a medical document classifier. Look at this image and identify what type of medical document it is.

Return ONLY valid JSON (no backticks, no markdown):
{"doc_type":"prescription|lab_report|imaging|discharge|other","subtype":"blood_test|thyroid|lipid|kidney|hba1c|urine|xray|usg|mri|dexa|ecg|ncs|eye|null","confidence":0.0-1.0,"rationale":"one short sentence"}

HEURISTICS:
- prescription: doctor's name/stamp, Rx symbol, drug names with doses/frequencies (OD/BD/TID/HS), follow-up instructions, signature area
- lab_report: tabular test results with reference ranges, panel names (CBC, LFT, KFT, Lipid, Thyroid), lab logo, "H"/"L" flags
- imaging: X-Ray/MRI/CT/USG/DEXA/ECG/NCS films or interpretation text, radiology/pathology header
- discharge: "Discharge Summary" title, admission/discharge dates, hospital course, investigations
- other: vaccination cards, referrals, health records not fitting above

SUBTYPE RULES (only when doc_type is lab_report or imaging):
- lab_report → pick most specific panel name visible:
  - blood_test: CBC, Hemogram, Complete Blood Count
  - thyroid: TSH, T3, T4, FT3, FT4
  - lipid: Cholesterol, HDL, LDL, Triglycerides, Lipid Profile
  - kidney: Creatinine, Urea, BUN, eGFR, KFT
  - hba1c: HbA1c, Glycated Hemoglobin
  - urine: Urine Routine, Urine R/M, UACR
  - If multiple panels, pick the dominant one; if generic/mixed → blood_test
- imaging → pick modality:
  - xray: Chest X-Ray, Bone films
  - usg: Ultrasound, USG
  - mri: MRI, CT scan
  - dexa: DEXA, Bone density
  - ecg: ECG, EKG, Echocardiogram
  - ncs: Nerve Conduction Study, EMG
  - eye: Fundus, Retinal, OCT

CONFIDENCE:
- 0.9-1.0: clear, unambiguous document type
- 0.6-0.9: reasonably confident
- <0.6: uncertain (still return best guess)

For discharge/other or when subtype doesn't apply, set subtype to null.`;

export async function classifyDocument(base64, mediaType) {
  try {
    const block =
      mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const { data } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: [block, { type: "text", text: CLASSIFY_PROMPT }] }],
      model: "haiku",
      maxTokens: 400,
    });

    if (data.error) return { data: null, error: data.error };

    const text = (data.text || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);

    if (!parsed.doc_type) {
      return { data: null, error: "Classification missing doc_type" };
    }

    return {
      data: {
        doc_type: parsed.doc_type,
        subtype: parsed.subtype === "null" ? null : parsed.subtype,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        rationale: parsed.rationale || "",
      },
      error: null,
    };
  } catch (e) {
    return {
      data: null,
      error: e.response?.data?.error || e.message || "Classification failed",
    };
  }
}
