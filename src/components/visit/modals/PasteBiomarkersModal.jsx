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

      // Filter to numeric lab values only
      const labs = (data?.labs || []).filter(
        (l) => l.value !== null && l.value !== undefined && !isNaN(parseFloat(l.value)),
      );

      if (!labs.length) {
        setError(
          "No numeric lab values found. Make sure you pasted text that contains lab results.",
        );
        setLoading(false);
        return;
      }

      // Always use the user's explicitly selected date — AI-extracted dates are unreliable
      const detectedDate = date;

      const extracted = {
        panels: [
          {
            panel_name: "Pasted from HealthRay",
            tests: labs.map((l) => ({
              test_name: l.test,
              result: parseFloat(l.value),
              result_text: String(l.value),
              unit: l.unit || "",
              flag: null,
              ref_range: null,
            })),
          },
        ],
      };

      onExtracted({ extracted, doc_date: detectedDate });
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
          below. AI will extract all biomarker values.
        </div>

        <div className="mf">
          <label className="ml">Report / Visit Date</label>
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
