import { useState } from "react";
import api from "../../../services/api";

function PasteBiomarkersModal({ patientId, onClose, onExtracted }) {
  const today = new Date().toISOString().split("T")[0];
  const [text, setText] = useState("");
  const [date, setDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleExtract = async () => {
    if (!text.trim() || text.trim().length < 20) {
      setError("Please paste some clinical text first");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post(`/api/visit/${patientId}/parse-text`, { text });

      // Keep only labs with a finite numeric value; preserve AI-extracted date
      // per lab (fallback to the modal's date only when the AI didn't resolve one).
      const labs = (data?.labs || [])
        .map((l) => ({
          test: l.test,
          value: l.value,
          unit: l.unit || "",
          date: l.date || date,
        }))
        .filter((l) => l.test && Number.isFinite(parseFloat(l.value)));

      // Keep dated vitals rows. The parser returns { date, height, weight, bmi,
      // bpSys, bpDia, waist, bodyFat } per dated follow-up section.
      const vitals = (data?.vitals || [])
        .map((v) => ({
          date: v.date || date,
          bpSys: v.bpSys ?? null,
          bpDia: v.bpDia ?? null,
          weight: v.weight ?? null,
          height: v.height ?? null,
          bmi: v.bmi ?? null,
          waist: v.waist ?? null,
          bodyFat: v.bodyFat ?? null,
        }))
        .filter(
          (v) =>
            v.bpSys != null ||
            v.bpDia != null ||
            v.weight != null ||
            v.height != null ||
            v.bmi != null ||
            v.waist != null ||
            v.bodyFat != null,
        );

      if (!labs.length && !vitals.length) {
        setError(
          "No numeric lab values or vitals found. Make sure you pasted text that contains lab results or dated follow-up vitals.",
        );
        setLoading(false);
        return;
      }

      const extracted = {
        panels: [
          {
            panel_name: "Pasted from HealthRay",
            tests: labs.map((l) => ({
              test_name: l.test,
              result: parseFloat(l.value),
              result_text: String(l.value),
              unit: l.unit,
              flag: null,
              ref_range: null,
              test_date: l.date,
            })),
          },
        ],
        vitals,
      };

      // Hand off to the review modal — it renders the per-row dates and the
      // vitals section so the clinician can confirm before we write.
      onExtracted({ extracted, doc_date: date });
    } catch (e) {
      setError("Extraction failed: " + (e.response?.data?.error || e.message));
      setLoading(false);
    }
  };

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 560, maxWidth: "95vw" }}>
        <div className="mttl">📋 Paste from HealthRay</div>
        <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 14 }}>
          Go to HealthRay → open the patient → copy the Diagnoses / clinical notes text and paste
          below. AI will extract all biomarker values and dated vitals, preserving the original
          follow-up dates.
        </div>

        <div className="mf">
          <label className="ml">Fallback Date (used only if AI can't detect a date)</label>
          <input
            type="date"
            className="mi"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="mf">
          <label className="ml">Paste Clinical Text</label>
          <textarea
            className="mi"
            style={{ minHeight: 220, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
            placeholder="Paste HealthRay clinical notes, diagnosis text, or lab values here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
          />
        </div>

        {error && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div className="macts">
          <button className="btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="btn-p" onClick={handleExtract} disabled={loading || !text.trim()}>
            {loading ? "Extracting…" : "Extract Biomarkers"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PasteBiomarkersModal;
