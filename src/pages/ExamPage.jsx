import { useNavigate } from "react-router-dom";
import useExamStore from "../stores/examStore.js";
import { EXAM_SECTIONS } from "../config/exam.js";
import "./ExamPage.css";

export default function ExamPage() {
  const navigate = useNavigate();
  const {
    examSpecialty,
    setExamSpecialty,
    examData,
    examOpen,
    setExamOpen,
    examNotes,
    setExamNotes,
    toggleExamFinding,
    toggleExamNAD,
    markAllNAD,
  } = useExamStore();

  return (
    <div>
      <div className="exam__header">
        <span className="exam__header-icon">🔍</span>
        <div className="exam__header-info">
          <div className="exam__header-title">Physical Examination</div>
          <div className="exam__header-sub">Tap findings · NAD = Normal</div>
        </div>
        <span className="exam__header-step">Step 3/6</span>
      </div>

      <div className="exam__specialty-bar">
        {Object.keys(EXAM_SECTIONS).map((sp) => (
          <button
            key={sp}
            onClick={() => setExamSpecialty(sp)}
            className={`exam__specialty-btn ${examSpecialty === sp ? "exam__specialty-btn--active" : "exam__specialty-btn--inactive"}`}
          >
            {sp}
          </button>
        ))}
        <div className="exam__spacer" />
        <button onClick={markAllNAD} className="exam__all-nad-btn">
          ✓ All NAD
        </button>
      </div>

      {(EXAM_SECTIONS[examSpecialty] || []).map((sec) => {
        const isOpen = examOpen === sec.id;
        const vals = examData[sec.id + "_v"] || [];
        const isNAD = examData[sec.id + "_n"];
        const hasFinding = vals.length > 0;
        return (
          <div
            key={sec.id}
            className="exam__section"
            style={{
              border: `1.5px solid ${hasFinding ? "#f59e0b" : isNAD ? "#bbf7d0" : "#e2e8f0"}`,
            }}
          >
            <div
              onClick={() => setExamOpen(isOpen ? null : sec.id)}
              className={`exam__section-header ${hasFinding ? "exam__section-header--finding" : ""}`}
            >
              <span className="exam__section-icon">{sec.ic}</span>
              <span className="exam__section-name">{sec.l}</span>
              {isNAD && !hasFinding && <span className="exam__nad-badge">NAD</span>}
              {hasFinding && (
                <span className="exam__finding-badge">
                  {vals.length} finding{vals.length > 1 ? "s" : ""}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExamNAD(sec.id);
                }}
                className={`exam__nad-btn ${isNAD ? "exam__nad-btn--active" : "exam__nad-btn--inactive"}`}
              >
                NAD
              </button>
              <span className="exam__section-arrow">{isOpen ? "▲" : "▼"}</span>
            </div>
            {isOpen && (
              <div className="exam__findings">
                <div className="exam__findings-list">
                  {sec.o.map((o) => (
                    <button
                      key={o}
                      onClick={() => toggleExamFinding(sec.id, o)}
                      className={`exam__finding-btn ${vals.includes(o) ? "exam__finding-btn--active" : "exam__finding-btn--inactive"}`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="exam__notes">
        <textarea
          value={examNotes}
          onChange={(e) => setExamNotes(e.target.value)}
          placeholder="Additional exam notes..."
          rows={2}
          className="exam__notes-textarea"
        />
      </div>

      <div className="exam__nav">
        <button onClick={() => navigate("/history-clinical")} className="exam__back-btn">
          ← History
        </button>
        <button onClick={() => navigate("/assess")} className="exam__next-btn">
          Assess →
        </button>
      </div>
    </div>
  );
}
