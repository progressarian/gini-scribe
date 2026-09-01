import { useEffect, useMemo, useRef, useState } from "react";
import api from "../../../services/api";
import { extractLab } from "../../../services/extraction";

// Getting a report onto a patient before the day starts.
//
// It reuses the existing document pipeline — create the document row, upload
// the file, PATCH the extraction, which is what cascades into `lab_results`,
// vitals and biomarkers — rather than being a third upload path (§9). The
// biomarkers it lands on are exactly what the triage engine reads, so a report
// saved here re-colours the board on the next sweep.
//
// Two entry points, and the difference between them is the whole safety story:
//
//   · from a card — the patient is PRE-LOCKED, no matching needed
//   · from the filter bar — nothing is known, so the extraction's own reading
//     of the name is matched against the day's list and must be CONFIRMED
//
// An auto-matched report saved to the wrong patient is the worst thing this
// screen can produce, so the global path never saves without a confirmation.

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });

const normalise = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();

// Name match against the day's own list — never the whole patient directory.
// Scoped that way it can only ever propose someone who is actually coming.
const matchCandidate = (name, cards) => {
  const needle = normalise(name);
  if (needle.length < 4) return null;
  const exact = cards.find((c) => normalise(c.name) === needle);
  if (exact) return { card: exact, confidence: "exact" };
  const parts = needle.split(" ").filter((p) => p.length > 2);
  const partial = cards.filter((c) => {
    const hay = normalise(c.name);
    return parts.length > 0 && parts.every((p) => hay.includes(p));
  });
  return partial.length === 1 ? { card: partial[0], confidence: "partial" } : null;
};

