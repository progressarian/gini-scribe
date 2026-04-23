import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { genieSupabase, hasGenieRealtime } from "../lib/genieSupabase.js";
import { useConversations } from "../queries/hooks/useConversations";
import { useThreadMessages, flattenThread } from "../queries/hooks/useThreadMessages";
import { useSendReply } from "../queries/hooks/useSendReply";
import { qk } from "../queries/keys";
import "./MessagesPage.css";

// Shared team inbox (Lab / Reception). Unlike the doctor inbox, all scribe
// users see the same conversations here — these are team-shared queues.
export default function RoleInboxPage({ role, title, senderLabel, defaultSenderName }) {
  const queryClient = useQueryClient();
  const convQuery = useConversations(role);
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
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [patientQuery, setPatientQuery] = useState("");
  const [patientResults, setPatientResults] = useState([]);
  const [patientSearching, setPatientSearching] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [newChatError, setNewChatError] = useState(null);

  useEffect(() => {
    if (!showNewChat) return;
    const q = patientQuery.trim();
    let cancelled = false;
    setPatientSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/api/genie-patients/search", { params: { q } });
        if (!cancelled) setPatientResults(data?.data || []);
      } catch {
        if (!cancelled) setPatientResults([]);
      } finally {
        if (!cancelled) setPatientSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [patientQuery, showNewChat]);

  const startChatWithPatient = async (patient) => {
    if (!patient?.id || startingChat) return;
    setStartingChat(true);
    setNewChatError(null);
    try {
      const { data: conv } = await api.post(
        `/api/patients/${patient.id}/conversations/ensure`,
        { kind: role },
      );
      if (!conv?.id) throw new Error("Failed to create conversation");
      await queryClient.invalidateQueries({ queryKey: qk.messages.conversations(role) });
      setShowNewChat(false);
      setPatientQuery("");
      setPatientResults([]);
      setActiveId(conv.id);
    } catch (e) {
      setNewChatError(e?.response?.data?.error || e?.message || "Failed to start chat");
    } finally {
      setStartingChat(false);
    }
  };

  const threadQuery = useThreadMessages(activeId, { enabled: !!activeId });
  const threadMessages = flattenThread(threadQuery.data?.pages);
  const threadLoading = threadQuery.isLoading;
  const fetchingOlder = threadQuery.isFetchingNextPage;
  const hasMoreOlder = threadQuery.hasNextPage;

  const sendReplyMutation = useSendReply({
    conversationId: activeId,
    senderName: defaultSenderName || senderLabel,
  });
  const sendingReply = sendReplyMutation.isPending;

  const scrollContainerRef = useRef(null);
  const prevScrollHeightRef = useRef(0);
  const lastTailIdRef = useRef(null);

  useEffect(() => {
    if (!activeId) return;
    api.post(`/api/conversations/${activeId}/read`).catch(() => {});
    queryClient.invalidateQueries({ queryKey: qk.messages.conversations(role) });
  }, [activeId, threadMessages.length, queryClient, role]);

  useEffect(() => {
    const refetchInbox = () => {
      queryClient.invalidateQueries({ queryKey: qk.messages.conversations(role) });
    };
    const refetchActive = () => {
      const id = activeIdRef.current;
      if (id) queryClient.invalidateQueries({ queryKey: qk.messages.conversationMessages(id) });
    };

    if (hasGenieRealtime && genieSupabase) {
      const channel = genieSupabase
        .channel(`scribe-team-inbox:${role}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "patient_messages" },
          (payload) => {
            const row = payload.new;
            if (row?.conversation_id === activeIdRef.current) refetchActive();
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

    const id = setInterval(() => {
      refetchInbox();
      refetchActive();
    }, 5000);
    return () => clearInterval(id);
  }, [queryClient, role]);

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

  const q = search.trim().toLowerCase();
  const filtered = !q
    ? conversations
    : conversations.filter((c) =>
        [c.last_message_preview, c.patient_id, c.patient?.name, c.patient?.phone]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );

  const totalUnread = conversations.reduce((n, c) => n + (c.team_unread_count || 0), 0);

  return (
    <div>
      <div className="messages__title">{title}</div>

      {showNewChat && (
        <div
          onClick={() => !startingChat && setShowNewChat(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            zIndex: 50,
            padding: "80px 16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 480,
              background: "white",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 16 }}>Start a new chat</div>
              <button
                onClick={() => setShowNewChat(false)}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: 20,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <input
              autoFocus
              type="text"
              value={patientQuery}
              onChange={(e) => setPatientQuery(e.target.value)}
              placeholder="Search patient by name or phone…"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                fontSize: 14,
                marginBottom: 10,
                boxSizing: "border-box",
              }}
            />
            {newChatError && (
              <div
                style={{
                  fontSize: 12,
                  color: "#b91c1c",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: 6,
                  padding: "6px 10px",
                  marginBottom: 8,
                }}
              >
                ⚠ {newChatError}
              </div>
            )}
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {patientSearching ? (
                <div style={{ padding: 12, color: "#64748b", fontSize: 13 }}>Searching…</div>
              ) : patientResults.length === 0 ? (
                <div style={{ padding: 12, color: "#64748b", fontSize: 13 }}>
                  {patientQuery.trim() ? "No patients found" : "Type to search patients"}
                </div>
              ) : (
                patientResults.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => startChatWithPatient(p)}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      cursor: startingChat ? "wait" : "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      borderBottom: "1px solid #f1f5f9",
                      opacity: startingChat ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{p.name || "Unnamed"}</div>
                      <div style={{ fontSize: 12, color: "#64748b" }}>
                        {p.phone || "No phone"}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "#2563eb", fontWeight: 500 }}>
                      Chat →
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {!activeConv ? (
        <div>
          <div className="messages__inbox-bar">
            <div className="messages__inbox-info">
              {conversations.length === 0
                ? "No messages yet"
                : `${totalUnread} unread · ${conversations.length} patients`}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setShowNewChat(true);
                  setPatientQuery("");
                  setPatientResults([]);
                  setNewChatError(null);
                }}
                className="messages__refresh-btn"
                style={{ background: "#2563eb", color: "white", border: "none" }}
              >
                + New Chat
              </button>
              <button
                onClick={async () => {
                  setManualRefreshing(true);
                  try {
                    await queryClient.invalidateQueries({
                      queryKey: qk.messages.conversations(role),
                    });
                  } finally {
                    setManualRefreshing(false);
                  }
                }}
                disabled={manualRefreshing}
                className="messages__refresh-btn"
              >
                <span
                  className={`messages__refresh-icon ${manualRefreshing ? "messages__refresh-icon--spinning" : ""}`}
                >
                  ↻
                </span>{" "}
                {manualRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
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
              <div className="messages__loading-text">Loading messages…</div>
            </div>
          ) : conversations.length === 0 ? (
            <div className="messages__empty">
              <div className="messages__empty-icon">📭</div>
              <div className="messages__empty-text">No {senderLabel} messages yet</div>
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
              const displayName = c.patient?.name || `Patient ${c.patient_id?.slice(0, 8) || ""}`;
              const displaySub = c.patient?.phone || `Chat #${c.id.slice(0, 8)}`;
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
                        {(displayName || "P").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="messages__thread-name">{displayName}</div>
                        <div className="messages__thread-file">{displaySub}</div>
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
              {(activeConv.patient?.name || activeConv.patient_id || "P")
                .charAt(0)
                .toUpperCase()}
            </div>
            <div>
              <div className="messages__patient-name">
                {activeConv.patient?.name || `Patient ${activeConv.patient_id?.slice(0, 8)}`}
              </div>
              <div className="messages__patient-file">
                {activeConv.patient?.phone || `Chat #${activeConv.id.slice(0, 8)}`}
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
              <div className="messages__thread-empty">No messages in this thread</div>
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
                        {m.sender_name || (isTeam ? senderLabel : "Patient")} ·{" "}
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
              placeholder={`Reply as ${senderLabel}… (Enter to send)`}
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
