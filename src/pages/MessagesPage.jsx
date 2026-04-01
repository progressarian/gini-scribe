import { useEffect, useState } from "react";
import usePatientStore from "../stores/patientStore.js";
import useMessagingStore from "../stores/messagingStore.js";
import useAlertStore from "../stores/alertStore.js";
import Shimmer from "../components/Shimmer.jsx";
import "./MessagesPage.css";

export default function MessagesPage() {
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [alertTitle, setAlertTitle] = useState("");
  const [alertMessage, setAlertMessage] = useState("");
  const [alertType, setAlertType] = useState("doctor_note");
  const { sendAlert, sendingAlert } = useAlertStore();
  const { patient, dbPatientId } = usePatientStore();
  const {
    inbox,
    inboxLoading,
    activeThread,
    setActiveThread,
    threadMessages,
    threadLoading,
    setThreadMessages,
    replyText,
    setReplyText,
    sendingReply,
    fetchInbox,
    fetchThread,
    sendReply,
    markRead,
  } = useMessagingStore();

  useEffect(() => {
    fetchInbox();
  }, [fetchInbox]);

  return (
    <div>
      <div className="messages__title">{"\ud83d\udcac"} Patient Messages</div>

      {/* Send Alert to current patient */}
      {dbPatientId && patient?.name && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "10px 14px",
            background: "#fffbeb",
            border: "1.5px solid #fde68a",
            borderRadius: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: showAlertForm ? 8 : 0,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>
              {"\ud83d\udce2"} Send Alert to {patient.name}
            </div>
            <button
              onClick={() => setShowAlertForm((v) => !v)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                background: showAlertForm ? "#92400e" : "#d97706",
                color: "white",
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              {showAlertForm ? "Cancel" : "New Alert"}
            </button>
          </div>
          {showAlertForm && (
            <div>
              <select
                value={alertType}
                onChange={(e) => setAlertType(e.target.value)}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  marginBottom: 6,
                  borderRadius: 6,
                  border: "1px solid #fde68a",
                  fontSize: 13,
                }}
              >
                <option value="doctor_note">Doctor Note</option>
                <option value="reminder">Reminder</option>
                <option value="lab_ready">Lab Results Ready</option>
                <option value="prescription_ready">Prescription Ready</option>
                <option value="follow_up">Follow-up Reminder</option>
              </select>
              <input
                value={alertTitle}
                onChange={(e) => setAlertTitle(e.target.value)}
                placeholder="Alert title..."
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  marginBottom: 6,
                  borderRadius: 6,
                  border: "1px solid #fde68a",
                  fontSize: 13,
                  boxSizing: "border-box",
                }}
              />
              <textarea
                value={alertMessage}
                onChange={(e) => setAlertMessage(e.target.value)}
                placeholder="Alert message..."
                rows={2}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  marginBottom: 8,
                  borderRadius: 6,
                  border: "1px solid #fde68a",
                  fontSize: 13,
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
              <button
                disabled={!alertTitle.trim() || !alertMessage.trim() || sendingAlert}
                onClick={async () => {
                  const result = await sendAlert(dbPatientId, alertTitle, alertMessage, alertType);
                  if (result?.success) {
                    setAlertTitle("");
                    setAlertMessage("");
                    setShowAlertForm(false);
                  }
                }}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  background: alertTitle.trim() && alertMessage.trim() ? "#d97706" : "#e5e7eb",
                  color: alertTitle.trim() && alertMessage.trim() ? "white" : "#9ca3af",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {sendingAlert ? "Sending..." : "Send Alert \ud83d\udce2"}
              </button>
            </div>
          )}
        </div>
      )}

      {!activeThread ? (
        <div>
          <div className="messages__inbox-bar">
            <div className="messages__inbox-info">
              {inbox.length === 0
                ? "No messages yet"
                : `${inbox.filter((m) => !m.is_read && m.direction === "outbound").length} unread · ${inbox.length} total`}
            </div>
            <button onClick={fetchInbox} className="messages__refresh-btn">
              ↻ Refresh
            </button>
          </div>

          {inboxLoading ? (
            <div style={{ padding: 10 }}>
              <Shimmer type="cards" count={4} />
            </div>
          ) : inbox.length === 0 ? (
            <div className="messages__empty">
              <div className="messages__empty-icon">📭</div>
              <div className="messages__empty-text">No patient messages yet</div>
              <div className="messages__empty-hint">
                Messages sent from the MyHealth Genie app will appear here
              </div>
            </div>
          ) : null}

          {!inboxLoading &&
            Object.entries(
              inbox.reduce((acc, m) => {
                const key = m.patient_id;
                if (!acc[key])
                  acc[key] = {
                    patient_name: m.patient_name,
                    file_no: m.file_no,
                    patient_id: m.patient_id,
                    messages: [],
                  };
                acc[key].messages.push(m);
                return acc;
              }, {}),
            ).map(([pid, group]) => {
              const unread = group.messages.filter(
                (m) => !m.is_read && m.direction === "outbound",
              ).length;
              const last = group.messages[group.messages.length - 1];
              return (
                <div
                  key={pid}
                  onClick={() => {
                    setActiveThread(group);
                    fetchThread(pid);
                    group.messages.filter((m) => !m.is_read).forEach((m) => markRead(m.id));
                  }}
                  className="messages__thread-card"
                  style={{
                    border: `1px solid ${unread > 0 ? "#fde68a" : "#f1f5f9"}`,
                    borderLeft: `4px solid ${unread > 0 ? "#f59e0b" : "#e2e8f0"}`,
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,.08)")
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
                >
                  <div className="messages__thread-header">
                    <div className="messages__thread-info">
                      <div className="messages__thread-avatar">
                        {(group.patient_name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="messages__thread-name">{group.patient_name}</div>
                        {group.file_no && (
                          <div className="messages__thread-file">File: {group.file_no}</div>
                        )}
                      </div>
                    </div>
                    <div className="messages__thread-meta">
                      {unread > 0 && <div className="messages__thread-badge">{unread} new</div>}
                      <div className="messages__thread-date">
                        {new Date(last.created_at).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="messages__thread-preview">
                    {last.direction === "inbound" ? "You: " : ""}
                    {last.message}
                  </div>
                </div>
              );
            })}
        </div>
      ) : (
        <div>
          <button
            onClick={() => {
              setActiveThread(null);
              setThreadMessages([]);
              setReplyText("");
              fetchInbox();
            }}
            className="messages__back-btn"
          >
            ← Back to Inbox
          </button>

          <div className="messages__patient-header">
            <div className="messages__patient-avatar">
              {(activeThread.patient_name || "?").charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="messages__patient-name">{activeThread.patient_name}</div>
              {activeThread.file_no && (
                <div className="messages__patient-file">File: {activeThread.file_no}</div>
              )}
            </div>
          </div>

          <div className="messages__thread-scroll">
            {threadLoading ? (
              <div style={{ padding: 16 }}>
                <Shimmer type="lines" count={6} />
              </div>
            ) : threadMessages.length === 0 ? (
              <div className="messages__thread-empty">No messages in this thread</div>
            ) : null}
            {!threadLoading &&
              threadMessages.map((m, i) => {
                const isDoctor = m.direction === "inbound";
                return (
                  <div
                    key={i}
                    className={`messages__msg-row ${isDoctor ? "messages__msg-row--doctor" : "messages__msg-row--patient"}`}
                  >
                    <div
                      className={`messages__msg-bubble ${isDoctor ? "messages__msg-bubble--doctor" : "messages__msg-bubble--patient"}`}
                    >
                      <div className="messages__msg-text">{m.message}</div>
                      <div className="messages__msg-meta">
                        {m.sender_name || (isDoctor ? "Dr. Bhansali" : "Patient")} ·{" "}
                        {new Date(m.created_at).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="messages__reply-box">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              placeholder="Type a reply... (Enter to send)"
              className="messages__reply-textarea"
            />
            <div className="messages__reply-actions">
              <button onClick={() => setReplyText("")} className="messages__clear-btn">
                Clear
              </button>
              <button
                onClick={sendReply}
                disabled={!replyText.trim() || sendingReply}
                className={`messages__send-btn ${replyText.trim() ? "messages__send-btn--active" : "messages__send-btn--disabled"}`}
              >
                {sendingReply ? "Sending..." : "Send Reply \u2709\ufe0f"}
              </button>
              <button
                onClick={() => setShowAlertForm((v) => !v)}
                className="messages__send-btn messages__send-btn--active"
                style={{ background: showAlertForm ? "#92400e" : "#d97706" }}
              >
                {showAlertForm ? "Cancel Alert" : "\ud83d\udce2 Send Alert"}
              </button>
            </div>

            {showAlertForm && (
              <div
                style={{
                  marginTop: 10,
                  padding: 12,
                  background: "#fffbeb",
                  border: "1.5px solid #fde68a",
                  borderRadius: 8,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13, color: "#92400e", marginBottom: 8 }}>
                  Send Alert to Patient's App
                </div>
                <select
                  value={alertType}
                  onChange={(e) => setAlertType(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    marginBottom: 6,
                    borderRadius: 6,
                    border: "1px solid #fde68a",
                    fontSize: 13,
                  }}
                >
                  <option value="doctor_note">Doctor Note</option>
                  <option value="reminder">Reminder</option>
                  <option value="lab_ready">Lab Results Ready</option>
                  <option value="prescription_ready">Prescription Ready</option>
                  <option value="follow_up">Follow-up Reminder</option>
                </select>
                <input
                  value={alertTitle}
                  onChange={(e) => setAlertTitle(e.target.value)}
                  placeholder="Alert title..."
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    marginBottom: 6,
                    borderRadius: 6,
                    border: "1px solid #fde68a",
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
                <textarea
                  value={alertMessage}
                  onChange={(e) => setAlertMessage(e.target.value)}
                  placeholder="Alert message..."
                  rows={2}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    marginBottom: 8,
                    borderRadius: 6,
                    border: "1px solid #fde68a",
                    fontSize: 13,
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  disabled={!alertTitle.trim() || !alertMessage.trim() || sendingAlert}
                  onClick={async () => {
                    const pid = activeThread?.patient_id || dbPatientId;
                    if (!pid) return;
                    const result = await sendAlert(pid, alertTitle, alertMessage, alertType);
                    if (result?.success) {
                      setAlertTitle("");
                      setAlertMessage("");
                      setShowAlertForm(false);
                    }
                  }}
                  style={{
                    padding: "6px 16px",
                    borderRadius: 6,
                    border: "none",
                    cursor: "pointer",
                    background: alertTitle.trim() && alertMessage.trim() ? "#d97706" : "#e5e7eb",
                    color: alertTitle.trim() && alertMessage.trim() ? "white" : "#9ca3af",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {sendingAlert ? "Sending..." : "Send Alert \ud83d\udce2"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