export default function UploadDialog({ card, cards, onClose, onSaved }) {
  const preLocked = !!card;
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [extracted, setExtracted] = useState(null);
  const [match, setMatch] = useState(card ? { card, confidence: "locked" } : null);
  const [confirmed, setConfirmed] = useState(preLocked);
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const rows = useMemo(() => {
    if (!extracted?.panels) return [];
    return extracted.panels.flatMap((p) =>
      (p.tests || []).map((t) => ({
        name: t.test_name,
        value: t.result ?? t.result_text ?? "—",
        unit: t.unit || "",
      })),
    );
  }, [extracted]);

  const searchResults = useMemo(() => {
    const q = normalise(query);
    if (q.length < 2) return [];
    return (cards || [])
      .filter(
        (c) =>
          normalise(c.name).includes(q) ||
          (c.fileNo || "").toLowerCase().includes(query.trim().toLowerCase()),
      )
      .slice(0, 6);
  }, [query, cards]);

  const pick = async (chosen) => {
    setError(null);
    setBusy("Reading the report…");
    try {
      const base64 = await readFile(chosen);
      setFile({ name: chosen.name, mediaType: chosen.type || "application/pdf", base64 });
      setBusy("Extracting values…");
      const { data, error: err } = await extractLab(base64, chosen.type || "application/pdf");
      if (err || !data) throw new Error(err || "Nothing could be read from that file");
      setExtracted(data);
      if (!preLocked) {
        const found = matchCandidate(data?.patient_on_report?.name, cards || []);
        setMatch(found);
        setConfirmed(false);
      }
    } catch (e) {
      setError(e.message || "Extraction failed");
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!match?.card || !file || !extracted) return;
    setBusy("Saving…");
    setError(null);
    try {
      const reportDate = extracted.report_date || extracted.collection_date || null;
      const { data: doc } = await api.post(`/api/patients/${match.card.patientId}/documents`, {
        doc_type: "lab_report",
        title: `Lab report — ${file.name}`,
        file_name: file.name,
        doc_date: reportDate,
        source: "upload_triage",
        extracted_data: extracted,
        notes: `${rows.length} tests extracted · added from the triage board`,
      });
      if (doc?.id) {
        await api.post(`/api/documents/${doc.id}/upload-file`, {
          base64: file.base64,
          mediaType: file.mediaType,
          fileName: file.name,
        });
        // The PATCH is what cascades into lab_results and the biomarkers the
        // triage engine reads — without it the file is stored and the board
        // still says "no reports".
        await api.patch(`/api/documents/${doc.id}`, { extracted_data: extracted });
      }
      onSaved(match.card.name);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Save failed");
      setBusy("");
    }
  };

  return (
    <div
      className="tmodal open"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="tbox" role="dialog" aria-label="Upload a report">
        <div className="tb-hd">
          <div>
            <div className="tb-name">Upload a report</div>
            <div className="tb-meta">
              {preLocked
                ? `For ${card.name} · ${card.fileNo} — no matching needed`
                : "The patient is confirmed against this day's list before anything is saved"}
            </div>
          </div>
          <button className="tb-cls" onClick={onClose} aria-label="Close" disabled={!!busy}>
            ✕
          </button>
        </div>

        <div className="tb-body">
          {error && <div className="dlg-err">{error}</div>}

          {preLocked && (
            <div className="match-row">
              📌 Uploading for <strong>{card.name}</strong> · {card.fileNo}
            </div>
          )}

          <button
            type="button"
            className="upload-zone"
            onClick={() => inputRef.current?.click()}
            disabled={!!busy}
          >
            {busy ||
              (file
                ? `📄 ${file.name} — choose a different file`
                : "📤 Choose a PDF or photo of the report")}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            hidden
            onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
          />

          {!preLocked && extracted && (
            <>
              {match ? (
                <div className={`match-row${match.confidence === "partial" ? " warn" : ""}`}>
                  Auto-matched: <strong>{match.card.name}</strong> · {match.card.fileNo} — confirm
                  this is correct.
                  {match.confidence === "partial" &&
                    " The name on the report is not an exact match."}
                </div>
              ) : (
                <div className="match-row warn">
                  No patient on this day matches
                  {extracted?.patient_on_report?.name
                    ? ` "${extracted.patient_on_report.name}"`
                    : " the name on the report"}
                  . Search for them below.
                </div>
              )}
              <p className="dlg-label">Patient</p>
              <input
                className="tri-input"
                style={{ width: "100%", marginBottom: 8 }}
                placeholder="Search this day's patients by name or file no…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {searchResults.map((c) => (
                <button
                  type="button"
                  key={c.visitId}
                  className={`sd-opt${match?.card?.visitId === c.visitId ? " sel" : ""}`}
                  onClick={() => {
                    setMatch({ card: c, confidence: "chosen" });
                    setConfirmed(false);
                  }}
                >
                  <span className="sd-info">
                    <span className="sd-name">{c.name}</span>
                    <span className="sd-detail">
                      {c.fileNo} · {c.age}
                      {(c.sex || "")[0] || ""} · {c.slot || "no slot"}
                    </span>
                  </span>
                </button>
              ))}
              {match && (
                <label
                  className="dlg-note"
                  style={{ display: "flex", gap: 7, alignItems: "flex-start", marginTop: 8 }}
                >
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    Yes — this report belongs to <strong>{match.card.name}</strong>.
                  </span>
                </label>
              )}
            </>
          )}

          {rows.length > 0 && (
            <>
              <p className="dlg-label">
                {rows.length} value{rows.length === 1 ? "" : "s"} read — check before saving
              </p>
              <div className="extract-list">
                {rows.map((r, i) => (
                  <div className="extract-row" key={`${r.name}-${i}`}>
                    <span>{r.name}</span>
                    <span>
                      {r.value} {r.unit}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="cf-actions">
            <button className="btn btn-g" onClick={onClose} disabled={!!busy}>
              Cancel
            </button>
            <button
              className="btn btn-tl"
              disabled={!extracted || !match?.card || !confirmed || !!busy}
              onClick={save}
            >
              {busy === "Saving…" ? "Saving…" : "Save to the chart"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
