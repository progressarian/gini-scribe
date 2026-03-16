import { useEffect } from "react";
import usePatientStore from "../stores/patientStore.js";
import useMessagingStore from "../stores/messagingStore.js";
import Shimmer from "../components/Shimmer.jsx";
import "./MessagesPage.css";

export default function MessagesPage() {
  const { patient } = usePatientStore();
  const {
    inbox,
    inboxLoading,
    inboxPage,
    inboxTotalPages,
    inboxLoadingMore,
    activeThread,
    setActiveThread,
    threadMessages,
    threadLoading,
    setThreadMessages,
    replyText,
    setReplyText,
    sendingReply,
    fetchInbox,
    loadMoreInbox,
    fetchThread,
    sendReply,
    markRead,
  } = useMessagingStore();

  useEffect(() => {
    fetchInbox();
  }, [fetchInbox]);

  return (
    <div>
      <div className="messages__title">💬 Patient Messages</div>

      {!activeThread ? (
        <div>
          <div className="messages__inbox-bar">
            <div className="messages__inbox-info">
              {inbox.length === 0
                ? "No messages yet"
                : `${inbox.filter((m) => !m.is_read && m.direction === "patient_to_doctor").length} unread · ${inbox.length} total`}
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
                (m) => !m.is_read && m.direction === "patient_to_doctor",
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
                    {last.direction === "doctor_to_patient" ? "You: " : ""}
                    {last.message}
                  </div>
                </div>
              );
            })}

          {!inboxLoading && inboxPage < inboxTotalPages && (
            <div style={{ textAlign: "center", padding: 12 }}>
              <button
                onClick={loadMoreInbox}
                disabled={inboxLoadingMore}
                className="messages__refresh-btn"
                style={{ width: "100%" }}
              >
                {inboxLoadingMore
                  ? "Loading..."
                  : `Load More (Page ${inboxPage}/${inboxTotalPages})`}
              </button>
            </div>
          )}
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
                const isDoctor = m.direction === "doctor_to_patient";
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
                {sendingReply ? "Sending..." : "Send Reply ✉️"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
