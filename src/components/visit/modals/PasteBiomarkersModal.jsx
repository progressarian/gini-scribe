import { useEffect, useRef, useState } from "react";
import api from "../../../services/api";
import CustomCalendar from "../../ui/CustomCalendar";

function fmtDisplay(dateStr) {
  if (!dateStr) return "Select date";
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function PasteBiomarkersModal({ patientId, onClose, onExtracted }) {
  const today = new Date().toISOString().split("T")[0];
  const [text, setText] = useState("");
  const [date, setDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [calOpen, setCalOpen] = useState(false);
  const calWrapRef = useRef(null);

  useEffect(() => {
    if (!calOpen) return;
    const onDown = (e) => {
      if (calWrapRef.current && !calWrapRef.current.contains(e.target)) setCalOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setCalOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [calOpen]);

  const handleExtract = async () => {
    if (!text.trim() || text.trim().length < 20) {
      setError("Please paste some clinical text first");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post(`/api/visit/${patientId}/parse-text`, { text });

      const hasAnything =
        (data?.symptoms?.length || 0) +
          (data?.diagnoses?.length || 0) +
          (data?.medications?.length || 0) +
          (data?.previous_medications?.length || 0) +
          (data?.labs?.length || 0) +
          (data?.vitals?.length || 0) +
          (data?.investigations_to_order?.length || 0) >
        0;

      if (!hasAnything) {
        setError(
          "Nothing recognisable found. Make sure you pasted clinical notes, prescription text, or lab results.",
        );
        setLoading(false);
        return;
      }

      onExtracted({ extracted: data, doc_date: date, raw_text: text });
    } catch (e) {
      setError("Extraction failed: " + (e.response?.data?.error || e.message));
      setLoading(false);
    }
  };

  return (
    <div
      className="mo open"
      onClick={(e) => {
        // Block backdrop-close while extraction is in flight so the popup
        // can't disappear mid-request.
        if (loading) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mbox" style={{ width: 560, maxWidth: "95vw" }}>
        <div className="mttl">📋 Paste Clinical Notes</div>
        <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 14 }}>
          Paste the full clinical note, prescription text, or consultation summary below. Symptoms,
          diagnoses, medicines, previous meds, labs, vitals, and tests ordered will be extracted —
          then you confirm what to apply.
        </div>

        <div className="mf">
          <label className="ml">Fallback Date (used only if a date can't be detected)</label>
          <div ref={calWrapRef} style={{ position: "relative", width: 260, maxWidth: "100%" }}>
            <button
              type="button"
              className="mi"
              onClick={() => !loading && setCalOpen((o) => !o)}
              disabled={loading}
              style={{
                textAlign: "left",
                cursor: loading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                background: "#fff",
              }}
            >
              <span style={{ fontSize: 14 }}>📅</span>
              <span style={{ flex: 1 }}>{fmtDisplay(date)}</span>
              <span style={{ fontSize: 10, color: "var(--t3)" }}>▾</span>
            </button>
            {calOpen && (
              <CustomCalendar
                value={date}
                onSelect={(v) => setDate(v)}
                onClose={() => setCalOpen(false)}
                fullWidth
              />
            )}
          </div>
        </div>

        <div className="mf">
          <label className="ml">Paste Clinical Text</label>
          <textarea
            className="mi"
            style={{ minHeight: 220, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
            placeholder="Paste HealthRay clinical notes, diagnosis text, prescription, or lab values here…"
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
            {loading ? "Extracting…" : "Extract All"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PasteBiomarkersModal;
