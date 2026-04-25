import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { genieSupabase, hasGenieRealtime } from "../lib/genieSupabase.js";
import { useConversations } from "../queries/hooks/useConversations";
import { useThreadMessages, flattenThread } from "../queries/hooks/useThreadMessages";
import { useSendReply } from "../queries/hooks/useSendReply";
import { qk } from "../queries/keys";
import PdfViewerModal from "../components/visit/PdfViewerModal";
import "./MessagesPage.css";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Renders an attachment inline. Sent (team→patient) bubbles use a
// translucent-white inner card so the file pill reads against the doctor
// bubble's tinted background; received (patient→team) bubbles use a
// slate inner card on white. Clicking opens the inline PdfViewerModal
// via onOpen — never a new tab.
function AttachmentBubble({ message, conversationId, onOpen, variant = "received" }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const isImage = (message.attachment_mime || "").startsWith("image/");
  const isPending = !message.id || String(message.id).startsWith("tmp-");
  const isSent = variant === "sent";

  useEffect(() => {
    if (isPending) return;
    let cancelled = false;
    setError(null);
    setUrl(null);
    api
      .get(`/api/conversations/${conversationId}/messages/${message.id}/attachment-url`)
      .then((r) => {
        if (!cancelled) setUrl(r.data?.url || null);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.error || "Could not load attachment");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, message.id, isPending, attempt]);

  // Theme tokens — match the patient app's polish but in CSS.
  const cardBg = isSent ? "rgba(255,255,255,0.18)" : "#F1F5F9";
  const cardBorder = isSent ? "rgba(255,255,255,0.28)" : "#E2E8F0";
  const titleColor = isSent ? "#FFFFFF" : "#0F172A";
  const subColor = isSent ? "rgba(255,255,255,0.78)" : "#64748B";
  const badgeBg = isSent ? "rgba(255,255,255,0.22)" : "#FFFFFF";
  const badgeColor = isSent ? "#FFFFFF" : "#DC2626";
  const ext = (message.attachment_name?.split(".").pop() || "FILE")
    .toUpperCase()
    .slice(0, 4);
  const sizeLabel = formatBytes(message.attachment_size);

  const cardBase = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: cardBg,
    border: `1px solid ${cardBorder}`,
    borderRadius: 10,
    minWidth: 220,
    maxWidth: 300,
    color: titleColor,
    font: "inherit",
    cursor: "pointer",
    marginBottom: 4,
  };

  if (isPending) {
    return (
      <div style={{ ...cardBase, cursor: "default" }}>
        <div className="messages__spinner messages__spinner--sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: titleColor,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {message.attachment_name || "Sending…"}
          </div>
          <div style={{ fontSize: 11, color: subColor, marginTop: 2 }}>Sending…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <button
        type="button"
        onClick={() => setAttempt((n) => n + 1)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          background: isSent ? "rgba(254,226,226,0.20)" : "#FEF2F2",
          border: `1px solid ${isSent ? "rgba(254,202,202,0.50)" : "#FECACA"}`,
          borderRadius: 10,
          color: isSent ? "#FECACA" : "#B91C1C",
          font: "inherit",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          marginBottom: 4,
        }}
      >
        ⚠ Couldn't load — click to retry
      </button>
    );
  }

  if (!url) {
    return (
      <div style={{ ...cardBase, cursor: "default" }}>
        <div className="messages__spinner messages__spinner--sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: titleColor,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {message.attachment_name || (isImage ? "Loading image…" : "Loading file…")}
          </div>
          <div style={{ fontSize: 11, color: subColor, marginTop: 2 }}>
            Preparing preview…
          </div>
        </div>
      </div>
    );
  }

  const open = () =>
    onOpen?.({
      url,
      mimeType: message.attachment_mime || (isImage ? "image/jpeg" : "application/pdf"),
      fileName: message.attachment_name || "attachment",
    });

  if (isImage) {
    return (
      <button
        type="button"
        onClick={open}
        style={{
          background: "transparent",
          border: `1px solid ${cardBorder}`,
          padding: 0,
          cursor: "zoom-in",
          display: "block",
          borderRadius: 12,
          overflow: "hidden",
          marginBottom: 4,
        }}
      >
        <img
          src={url}
          alt={message.attachment_name || "attachment"}
          className="messages__msg-image"
          style={{
            maxWidth: 280,
            maxHeight: 280,
            borderRadius: 12,
            display: "block",
            background: "#E5E7EB",
          }}
        />
      </button>
    );
  }
  return (
    <button type="button" onClick={open} style={cardBase}>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: badgeBg,
          border: isSent ? "none" : "1px solid #E2E8F0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            color: badgeColor,
            letterSpacing: 0.5,
          }}
        >
          {ext}
        </span>
      </div>
      <div style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: titleColor,
            lineHeight: "17px",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
          }}
        >
          {message.attachment_name || "Open file"}
        </div>
        <div style={{ fontSize: 11, color: subColor, marginTop: 2 }}>
          {[sizeLabel, "Click to open"].filter(Boolean).join(" · ")}
        </div>
      </div>
    </button>
  );
}

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
  // Multi-file attachment queue. Picking adds to it; remove via the
  // per-chip ✕ button. Each entry sends as its own message on Send.
  const [pendingFiles, setPendingFiles] = useState([]); // [{id, file, fileName, mime, size}]
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, percent: 0 });
  const fileInputRef = useRef(null);
  // Lifted lightbox state — clicking any attachment in the thread opens here
  // instead of a new tab. PdfViewerModal handles both images and PDFs.
  const [viewerSrc, setViewerSrc] = useState(null);
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
      const { data: conv } = await api.post(`/api/patients/${patient.id}/conversations/ensure`, {
        kind: role,
      });
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

  // Upload one file with progress reporting. Reads as base64 then POSTs
  // via XHR (fetch can't expose upload-progress events) to the existing
  // /api/conversations/:id/attachments endpoint. Resolves to the
  // attachment metadata on success.
  const uploadOneAttachment = async (pf, onProgress) => {
    const base64 = await fileToBase64(pf.file);
    const body = JSON.stringify({
      base64,
      mediaType: pf.mime,
      fileName: pf.fileName,
    });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/conversations/${activeId}/attachments`, true);
      // Reuse the auth header axios uses elsewhere — read from localStorage
      // to match the api.js interceptor's behavior.
      const token = localStorage.getItem("gini_auth_token");
      if (token) xhr.setRequestHeader("x-auth-token", token);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.upload.onprogress = (evt) => {
        if (onProgress && evt.lengthComputable && evt.total > 0) {
          onProgress(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
        }
      };
      xhr.onload = () => {
        let parsed = null;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          /* keep raw */
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(parsed?.error || `Upload failed (${xhr.status})`));
          return;
        }
        if (onProgress) onProgress(100);
        resolve({
          attachment_path: parsed.attachment_path,
          attachment_mime: parsed.attachment_mime,
          attachment_name: parsed.attachment_name,
        });
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.ontimeout = () => reject(new Error("Upload timed out"));
      xhr.send(body);
    });
  };

  const sendReply = async () => {
    const text = replyText.trim();
    if ((!text && pendingFiles.length === 0) || !activeId) return;
    if (uploadingFile) return;
    setSendError(null);

    // Snapshot + clear so the user can keep typing the next message.
    const queue = pendingFiles.slice();
    setPendingFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Each file becomes its own message. The trailing text (if any)
    // becomes a separate text-only message after all files have sent —
    // matches WhatsApp/Telegram batch behavior.
    let successCount = 0;
    if (queue.length > 0) {
      setUploadingFile(true);
      for (let i = 0; i < queue.length; i++) {
        const pf = queue[i];
        setUploadProgress({ current: i + 1, total: queue.length, percent: 0 });
        try {
          const attachment = await uploadOneAttachment(pf, (pct) =>
            setUploadProgress({ current: i + 1, total: queue.length, percent: pct }),
          );
          await sendReplyMutation.mutateAsync({
            message: undefined,
            ...attachment,
          });
          successCount += 1;
        } catch (e) {
          console.warn("[chat upload]", pf.fileName, e?.message);
          setSendError(`${pf.fileName}: ${e?.message || "Upload failed"}`);
          // Continue to the next file in the queue.
        }
      }
      setUploadingFile(false);
      setUploadProgress({ current: 0, total: 0, percent: 0 });
    }

    if (text) {
      setReplyText("");
      try {
        await sendReplyMutation.mutateAsync({ message: text });
      } catch (e) {
        setReplyText(text);
        setSendError(e?.response?.data?.error || e?.message || "Failed to send");
      }
    } else if (queue.length > 0 && successCount === 0) {
      // All uploads failed and there's no text — restore queue so the
      // user can retry without re-picking files.
      setPendingFiles(queue);
    }
  };

  const onPickFile = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const ALLOWED = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/heic",
      "image/heif",
      "image/webp",
      "application/pdf",
    ];
    const additions = [];
    let rejectedType = 0;
    let rejectedSize = 0;
    for (const file of files) {
      if (!ALLOWED.includes(file.type)) {
        rejectedType += 1;
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        rejectedSize += 1;
        continue;
      }
      additions.push({
        id: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        fileName: file.name,
        mime: file.type,
        size: file.size,
      });
    }
    e.target.value = "";
    if (rejectedType + rejectedSize > 0) {
      const parts = [];
      if (rejectedType) parts.push(`${rejectedType} unsupported`);
      if (rejectedSize) parts.push(`${rejectedSize} > 10 MB`);
      setSendError(`Skipped ${parts.join(", ")}`);
    } else {
      setSendError(null);
    }
    if (additions.length === 0) return;
    setPendingFiles((prev) => [...prev, ...additions]);
  };

  const removePendingFile = (id) => {
    setPendingFiles((prev) => prev.filter((p) => p.id !== id));
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
                      <div style={{ fontSize: 12, color: "#64748b" }}>{p.phone || "No phone"}</div>
                    </div>
                    <div style={{ fontSize: 12, color: "#2563eb", fontWeight: 500 }}>Chat →</div>
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
              {(activeConv.patient?.name || activeConv.patient_id || "P").charAt(0).toUpperCase()}
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
                      {m.attachment_path && (
                        <div style={{ marginBottom: m.message ? 6 : 0 }}>
                          <AttachmentBubble
                            message={m}
                            conversationId={activeId}
                            onOpen={setViewerSrc}
                            variant={isTeam ? "sent" : "received"}
                          />
                        </div>
                      )}
                      {m.message && <div className="messages__msg-text">{m.message}</div>}
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
            {pendingFiles.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                {uploadingFile && uploadProgress.total > 1 && (
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#1A5FAA",
                      padding: "0 2px",
                    }}
                  >
                    Uploading {uploadProgress.current} of {uploadProgress.total}…
                  </div>
                )}
                {pendingFiles.map((pf, idx) => {
                  const isActive = uploadingFile && uploadProgress.current === idx + 1;
                  const ext = (pf.fileName.split(".").pop() || "FILE")
                    .toUpperCase()
                    .slice(0, 4);
                  return (
                    <div
                      key={pf.id}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        padding: "10px 12px",
                        background: isActive ? "#EFF6FF" : "#F1F5F9",
                        border: `1px solid ${isActive ? "#BFDBFE" : "#E2E8F0"}`,
                        borderRadius: 10,
                        opacity: uploadingFile && !isActive ? 0.6 : 1,
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {isActive ? (
                          <div className="messages__spinner messages__spinner--sm" />
                        ) : (
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 6,
                              background: "#FFFFFF",
                              border: "1px solid #E2E8F0",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 800,
                                color: "#DC2626",
                                letterSpacing: 0.5,
                              }}
                            >
                              {ext}
                            </span>
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "#0F172A",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {pf.fileName}
                          </div>
                          <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>
                            {isActive
                              ? `Uploading… ${uploadProgress.percent}%`
                              : pf.size
                                ? `${(pf.size / 1024).toFixed(0)} KB${uploadingFile ? " · waiting" : " · ready"}`
                                : uploadingFile
                                  ? "Waiting"
                                  : "Ready"}
                          </div>
                        </div>
                        {!uploadingFile && (
                          <button
                            type="button"
                            onClick={() => removePendingFile(pf.id)}
                            aria-label="Remove file"
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "#94A3B8",
                              cursor: "pointer",
                              fontSize: 16,
                              fontWeight: 700,
                              padding: "4px 6px",
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      {isActive && (
                        <div
                          style={{
                            marginTop: 8,
                            height: 4,
                            borderRadius: 2,
                            background: "#DBEAFE",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.max(2, uploadProgress.percent)}%`,
                              height: "100%",
                              background: "#1A5FAA",
                              transition: "width 0.15s ease",
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf"
              multiple
              onChange={onPickFile}
              style={{ display: "none" }}
            />
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              placeholder={`Reply as ${senderLabel}… (Enter to send, Shift+Enter for newline)`}
              className="messages__reply-textarea"
              disabled={uploadingFile}
            />
            <div className="messages__reply-actions">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="messages__clear-btn"
                disabled={uploadingFile}
                title="Attach images or PDFs (multi-select, max 10 MB each)"
              >
                📎 Attach
              </button>
              <button
                onClick={() => {
                  setReplyText("");
                  setPendingFiles([]);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="messages__clear-btn"
                disabled={uploadingFile}
              >
                Clear
              </button>
              <button
                onClick={sendReply}
                disabled={
                  (!replyText.trim() && pendingFiles.length === 0) ||
                  sendingReply ||
                  uploadingFile
                }
                className={`messages__send-btn ${replyText.trim() || pendingFiles.length > 0 ? "messages__send-btn--active" : "messages__send-btn--disabled"}`}
              >
                {uploadingFile
                  ? `Uploading… ${uploadProgress.percent}%`
                  : sendingReply
                    ? "Sending…"
                    : pendingFiles.length > 1
                      ? `Send ${pendingFiles.length} files ✉️`
                      : "Send Reply ✉️"}
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
      {viewerSrc && <PdfViewerModal src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </div>
  );
}
