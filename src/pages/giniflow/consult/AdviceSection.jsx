import { useEffect, useRef, useState } from "react";
import { clearDraftField, writeDraftField } from "../../../lib/consultDraft";
import { useSaveAdvice, useVisitAdvice } from "../../../queries/hooks/useGiniflowDoctor";

const TOP_SHOWN = 15;

const norm = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export default function AdviceSection({
  visitId,
  readOnly,
  onToast,
  onUnsaved,
  restored,
  flushRef,
}) {
  const { data, isLoading, isError } = useVisitAdvice(visitId);
  const save = useSaveAdvice(visitId);
  const [advice, setAdvice] = useState(null);
  const [savedText, setSavedText] = useState(null);
  const [search, setSearch] = useState("");
  const latestAdvice = useRef(null);
  const appliedRestore = useRef(false);

  useEffect(() => {
    if (data && savedText === null) {
      setSavedText(data.advice || "");
      setAdvice(data.advice || "");
    }
  }, [data, savedText]);

  useEffect(() => {
    if (appliedRestore.current || savedText === null || restored?.advice === undefined) return;
    appliedRestore.current = true;
    latestAdvice.current = restored.advice;
    setAdvice(restored.advice);
  }, [restored, savedText]);

  const editAdvice = (value) => {
    latestAdvice.current = value;
    setAdvice(value);
    writeDraftField(visitId, "advice", value);
  };

  const dirty = advice !== null && savedText !== null && advice !== savedText;
  useEffect(() => {
    onUnsaved?.("advice", dirty);
  }, [dirty, onUnsaved]);
  useEffect(() => () => onUnsaved?.("advice", false), [onUnsaved]);

  const sendAdvice = (text) =>
    save.mutate(text, {
      onSuccess: () => {
        setSavedText(text);
        if (latestAdvice.current === null || latestAdvice.current === text) {
          clearDraftField(visitId, "advice");
        }
      },
      onError: (e) =>
        onToast(e?.response?.data?.error || "Advice not saved — keep typing to retry"),
    });

  if (flushRef) {
    flushRef.current = () => {
      if (dirty && !readOnly && !save.isPending) sendAdvice(advice);
    };
  }

  useEffect(() => {
    if (!dirty || readOnly) return undefined;
    const timer = setTimeout(() => sendAdvice(advice), 800);
    return () => clearTimeout(timer);
  }, [advice, dirty, readOnly]);

  const written = new Set((advice || "").split(/\n+/).map(norm).filter(Boolean));
  const words = norm(search).split(" ").filter(Boolean);
  const matching = (data?.common || []).filter(
    (c) => !written.has(norm(c.line)) && words.every((word) => norm(c.line).includes(word)),
  );
  const suggestions = words.length ? matching : matching.slice(0, TOP_SHOWN);

  const addLine = (line) => {
    const text = (advice || "").replace(/\s+$/, "");
    editAdvice(text ? `${text}\n${line}` : line);
  };

  return (
    <section className="csec" id="s-advice">
      <div className="cs-head">
        <h2>💬 Advice</h2>
        <span className="cs-sub">
          printed on the prescription after the medicines · one per line
        </span>
      </div>

      {isLoading && <div className="cn-empty">Loading advice…</div>}
      {isError && <div className="cn-empty">Advice could not be loaded.</div>}

      {!isLoading && !isError && (
        <>
          <label className="cp-lab" htmlFor={`cp-advice-${visitId}`}>
            General advice
          </label>
          <textarea
            id={`cp-advice-${visitId}`}
            className="cp-text"
            rows={4}
            value={advice ?? ""}
            readOnly={readOnly}
            placeholder="e.g. Follow treatment plan&#10;Self monitoring of blood glucose and blood pressure"
            onChange={(e) => editAdvice(e.target.value)}
          />
          <div className="cs-sub" aria-live="polite">
            {readOnly ? "" : save.isPending ? "Saving…" : dirty ? "Unsaved" : advice ? "Saved" : ""}
          </div>

          {!readOnly && (
            <>
              <div className="cn-head">Common advice — tap to add</div>
              <div className="tst-heard">
                <input
                  type="search"
                  className="cp-inp tst-filter"
                  value={search}
                  placeholder="Search advice — e.g. diet, steps, blood pressure"
                  aria-label="Search advice"
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSearch("");
                  }}
                />
              </div>
              <div className="tst-list">
                {suggestions.map((c) => (
                  <button
                    type="button"
                    key={c.line}
                    className="tst-chip"
                    onClick={() => addLine(c.line)}
                  >
                    <span className="tst-name">{c.line}</span>
                  </button>
                ))}
                {suggestions.length === 0 && (
                  <div className="cn-empty">
                    {search ? "No advice matches — type it in the box above." : "All added."}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
