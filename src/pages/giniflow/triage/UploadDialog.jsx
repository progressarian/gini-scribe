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

// Identity as it appears on the report, for the confirm step to show back.
// `patient_on_report` carries four fields and the match used to read one — age,
// sex and the lab's own patient id were extracted, stored, and never looked at.
const reportIdentity = (extracted) => {
  const on = extracted?.patient_on_report || {};
  const ageDigits = String(on.age ?? "").match(/\d{1,3}/);
  return {
    name: String(on.name || "").trim(),
    age: ageDigits ? Number(ageDigits[0]) : null,
    sex: (String(on.sex || "").trim()[0] || "").toUpperCase() || null,
    fileNo: String(on.patient_id || "").trim(),
  };
};

const sameFileNo = (a, b) =>
  !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// What disagrees between the report and the patient it is about to be saved to.
// Never used to REJECT — a lab that prints no age, or prints it as "71 Y", must
// not block a correct save — only to say what does not line up, so a wrong
// match stops looking like a right one.
const disagreements = (identity, card) => {
  const out = [];
  if (identity.age != null && card.age != null && Math.abs(identity.age - Number(card.age)) > 1) {
    out.push(`age ${identity.age} on the report, ${card.age} on the chart`);
  }
  const cardSex = (String(card.sex || "")[0] || "").toUpperCase();
  if (identity.sex && cardSex && identity.sex !== cardSex) {
    out.push(`sex ${identity.sex} on the report, ${cardSex} on the chart`);
  }
  if (identity.fileNo && card.fileNo && !sameFileNo(identity.fileNo, card.fileNo)) {
    out.push(`file no ${identity.fileNo} on the report, ${card.fileNo} on the chart`);
  }
  return out;
};

// What the report could be about, and whether anything actually IDENTIFIES it.
//
// A name is not an identifier. Two Kapil Devs sit on today's list; two Sudesh
// Balas have appeared on one day before now; and adding age and sex narrows the
// field without ever closing it — two 66-year-old men called Singh is an
// ordinary Tuesday here, not a corner case. So a name match, however well it
// corroborates, is a SHORTLIST and never an answer.
//
// The only thing that identifies is the file number, and only when the name
// agrees with it. Everything else is offered for a human to choose from with
// nothing pre-selected, because the cost of choosing is three seconds and the
// cost of a silent wrong choice is one patient's HbA1c on another patient's
// chart, a category set from it, and a consultant reading it as fact.
//
// Scoped to the day's own list, never the whole directory, so it can only ever
// offer someone who is actually coming.
const rankCandidates = (identity, cards) => {
  const needle = normalise(identity.name);
  const words = needle.split(" ").filter((w) => w.length > 2);
  const nameShares = (card) => {
    const hay = normalise(card.name);
    return !!needle && (hay === needle || words.some((w) => hay.includes(w)));
  };

  // Identified: the file number is on the list AND the name does not contradict
  // it. `patient_id` on a lab report is often the LAB's own accession number
  // rather than ours, so a bare number agreeing with nothing is not proof.
  if (identity.fileNo) {
    const byFile = cards.find((c) => sameFileNo(c.fileNo, identity.fileNo));
    if (byFile) {
      return nameShares(byFile) || !needle
        ? {
            identified: {
              card: byFile,
              confidence: "file_no",
              mismatches: disagreements(identity, byFile),
            },
            candidates: [],
          }
        : // The number points at one patient and the name at another. That is a
          // contradiction, not a detail — offer nothing and let a human read it.
          { identified: null, candidates: [], contradiction: byFile };
    }
  }

  if (needle.length < 4) return { identified: null, candidates: [] };

  // Otherwise: a shortlist, best first, nothing chosen.
  const scored = cards
    .map((card) => {
      const hay = normalise(card.name);
      let score = 0;
      if (hay === needle) score += 100;
      else if (words.length && words.every((w) => hay.includes(w))) score += 60;
      else if (words.some((w) => hay.includes(w))) score += 25;
      if (!score) return null;
      const bad = disagreements(identity, card);
      // Corroboration raises a candidate up the list; it never promotes one to
      // an answer.
      if (identity.age != null && card.age != null && !bad.some((m) => m.startsWith("age")))
        score += 15;
      if (identity.sex && card.sex && !bad.some((m) => m.startsWith("sex"))) score += 10;
      score -= bad.length * 20;
      return { card, score, mismatches: bad };
    })
    .filter(Boolean)
    .sort((x, y) => y.score - x.score)
    .slice(0, 6);

  return { identified: null, candidates: scored };
};

const MATCH_WORDS = {
  file_no: "Matched on the file number printed on the report",
  exact: "Matched on an exact name",
  partial: "Matched on a partial name — not an exact match",
  chosen: "You picked this patient",
};

const describeIdentity = (identity) =>
  [identity.age != null ? `${identity.age}` : null, identity.sex, identity.fileNo]
    .filter(Boolean)
    .join(" · ");

