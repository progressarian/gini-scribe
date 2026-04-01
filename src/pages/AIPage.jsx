import { useRef } from "react";
import usePatientStore from "../stores/patientStore.js";
import useChatStore from "../stores/chatStore.js";
import "./AIPage.css";

export default function AIPage() {
  const aiChatRef = useRef(null);
  const { patient } = usePatientStore();
  const { aiMessages, setAiMessages, aiInput, setAiInput, aiLoading, sendAiMessage } =
    useChatStore();

  return (
    <div className="ai-page">
      <div className="ai-page__header">
        <div className="ai-page__title">🤖 Gini AI — Clinical Assistant</div>
        <div className="ai-page__spacer" />
        {patient.name && <span className="ai-page__context">Context: {patient.name}</span>}
        <button onClick={() => setAiMessages([])} className="ai-page__clear-btn">
          Clear Chat
        </button>
      </div>

      <div className="ai-page__input-area">
        <label className="ai-page__input-label">
          Ask about patient, medications, guidelines, protocols...
        </label>
        <div className="ai-page__input-row">
          <input
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            placeholder="e.g., Drug interactions check, ADA guidelines for this HbA1c..."
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendAiMessage(patient)}
            className="ai-page__input"
            onFocus={(e) => (e.target.style.borderColor = "#7c3aed")}
            onBlur={(e) => (e.target.style.borderColor = "#e9d5ff")}
          />
          <button
            onClick={() => sendAiMessage(patient)}
            disabled={aiLoading || !aiInput.trim()}
            className={`ai-page__send-btn ${aiLoading ? "ai-page__send-btn--loading" : "ai-page__send-btn--active"}`}
          >
            {aiLoading ? "⏳" : "Send →"}
          </button>
        </div>
        <div className="ai-page__suggestions">
          {[
            "Drug interactions",
            "ADA guidelines",
            "Suggest investigations",
            "Diabetic foot protocol",
            "Explain lab trends",
            "Referral letter",
          ].map((q) => (
            <button key={q} onClick={() => setAiInput(q)} className="ai-page__suggestion-btn">
              {q}
            </button>
          ))}
        </div>
      </div>

      <div ref={aiChatRef} className="ai-page__messages">
        {aiMessages.length === 0 && (
          <div className="ai-page__empty">
            <div className="ai-page__empty-icon">🤖</div>
            <div className="ai-page__empty-text">Ask anything about this patient</div>
            <div className="ai-page__empty-hint">
              Uses full patient context — diagnoses, meds, labs, vitals
            </div>
          </div>
        )}
        {aiMessages.map((msg, i) => (
          <div
            key={i}
            className={`ai-page__msg-row ${msg.role === "user" ? "ai-page__msg-row--user" : "ai-page__msg-row--assistant"}`}
          >
            <div
              className={`ai-page__msg ${msg.role === "user" ? "ai-page__msg--user" : "ai-page__msg--assistant"}`}
            >
              {msg.role === "assistant" && <div className="ai-page__msg-label">🤖 GINI AI</div>}
              {msg.content}
            </div>
          </div>
        ))}
        {aiLoading && (
          <div className="ai-page__msg-row ai-page__msg-row--assistant">
            <div className="ai-page__thinking">
              <div className="ai-page__thinking-text">⏳ Thinking...</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
