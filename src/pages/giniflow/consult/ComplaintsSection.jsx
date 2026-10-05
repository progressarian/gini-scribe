import { useEffect, useMemo, useRef, useState } from "react";
import { clearDraftField, writeDraftField } from "../../../lib/consultDraft";
import {
  useAddComplaint,
  useRemoveComplaint,
  useSaveHistory,
  useVisitComplaints,
} from "../../../queries/hooks/useGiniflowDoctor";

const TOP_SHOWN = 30;
const NEW_SHOWN = 20;

const norm = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export default function ComplaintsSection({
  visitId,
  readOnly,
  onToast,
  onUnsaved,
  restored,
  flushRef,
}) {
  const { data, isLoading, isError } = useVisitComplaints(visitId);
  const add = useAddComplaint(visitId);
  const remove = useRemoveComplaint(visitId);
  const saveHistory = useSaveHistory(visitId);
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState(null);
  const [savedText, setSavedText] = useState(null);
  const latestHistory = useRef(null);
  const appliedRestore = useRef(false);

  useEffect(() => {
    if (data && savedText === null) {
      setSavedText(data.history || "");
      setHistory(data.history || "");
    }
  }, [data, savedText]);

  useEffect(() => {
    if (appliedRestore.current || savedText === null || restored?.history === undefined) return;
    appliedRestore.current = true;
    latestHistory.current = restored.history;
    setHistory(restored.history);
  }, [restored, savedText]);

  const editHistory = (value) => {
    latestHistory.current = value;
    setHistory(value);
    writeDraftField(visitId, "history", value);
  };

  const historyDirty = history !== null && savedText !== null && history !== savedText;
  useEffect(() => {
    onUnsaved?.("history", historyDirty);
  }, [historyDirty, onUnsaved]);
  useEffect(() => () => onUnsaved?.("history", false), [onUnsaved]);

  const sendHistory = (text) =>
    saveHistory.mutate(text, {
      onSuccess: () => {
        setSavedText(text);
        if (latestHistory.current === null || latestHistory.current === text) {
          clearDraftField(visitId, "history");
        }
      },
      onError: (e) =>
        onToast(e?.response?.data?.error || "History not saved — keep typing to retry"),
    });

  if (flushRef) {
    flushRef.current = () => {
      if (historyDirty && !readOnly && !saveHistory.isPending) sendHistory(history);
    };
  }

  useEffect(() => {
    if (!historyDirty || readOnly) return undefined;
    const timer = setTimeout(() => sendHistory(history), 800);
    return () => clearTimeout(timer);
  }, [history, historyDirty, readOnly]);

  const current = data?.current || [];
  const taken = useMemo(() => new Set(current.map((c) => norm(c.label))), [current]);
  const typed = search.replace(/\s+/g, " ").trim();
  const words = norm(typed).split(" ").filter(Boolean);
  const known = useMemo(
    () => (data?.common || []).filter((c) => !taken.has(norm(c.label))),
    [data, taken],
  );
  const suggestions = words.length
    ? known.filter((c) => words.every((word) => norm(c.label).includes(word)))
    : [
        ...known.slice(0, TOP_SHOWN),
        ...known
          .slice(TOP_SHOWN)
          .filter((c) => c.isNew)
          .slice(0, NEW_SHOWN),
      ];
  const canAddTyped =
    typed.length >= 2 &&
    !taken.has(norm(typed)) &&
    !known.some((c) => norm(c.label) === norm(typed));
  const busy = add.isPending || remove.isPending;

  const addLabel = (label) =>
    add.mutate(label, {
      onSuccess: () => setSearch(""),
      onError: (e) => onToast(e?.response?.data?.error || "Complaint not saved — try again"),
    });

  return (
    <section className="csec" id="s-complaints">
      <div className="cs-head">
        <h2>🗣 Symptoms / History</h2>
        <span className="cs-sub">
          today's complaints · printed on the prescription above Diagnoses
        </span>
      </div>

      {isLoading && <div className="cn-empty">Loading complaints…</div>}
      {isError && <div className="cn-empty">Complaints could not be loaded.</div>}

      {!isLoading && !isError && (
        <>
          <label className="cp-lab" htmlFor={`cp-history-${visitId}`}>
            History<em> — printed on the prescription under the complaints</em>
          </label>
          <textarea
            id={`cp-history-${visitId}`}
            className="cp-text"
            rows={3}
            value={history ?? ""}
            readOnly={readOnly}
            placeholder="e.g. Known asthmatic since childhood, smoker 20 pack-years, on inhalers"
            onChange={(e) => editHistory(e.target.value)}
          />
          <div className="cs-sub" aria-live="polite">
            {readOnly
              ? ""
              : saveHistory.isPending
                ? "Saving…"
                : historyDirty
                  ? "Unsaved"
                  : history
                    ? "Saved"
                    : ""}
          </div>

          <div className="cn-head">Recorded for this visit</div>
          {current.length === 0 ? (
            <div className="cn-empty">No complaints recorded yet.</div>
          ) : (
            <div className="tst-customlist">
              {current.map((c) => (
                <span key={c.id} className="tst-custom">
                  {c.label}
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${c.label}`}
                      disabled={busy}
                      onClick={() =>
                        remove.mutate(c.id, {
                          onError: (e) =>
                            onToast(e?.response?.data?.error || "Complaint not removed"),
                        })
                      }
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {!readOnly && (
            <>
              <div className="tst-heard">
                <input
                  type="search"
                  className="cp-inp tst-filter"
                  value={search}
                  placeholder="Search complaints or type a new one — e.g. cough, breathlessness"
                  aria-label="Search complaints"
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSearch("");
                    if (e.key === "Enter" && canAddTyped && !busy) {
                      e.preventDefault();
                      addLabel(typed);
                    }
                  }}
                />
                {canAddTyped && (
                  <button
                    type="button"
                    className="btn-sm on"
                    disabled={busy}
                    onClick={() => addLabel(typed)}
                  >
                    + Add “{typed}”
                  </button>
                )}
              </div>
              <div className="tst-list">
                {suggestions.map((c) => (
                  <button
                    type="button"
                    key={c.label}
                    className="tst-chip"
                    disabled={busy}
                    onClick={() => addLabel(c.label)}
                  >
                    <span className="tst-name">{c.label}</span>
                    {c.isNew && <span className="tst-gloss">new</span>}
                  </button>
                ))}
                {typed && suggestions.length === 0 && !canAddTyped && (
                  <div className="cn-empty">Already recorded.</div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