const describeCard = (card) =>
  [
    card.age != null ? `${card.age}` : null,
    (String(card.sex || "")[0] || "").toUpperCase(),
    card.fileNo,
  ]
    .filter(Boolean)
    .join(" · ");

// Green only when the report and the chart agree on everything they both state.
const matchTone = (match) =>
  match.confidence === "file_no" && !match.mismatches?.length
    ? "ok"
    : match.confidence === "exact" && !match.mismatches?.length
      ? "ok"
      : "warn";

export default function UploadDialog({ card, cards, onClose, onSaved }) {
  const preLocked = !!card;
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [extracted, setExtracted] = useState(null);
  const [match, setMatch] = useState(card ? { card, confidence: "locked" } : null);
  // The shortlist a name produced, and the patient a file number contradicted.
  // Held apart from `match` on purpose: a candidate is something to choose
  // from, not something chosen.
  const [candidates, setCandidates] = useState([]);
  const [contradiction, setContradiction] = useState(null);
  const [confirmed, setConfirmed] = useState(preLocked);
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // What the report claims about who it belongs to, shown beside who it is
  // about to be saved to.
  const identity = useMemo(() => reportIdentity(extracted), [extracted]);

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
        const ranked = rankCandidates(reportIdentity(data), cards || []);
        // Only a file number identifies. A name match fills the shortlist and
        // leaves `match` null, so nothing is pre-selected and Save stays off
        // until a human points at somebody.
        setMatch(ranked.identified);
        setCandidates(ranked.candidates);
        setContradiction(ranked.contradiction || null);
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
              {/* Both sides, always. Showing only the proposed patient meant a
                  coordinator working through thirty PDFs read "Kapil Dev —
                  confirm?" against a report saying Kapil Dev and agreed,
                  whichever of the two Kapil Devs it had picked. */}
              <div className="match-sides">
                <div className="ms-col">
                  <span className="ms-lbl">The report says</span>
                  <span className="ms-val">{identity.name || "no name on the report"}</span>
                  <span className="ms-sub">{describeIdentity(identity) || "no other details"}</span>
                </div>
                <span className="ms-arrow" aria-hidden="true">
                  →
                </span>
                <div className="ms-col">
                  <span className="ms-lbl">Save to</span>
                  <span className="ms-val">{match ? match.card.name : "— not chosen —"}</span>
                  <span className="ms-sub">
                    {match
                      ? describeCard(match.card) || "no other details"
                      : "pick a patient below"}
                  </span>
                </div>
              </div>

              {match ? (
                <div className={`match-row${matchTone(match) === "ok" ? "" : " warn"}`}>
                  {MATCH_WORDS[match.confidence] || "Matched"} — confirm this is correct.
                  {match.mismatches?.length > 0 && (
                    <div className="ms-warn">
                      ⚠ {match.mismatches.join("; ")}. Check the report before saving.
                    </div>
                  )}
                </div>
              ) : contradiction ? (
                <div className="match-row warn">
                  File no <strong>{identity.fileNo}</strong> on this day is{" "}
                  <strong>{contradiction.name}</strong>, but the report is named{" "}
                  <strong>{identity.name}</strong>. Those disagree, so nothing has been chosen —
                  read the report and pick below.
                </div>
              ) : candidates.length > 0 ? (
                /* Named, not chosen. A name is not an identifier — this day's
                   list has two Kapil Devs — so the screen offers who it could
                   be and a person decides. Save stays off until they do. */
                <div className="match-row warn">
                  {candidates.length === 1
                    ? "One patient on this day has a name like the report's."
                    : `${candidates.length} patients on this day have names like the report's.`}{" "}
                  A name is not proof of identity — pick the right one.
                </div>
              ) : (
                <div className="match-row warn">
                  No patient on this day matches
                  {identity.name ? ` "${identity.name}"` : " the name on the report"}
                  {identity.fileNo ? ` or file no ${identity.fileNo}` : ""}. Search for them below.
                </div>
              )}

              {!match && candidates.length > 0 && (
                <>
                  <p className="dlg-label">Could be</p>
                  {candidates.map((c) => (
                    <button
                      type="button"
                      key={c.card.visitId}
                      className="sd-opt"
                      onClick={() => {
                        setMatch({ card: c.card, confidence: "chosen", mismatches: c.mismatches });
                        setConfirmed(false);
                      }}
                    >
                      <span className="sd-info">
                        <span className="sd-name">{c.card.name}</span>
                        <span className="sd-detail">
                          {describeCard(c.card) || "no details"} · {c.card.slot || "no slot"}
                          {c.mismatches.length > 0 && (
                            <em className="sd-bad"> · ⚠ {c.mismatches.join("; ")}</em>
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                </>
              )}

              <p className="dlg-label">{candidates.length > 0 ? "Or search" : "Patient"}</p>
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
