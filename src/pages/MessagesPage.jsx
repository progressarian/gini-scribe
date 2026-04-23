import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import useAuthStore from "../stores/authStore.js";
import { genieSupabase, hasGenieRealtime } from "../lib/genieSupabase.js";
import { useConversations } from "../queries/hooks/useConversations";
import { useThreadMessages, flattenThread } from "../queries/hooks/useThreadMessages";
import { useSendReply } from "../queries/hooks/useSendReply";
import { qk } from "../queries/keys";
import "./MessagesPage.css";

// Doctor inbox. Lists only conversations where the current logged-in doctor
// is the participant. Each row is a distinct (patient, this-doctor) thread
// with a stable conversation_id. Clicking opens the thread; sending a reply
// writes into that same conversation so the patient receives it under the
// matching Doctor tab on their end.
export default function MessagesPage() {
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const senderName = currentDoctor?.name || currentDoctor?.short_name || "Doctor";
  const queryClient = useQueryClient();

  const convQuery = useConversations("doctor");
  const conversations = convQuery.data || [];

  const [activeId, setActiveId] = useState(null);
  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId],
  );
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const [search, setSearch] = useState("");
  const [replyText, setReplyText] = useState("");
  const [sendError, setSendError] = useState(null);

  const threadQuery = useThreadMessages(activeId, { enabled: !!activeId });
  const threadMessages = flattenThread(threadQuery.data?.pages);
  const threadLoading = threadQuery.isLoading;
  const fetchingOlder = threadQuery.isFetchingNextPage;
  const hasMoreOlder = threadQuery.hasNextPage;

  const sendReplyMutation = useSendReply({ conversationId: activeId, senderName });
  const sendingReply = sendReplyMutation.isPending;

  const scrollContainerRef = useRef(null);
  const prevScrollHeightRef = useRef(0);
  const lastTailIdRef = useRef(null);

  // Mark thread read when opened and whenever the latest message arrives.
  // The server flips is_read on all outbound rows in one round-trip and
  // resets conversations.team_unread_count.
  useEffect(() => {
    if (!activeId) return;
    api.post(`/api/conversations/${activeId}/read`).catch(() => {
      // Non-fatal: unread state will still self-heal on next inbox refresh.
    });
    queryClient.invalidateQueries({ queryKey: qk.messages.conversations("doctor") });
  }, [activeId, threadMessages.length, queryClient]);

  // Realtime: any INSERT on patient_messages or UPDATE on conversations
  // triggers a targeted refetch. We subscribe once at the page level (not
  // per-thread) so the inbox list also updates when a new message arrives
  // while a different thread is open.
  useEffect(() => {
    const refetchInbox = () => {
      queryClient.invalidateQueries({ queryKey: qk.messages.conversations("doctor") });
    };
    const refetchActive = () => {
      const id = activeIdRef.current;
      if (id) queryClient.invalidateQueries({ queryKey: qk.messages.conversationMessages(id) });
    };

    if (hasGenieRealtime && genieSupabase) {
      const channel = genieSupabase
        .channel("scribe-doctor-inbox")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "patient_messages" },
          (payload) => {
            const row = payload.new;
            if (row?.conversation_id && row.conversation_id === activeIdRef.current) {
              refetchActive();
            }
            refetchInbox();
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "conversations" },
          refetchInbox,
        )
        .subscribe();
      return () => {
        genieSupabase.removeChannel(channel);
      };
    }

    // Polling fallback.
    const id = setInterval(() => {
      refetchInbox();
      refetchActive();
    }, 5000);
    return () => clearInterval(id);
  }, [queryClient]);

  // Auto-scroll to bottom on new tail message or first paint.
  useEffect(() => {
    if (!activeId) {
      lastTailIdRef.current = null;
      return;
    }
    const el = scrollContainerRef.current;
    if (!el) return;
    const tail = threadMessages[threadMessages.length - 1];
    const tailId = tail?.id ?? null;
    const prev = lastTailIdRef.current;
    const firstPaint = prev === null && threadMessages.length > 0;
    const newTail = tailId !== null && prev !== null && tailId !== prev;
    if (firstPaint || newTail) el.scrollTop = el.scrollHeight;
    lastTailIdRef.current = tailId;
  }, [threadMessages, activeId]);

  // Preserve scroll position when prepending older messages.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (prevScrollHeightRef.current > 0 && el.scrollHeight > prevScrollHeightRef.current) {
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
    }
  }, [threadMessages.length]);

  const onThreadScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollTop < 60 && hasMoreOlder && !fetchingOlder) {
      prevScrollHeightRef.current = el.scrollHeight;
      threadQuery.fetchNextPage();
    }
  };

  const sendReply = async () => {
    const text = replyText.trim();
    if (!text || !activeId) return;
    setReplyText("");
    setSendError(null);
    try {
      await sendReplyMutation.mutateAsync(text);
    } catch (e) {
      setReplyText(text);
      setSendError(e?.response?.data?.error || e?.message || "Failed to send");
    }
  };

  // Filter inbox by patient name / conversation preview.
  const q = search.trim().toLowerCase();
  const filtered = !q
    ? conversations
    : conversations.filter((c) =>
        [c.doctor_name, c.last_message_preview, c.patient_id]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );

  const totalUnread = conversations.reduce((n, c) => n + (c.team_unread_count || 0), 0);

  return (
    <div>
      <div className="messages__title">💬 My Patient Messages</div>

      {!activeConv ? (
        <div>
          <div className="messages__inbox-bar">
            <div className="messages__inbox-info">
              {conversations.length === 0
                ? "No messages yet"
                : `${totalUnread} unread · ${conversations.length} conversations`}
            </div>
            <button
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: qk.messages.conversations("doctor") })
              }
              disabled={convQuery.isFetching}
              className="messages__refresh-btn"
            >
              <span
                className={`messages__refresh-icon ${convQuery.isFetching ? "messages__refresh-icon--spinning" : ""}`}
              >
                ↻
              </span>{" "}
              {convQuery.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <div className="messages__search-bar">
            <span className="messages__search-icon">🔍</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              className="messages__search-input"
            />
            {search && (
              <button onClick={() => setSearch("")} className="messages__search-clear">
                ✕
              </button>
            )}
          </div>

          {convQuery.isLoading ? (
            <div className="messages__loading-center">
              <div className="messages__spinner" />
              <div className="messages__loading-text">Loading conversations…</div>
            </div>
          ) : conversations.length === 0 ? (
            <div className="messages__empty">
              <div className="messages__empty-icon">📭</div>
              <div className="messages__empty-text">No patient conversations yet</div>
              <div className="messages__empty-hint">
                When a patient messages you, the thread will appear here.
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="messages__empty">
              <div className="messages__empty-icon">🔍</div>
              <div className="messages__empty-text">No matches for "{search}"</div>
            </div>
          ) : (
            filtered.map((c) => {
              const unread = c.team_unread_count || 0;
              const previewPrefix = c.last_sender === "patient" ? "" : "You: ";
              return (
                <div
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
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
                        {(c.doctor_name || "P").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="messages__thread-name">
                          Patient {c.patient_id?.slice(0, 8) || ""}
                        </div>
                        <div className="messages__thread-file">Chat #{c.id.slice(0, 8)}</div>
                      </div>
                    </div>
                    <div className="messages__thread-meta">
                      {unread > 0 && <div className="messages__thread-badge">{unread} new</div>}
                      {c.last_message_at && (
                        <div className="messages__thread-date">
                          {new Date(c.last_message_at).toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  {c.last_message_preview && (
                    <div className="messages__thread-preview">
                      {previewPrefix}
                      {c.last_message_preview}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="messages__chat-view">
          <button onClick={() => setActiveId(null)} className="messages__back-btn">
            ← Back to Inbox
          </button>

          <div className="messages__patient-header">
            <div className="messages__patient-avatar">
              {(activeConv.doctor_name || "P").charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="messages__patient-name">
                Patient {activeConv.patient_id?.slice(0, 8)}
              </div>
              <div className="messages__patient-file">
                Chat #{activeConv.id.slice(0, 8)} · You as {activeConv.doctor_name || senderName}
              </div>
            </div>
          </div>

          <div
            className="messages__thread-scroll"
            ref={scrollContainerRef}
            onScroll={onThreadScroll}
          >
            {fetchingOlder && (
              <div className="messages__older-loader">
                <div className="messages__spinner messages__spinner--sm" />
                <span>Loading older messages…</span>
              </div>
            )}
            {!fetchingOlder && !hasMoreOlder && threadMessages.length > 0 && (
              <div className="messages__older-end">— Start of conversation —</div>
            )}
            {threadLoading && threadMessages.length === 0 ? (
              <div className="messages__loading-center">
                <div className="messages__spinner" />
                <div className="messages__loading-text">Loading conversation…</div>
              </div>
            ) : threadMessages.length === 0 ? (
              <div className="messages__thread-empty">No messages in this thread yet</div>
            ) : (
              threadMessages.map((m, i) => {
                const isTeam = m.direction === "inbound";
                return (
                  <div
                    key={m.id || `idx-${i}`}
                    className={`messages__msg-row ${isTeam ? "messages__msg-row--doctor" : "messages__msg-row--patient"}`}
                  >
                    <div
                      className={`messages__msg-bubble ${isTeam ? "messages__msg-bubble--doctor" : "messages__msg-bubble--patient"}`}
                    >
                      <div className="messages__msg-text">{m.message}</div>
                      <div className="messages__msg-meta">
                        {m.sender_name || (isTeam ? senderName : "Patient")} ·{" "}
                        {new Date(m.created_at).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
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
              placeholder={`Reply as ${senderName}… (Enter to send)`}
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
                {sendingReply ? "Sending…" : "Send Reply ✉️"}
              </button>
              {sendError && (
                <div
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: "#b91c1c",
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: 6,
                    padding: "4px 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>⚠ {sendError}</span>
                  <button
                    onClick={() => {
                      setSendError(null);
                      sendReply();
                    }}
                    style={{
                      background: "#dc2626",
                      color: "white",
                      border: "none",
                      borderRadius: 4,
                      padding: "2px 8px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
