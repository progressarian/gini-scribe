import { useEffect, useRef, useState } from "react";
import { useDictation } from "../../hooks/useDictation";

// The microphone the consult screen puts in six places
// (docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md §4b).
//
// It DICTATES. It does not execute. The prototype's examples read like
// commands — "Stop Montair", "Order diabetes panel" — and parsing those into
// prescribing actions is §4b step 3, gated behind a confirmation layer that
// does not exist yet. Until it does, speech puts words where the consultant can
// see and edit them, which is the honest half of the feature and the useful one.
//
// Nothing reaches the form until the speaker says so: a recogniser mishears
// names and doses constantly, and the words it heard are the last place they
// can be corrected cheaply. The caption stops being a read-out and becomes a
// text box the moment recording stops.
//
// `.voice-pill` is the vitals station's control, unchanged: purple pill, 20px
// radius, 11px/600 — the same button the prototype draws as `.vbtn`.

export function VoiceButton({ label = "🎤", small = false, onText, title, review = true }) {
  const [draft, setDraft] = useState(null);
  const boxRef = useRef(null);
  const dictation = useDictation({
    onTranscript: (text) => (review ? setDraft(text) : onText?.(text)),
  });

  useEffect(() => {
    if (draft !== null) boxRef.current?.focus();
  }, [draft !== null]);

  const accept = () => {
    const text = (draft || "").trim();
    setDraft(null);
    dictation.clear();
    if (text) onText?.(text);
  };

  const discard = () => {
    setDraft(null);
    dictation.clear();
  };

  return (
    <>
      <button
        type="button"
        className={`voice-pill${small ? " vp-sm" : ""}${dictation.listening ? " listening" : ""}`}
        onClick={dictation.toggle}
        disabled={dictation.busy}
        title={title}
      >
        {dictation.busy ? "Reading back…" : dictation.listening ? "◼ Stop" : label}
      </button>
      {draft === null && (dictation.listening || dictation.caption) && (
        <div className={`caption${dictation.listening ? " live" : ""}`}>
          {dictation.listening && <span className="cap-dot" />}
          <span className="cap-text">
            {dictation.caption ||
              (dictation.live ? "Listening…" : "Recording — press Stop when done")}
          </span>
        </div>
      )}
      {draft !== null && (
        <div className="vrev">
          <div className="vrev__head">
            ✏️ Heard this — edit anything it got wrong, then add it
            <em>Ctrl+Enter to add · Esc to discard</em>
          </div>
          <textarea
            ref={boxRef}
            className="vrev__text"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") discard();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) accept();
            }}
          />
          <div className="vrev__acts">
            <button type="button" className="btn-sm on" onClick={accept} disabled={!draft.trim()}>
              ✓ Add this
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                setDraft(null);
                dictation.clear();
                dictation.start();
              }}
            >
              🎤 Say it again
            </button>
            <button type="button" className="btn-sm" onClick={discard}>
              Discard
            </button>
          </div>
        </div>
      )}
      {dictation.error && <div className="voice-note voice-err">⚠ {dictation.error}</div>}
    </>
  );
}

// The teaching bar above the medicines table. Its real job is that it is the
// only place the phrasing is written down — so the examples are the content,
// not decoration.
export function VoiceBar({ label = "🎤 Speak", examples = [], onText, hint }) {
  return (
    <div className="vbar">
      <VoiceButton label={label} onText={onText} title={hint} />
      <div className="vbar-t">
        {hint ? `${hint} ` : "Say: "}
        {examples.map((e, i) => (
          <span key={e}>
            {i > 0 && " · "}
            <em>&ldquo;{e}&rdquo;</em>
          </span>
        ))}
      </div>
    </div>
  );
}
