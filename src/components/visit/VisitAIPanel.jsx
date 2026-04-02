import { memo, useState, useRef, useEffect } from "react";
import api from "../../services/api";

const VisitAIPanel = memo(function VisitAIPanel({ open, onClose, patientContext, initialMessage }) {
  const [messages, setMessages] = useState(() =>
    initialMessage ? [{ role: "ai", text: initialMessage }] : [],
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = async (prompt) => {
    const text = prompt || input.trim();
    if (!text || sending) return;
    setMessages((m) => [...m, { role: "usr", text }]);
    setInput("");
    setSending(true);
    try {
      const { data: resp } = await api.post("/api/ai/complete", {
        messages: [
          {
            role: "user",
            content: `You are a clinical assistant. ${patientContext}\n\nQuestion: ${text}`,
          },
        ],
        model: "haiku",
        maxTokens: 2000,
      });
      setMessages((m) => [
        ...m,
        { role: "ai", text: resp.text || "Could you clarify what you'd like to know?" },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "ai", text: "Sorry, I couldn't process that. Please try again." },
      ]);
    }
    setSending(false);
  };

  return (
    <div className={`aip ${open ? "open" : ""}`}>
      <div className="aip-hd">
        <div className="aip-ttl">✦ Gini AI — Assistant</div>
        <button
          className="btn"
          onClick={onClose}
          style={{ height: 26, padding: "0 9px", fontSize: 11 }}
        >
          ✕ Close
        </button>
      </div>
      <div className="aim" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`aim-msg ${m.role}`} style={{ whiteSpace: "pre-wrap" }}>
            {m.text}
          </div>
        ))}
      </div>
      <div className="aisugg">
        {["Drug interactions?", "Treatment recommendations", "Lab interpretation"].map((s) => (
          <div key={s} className="aichip" onClick={() => send(s)}>
            {s}
          </div>
        ))}
      </div>
      <div className="ai-ir">
        <input
          className="ai-in"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything about this patient..."
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={sending}
        />
        <button className="ai-snd" onClick={() => send()} disabled={sending}>
          →
        </button>
      </div>
    </div>
  );
});

export default VisitAIPanel;
