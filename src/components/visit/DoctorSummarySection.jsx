import React, { useEffect, useMemo, useState } from "react";
import { useDoctorSummary, useSaveDoctorSummary } from "../../queries/hooks/useDoctorSummary.js";
import useAuthStore from "../../stores/authStore";

const fmtDateTime = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
};

// Word-level diff via LCS. Returns an array of {type: 'eq'|'add'|'del', text}
// chunks suitable for inline rendering. Splits on whitespace boundaries but
// preserves the whitespace so reconstructed text reads naturally.
function diffWords(prev = "", curr = "") {
  const tokenize = (s) => (s == null ? [] : s.match(/\s+|\S+/g) || []);
  const a = tokenize(prev);
  const b = tokenize(curr);
  const m = a.length;
  const n = b.length;
  // Build LCS DP table.
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0,
    j = 0;
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push("eq", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("add", b[j]);
      j++;
    }
  }
  while (i < m) push("del", a[i++]);
  while (j < n) push("add", b[j++]);
  return out;
}

function DiffView({ prev, curr, mode = "inline" }) {
  const chunks = useMemo(() => diffWords(prev || "", curr || ""), [prev, curr]);
  if (mode === "removed-only") {
    return (
      <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
        {chunks
          .filter((c) => c.type !== "add")
          .map((c, i) =>
            c.type === "del" ? (
              <span
                key={i}
                style={{
                  background: "#fee2e2",
                  color: "#b91c1c",
                  textDecoration: "line-through",
                }}
              >
                {c.text}
              </span>
            ) : (
              <span key={i}>{c.text}</span>
            ),
          )}
      </span>
    );
  }
  return (
    <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
      {chunks.map((c, i) => {
        if (c.type === "eq") return <span key={i}>{c.text}</span>;
        if (c.type === "add")
          return (
            <span
              key={i}
              style={{ background: "#dcfce7", color: "#166534", padding: "0 2px", borderRadius: 2 }}
            >
              {c.text}
            </span>
          );
        return (
          <span
            key={i}
            style={{
              background: "#fee2e2",
              color: "#b91c1c",
              textDecoration: "line-through",
              padding: "0 2px",
              borderRadius: 2,
            }}
          >
            {c.text}
          </span>
        );
      })}
    </span>
  );
}

function diffStats(prev = "", curr = "") {
  const chunks = diffWords(prev, curr);
  let added = 0,
    removed = 0;
  for (const c of chunks) {
    const wc = (c.text.match(/\S+/g) || []).length;
    if (c.type === "add") added += wc;
    else if (c.type === "del") removed += wc;
  }
  return { added, removed };
}

