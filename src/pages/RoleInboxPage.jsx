import { useEffect, useRef, useState, useCallback } from "react";
import api from "../services/api.js";
import { genieSupabase, hasGenieRealtime } from "../lib/genieSupabase.js";
import "./MessagesPage.css";

// Role-scoped inbox for Lab / Reception teams. Messages from the MyHealth
// Genie app are written to patient_messages with sender_role set to the
// team the patient is writing to. This page shows only matching threads
// and lets the user reply with the same sender_role, so the other side's
// thread grouping stays clean.
export default function RoleInboxPage({ role, title, senderLabel, defaultSenderName }) {
  const [inbox, setInbox] = useState([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [activeThread, setActiveThread] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const activeThreadRef = useRef(null);
  activeThreadRef.current = activeThread;

  const fetchInbox = useCallback(async () => {
    setInboxLoading(true);
    try {
      const { data } = await api.get("/api/messages/from-genie", { params: { role } });
      setInbox(data.data || []);
    } catch (e) {
      console.warn("Failed to load inbox:", e.message);
    }
    setInboxLoading(false);
  }, [role]);

  const fetchThread = useCallback(
    async (patientId) => {
      setThreadLoading(true);
      try {
        const { data } = await api.get(`/api/patients/${patientId}/messages`);
        // Thread comes back with both directions; filter inbound to this role
        // or outbound from this role so we don't mix Lab replies into Reception.
        const relevant = (data || []).filter((m) => !m.sender_role || m.sender_role === role);
        setThreadMessages(relevant);
      } catch (e) {
        console.warn("Failed to load thread:", e.message);
      }
      setThreadLoading(false);
    },
    [role],
  );

  const markRead = useCallback(async (msgId) => {
    try {
      await api.put(`/api/messages/${msgId}/read`);
    } catch {
      // ignore
    }
  }, []);

  const sendReply = useCallback(async () => {
    const text = replyText.trim();
    const thread = activeThreadRef.current;
    if (!text || !thread) return;
    setSending(true);
    try {
      await api.post(`/api/patients/${thread.patient_id}/messages`, {
        message: text,
        sender_name: defaultSenderName,
        sender_role: role,
      });
      setReplyText("");
      fetchThread(thread.patient_id);
      fetchInbox();
    } catch (e) {
      console.warn("Failed to send:", e.message);
    }
    setSending(false);
  }, [replyText, role, defaultSenderName, fetchThread, fetchInbox]);

  // Initial load
  useEffect(() => {
    fetchInbox();
  }, [fetchInbox]);

  // Realtime (preferred) + polling fallback
  useEffect(() => {
    if (hasGenieRealtime && genieSupabase) {
      const channel = genieSupabase
        .channel(`role-inbox:${role}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "patient_messages",
            filter: `sender_role=eq.${role}`,
          },
          (payload) => {
            const row = payload.new;
            // If the open thread is this patient, append + refresh thread.
            const thread = activeThreadRef.current;
            if (thread && thread.patient_id === row.patient_id) {
              fetchThread(row.patient_id);
            }
            fetchInbox();
          },
        )
        .subscribe();
      return () => {
        genieSupabase.removeChannel(channel);
      };
    }
    // Polling fallback — 5s.
    const id = setInterval(() => {
      fetchInbox();
      const thread = activeThreadRef.current;
      if (thread) fetchThread(thread.patient_id);
    }, 5000);
    return () => clearInterval(id);
  }, [role, fetchInbox, fetchThread]);

  // Group inbox rows by patient_id (server already returns one per patient
  // in most cases, but be defensive).
  const grouped = inbox.reduce((acc, m) => {
    const key = m.patient_id;
    if (!acc[key]) {
      acc[key] = {
        patient_name: m.patient_name || m.sender_name || "Patient",
        file_no: m.file_no,
        patient_id: m.patient_id,
        messages: [],
      };
    }
    acc[key].messages.push(m);
    return acc;
  }, {});

  return (
    <div>
      <div className="messages__title">
        {title}
        {!hasGenieRealtime && (
          <span
            style={{
              marginLeft: 10,
              fontSize: 11,
              fontWeight: 500,
              color: "#92400e",
              background: "#fffbeb",
              border: "1px solid #fde68a",
              padding: "2px 8px",
              borderRadius: 10,
            }}
          >
            polling · set VITE_GENIE_SUPABASE_* for realtime
          </span>
        )}
      </div>

      {!activeThread ? (
        <div>
          <div className="messages__inbox-bar">
            <div className="messages__inbox-info">
              {inbox.length === 0
                ? "No messages yet"
                : `${inbox.filter((m) => !m.is_read).length} unread · ${Object.keys(grouped).length} patients`}
            </div>
            <button onClick={fetchInbox} className="messages__refresh-btn">
              ↻ Refresh
            </button>
          </div>

          {inboxLoading && inbox.length === 0 ? (
            <div style={{ padding: 20, color: "#6b7d90" }}>Loading…</div>
          ) : inbox.length === 0 ? (
            <div className="messages__empty">
              <div className="messages__empty-icon">📭</div>
              <div className="messages__empty-text">No {senderLabel} messages yet</div>
              <div className="messages__empty-hint">
                Patient messages to {senderLabel} will appear here in realtime.
              </div>
            </div>
          ) : null}

          {Object.entries(grouped).map(([pid, group]) => {
            const unread = group.messages.filter((m) => !m.is_read).length;
            const last = group.messages[0]; // inbox is already latest-first
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
                  cursor: "pointer",
                }}
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
                <div className="messages__thread-preview">{last.message}</div>
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
            {threadLoading && threadMessages.length === 0 ? (
              <div style={{ padding: 16, color: "#6b7d90" }}>Loading…</div>
            ) : threadMessages.length === 0 ? (
              <div className="messages__thread-empty">No messages in this thread</div>
            ) : null}
            {threadMessages.map((m, i) => {
              const isTeam = m.direction === "inbound";
              return (
                <div
                  key={m.id || i}
                  className={`messages__msg-row ${isTeam ? "messages__msg-row--doctor" : "messages__msg-row--patient"}`}
                >
                  <div
                    className={`messages__msg-bubble ${isTeam ? "messages__msg-bubble--doctor" : "messages__msg-bubble--patient"}`}
                  >
                    <div className="messages__msg-text">{m.message}</div>
                    <div className="messages__msg-meta">
                      {m.sender_name || (isTeam ? senderLabel : "Patient")} ·{" "}
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
              placeholder={`Reply as ${senderLabel}... (Enter to send)`}
              className="messages__reply-textarea"
            />
            <div className="messages__reply-actions">
              <button onClick={() => setReplyText("")} className="messages__clear-btn">
                Clear
              </button>
              <button
                onClick={sendReply}
                disabled={!replyText.trim() || sending}
                className={`messages__send-btn ${replyText.trim() ? "messages__send-btn--active" : "messages__send-btn--disabled"}`}
              >
                {sending ? "Sending..." : "Send Reply ✉️"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