export default function DoctorSummarySection({ patientId, appointmentId }) {
  const conName = useAuthStore((s) => s.conName);
  const moName = useAuthStore((s) => s.moName);
  const authorName = conName || moName || "Doctor";

  const q = useDoctorSummary(patientId);
  const saveM = useSaveDoctorSummary(patientId);

  const versions = q.data?.versions || [];
  const current = versions[0] || null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [compareWith, setCompareWith] = useState(null); // version id to compare current with

  // When opening the editor, seed it with the current content.
  useEffect(() => {
    if (editing) {
      setDraft(current?.content || "");
      setChangeNote("");
    }
  }, [editing, current]);

  if (!patientId) return null;

  const onSave = async () => {
    const text = (draft || "").trim();
    if (!text) return;
    if (current && text === current.content && !changeNote.trim()) {
      setEditing(false);
      return;
    }
    await saveM.mutateAsync({
      content: text,
      change_note: changeNote.trim() || null,
      appointment_id: appointmentId || null,
      author_name: authorName,
    });
    setEditing(false);
  };

  const onCancel = () => {
    setEditing(false);
    setDraft("");
    setChangeNote("");
  };

  const compareVersion = compareWith ? versions.find((v) => v.id === compareWith) : null;

  return (
    <div
      id="summary-doctor"
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: 14,
        marginBottom: 14,
        boxShadow: "0 1px 3px rgba(0,0,0,.05)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>📝 Doctor's Summary</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
            {current
              ? `v${current.version} · ${fmtDateTime(current.created_at)}${
                  current.author_name ? ` · ${current.author_name}` : ""
                }`
              : "No summary yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {versions.length > 0 && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: showHistory ? "#eef2ff" : "#fff",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                color: "#334155",
              }}
            >
              🕘 Versions ({versions.length})
            </button>
          )}
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid #009e8c",
                background: "#009e8c",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {current ? "✏️ Edit" : "➕ Create Summary"}
            </button>
          )}
        </div>
      </div>

      {q.isError && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: 8,
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {q.error?.message || "Failed to load summary"}
        </div>
      )}

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            placeholder="Write the doctor's summary for this patient — clinical impression, plan, key points to track…"
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 13,
              fontFamily: "inherit",
              lineHeight: 1.5,
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <input
            type="text"
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            placeholder="What changed? (optional — appears in version history)"
            style={{
              width: "100%",
              padding: "6px 10px",
              marginTop: 8,
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 12,
              boxSizing: "border-box",
            }}
          />
          {current && draft !== current.content && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4, color: "#475569" }}>
                Preview changes vs v{current.version}:
              </div>
              <DiffView prev={current.content} curr={draft} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={onSave}
              disabled={saveM.isPending || !(draft || "").trim()}
              style={{
                padding: "7px 16px",
                borderRadius: 6,
                border: "none",
                background: saveM.isPending || !(draft || "").trim() ? "#94a3b8" : "#009e8c",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
                cursor: saveM.isPending ? "wait" : "pointer",
              }}
            >
              {saveM.isPending
                ? "Saving…"
                : current
                  ? `Save as v${(current.version || 0) + 1}`
                  : "Save v1"}
            </button>
            <button
              onClick={onCancel}
              disabled={saveM.isPending}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                color: "#475569",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : current ? (
        <div
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 13,
            color: "#1e293b",
            lineHeight: 1.6,
            background: "#fafbfc",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #eef2f6",
          }}
        >
          {current.content}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#94a3b8", fontStyle: "italic", padding: 8 }}>
          No summary has been created yet. Click "Create Summary" to add one.
        </div>
      )}

      {showHistory && versions.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid #e2e8f0", paddingTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: "#334155", marginBottom: 8 }}>
            Version History
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {versions.map((v, idx) => {
              const prevV = versions[idx + 1] || null;
              const stats = prevV ? diffStats(prevV.content, v.content) : null;
              const isOpen = compareWith === v.id;
              const isLatest = idx === 0;
              return (
                <div
                  key={v.id}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    background: isLatest ? "#f0fdfa" : "#fff",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 10px",
                      flexWrap: "wrap",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontSize: 12, color: "#0f172a" }}>
                      <span style={{ fontWeight: 700 }}>v{v.version}</span>
                      <span style={{ color: "#64748b", marginLeft: 8 }}>
                        {fmtDateTime(v.created_at)}
                      </span>
                      {v.author_name && (
                        <span style={{ color: "#64748b", marginLeft: 8 }}>· {v.author_name}</span>
                      )}
                      {isLatest && (
                        <span
                          style={{
                            marginLeft: 8,
                            background: "#0d9488",
                            color: "#fff",
                            padding: "1px 6px",
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 700,
                          }}
                        >
                          CURRENT
                        </span>
                      )}
                      {stats && (stats.added || stats.removed) ? (
                        <span style={{ marginLeft: 8, fontSize: 11 }}>
                          <span style={{ color: "#16a34a" }}>+{stats.added}</span>{" "}
                          <span style={{ color: "#dc2626" }}>−{stats.removed}</span>
                        </span>
                      ) : null}
                    </div>
                    {prevV && (
                      <button
                        onClick={() => setCompareWith(isOpen ? null : v.id)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 4,
                          border: "1px solid #cbd5e1",
                          background: isOpen ? "#eef2ff" : "#fff",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                          color: "#334155",
                        }}
                      >
                        {isOpen ? "Hide diff" : "Show diff"}
                      </button>
                    )}
                  </div>
                  {v.change_note && (
                    <div
                      style={{
                        padding: "0 10px 6px",
                        fontSize: 11,
                        color: "#475569",
                        fontStyle: "italic",
                      }}
                    >
                      “{v.change_note}”
                    </div>
                  )}
                  {v.content && (
                    <div
                      style={{
                        padding: "8px 10px 10px",
                        borderTop: "1px dashed #e2e8f0",
                        fontSize: 12,
                        lineHeight: 1.55,
                        color: "#1f2937",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {v.content}
                    </div>
                  )}
                  {isOpen && prevV && (
                    <div
                      style={{
                        padding: 10,
                        borderTop: "1px solid #e2e8f0",
                        background: "#fafbfc",
                        fontSize: 12,
                        lineHeight: 1.6,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: "#64748b",
                          textTransform: "uppercase",
                          letterSpacing: ".04em",
                          marginBottom: 6,
                        }}
                      >
                        Diff vs v{prevV.version}
                      </div>
                      <DiffView prev={prevV.content} curr={v.content} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
