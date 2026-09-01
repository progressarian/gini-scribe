// One patient on the day before their visit: are their reports in, what do the
// numbers say, who is going to see them.
//
// docs/gini-flow/18-TRIAGE-BOARD-PLAN.md §4.3. Every block below is omitted
// rather than rendered empty — a card of placeholders is harder to read than a
// short one, and the pre-visit boxes in particular are only shown when the
// patient actually wrote something.

const REPORT_ICON = { ok: "📊", partial: "⚠", missing: "📭" };

const BioChip = ({ chip }) => (
  <span className={`bio-chip bc-${chip.tone}`} title={`${chip.label} — target ${chip.status}`}>
    {chip.previous !== null && chip.previous !== undefined && (
      <>
        <span className="bio-prev">{chip.previous}</span>
        <span className="bio-arr">→</span>
      </>
    )}
    <span className="bio-cur">{chip.value}</span>
    <span className="bio-name">{chip.label}</span>
  </span>
);

export default function TriageCard({ card, onAssign, onUpload, onOpen, busy }) {
  const { report, compliance, assignment } = card;

  return (
    <article className="pt-card">
      <div className="pc-top">
        <div>
          <div className="pc-name">{card.name}</div>
          <div className="pc-id">
            {card.age ?? "—"}
            {(card.sex || "")[0] || ""} · {card.fileNo || "no file no"}
          </div>
        </div>
        <div className="pc-slot">{card.slot || "—"}</div>
      </div>

      <div className="pc-row">
        {/* Never both: once they are in the building the call no longer
            matters, which is the notes' own rule. */}
        {card.arrived ? (
          <span className="pill pill-arrived">✓ Checked in</span>
        ) : (
          card.confirmation && (
            <span
              className={`pill pill-${card.confirmation.tone}`}
              title={`Call status: ${card.confirmation.statusLabel}`}
            >
              Appt: {card.confirmation.text}
            </span>
          )
        )}
        <span className="pill pill-ink">
          {card.isNewPatient ? "New patient · Visit 1" : `Visit ${card.visitNumber}`}
        </span>
        {card.categorySource === "coordinator" && (
          <span
            className="pill pill-ink"
            title={`Set by ${card.categorySetBy || "a coordinator"} — the auto sweep will not overwrite it`}
          >
            ✋ Set by hand
          </span>
        )}
      </div>

      <div className="pc-dates">
        <span>
          📅 Report:{" "}
          <strong>
            {report.addedLabel ? `${report.addedLabel} · ${report.source}` : "none yet"}
          </strong>
        </span>
        <span>
          🩺 Last visit: <strong>{card.lastVisitLabel || "first visit"}</strong>
        </span>
      </div>

      <div className={`pc-rep rep-${report.state}`}>
        <span>{REPORT_ICON[report.state]}</span>
        <span className="rep-text">{report.text}</span>
        <button type="button" className="rep-up" onClick={() => onUpload(card)}>
          Upload
        </button>
      </div>

      {card.bios.length > 0 && (
        <div className="pc-bios">
          {card.bios.map((chip) => (
            <BioChip key={chip.key} chip={chip} />
          ))}
        </div>
      )}

      <div className={`pc-comp comp-${compliance.tone}`}>
        <span>💊</span>
        <span className="comp-pct">{compliance.known ? `${compliance.pct}%` : "—"}</span>
        <div className="comp-bar">
          <div
            className="comp-fill"
            style={{ width: `${compliance.known ? compliance.pct : 0}%` }}
          />
        </div>
        <span className="comp-lbl">
          {!compliance.known
            ? card.isNewPatient
              ? "New — no history"
              : "Not reported"
            : compliance.pct < 60
              ? "Low — missed doses"
              : compliance.pct <= 80
                ? "Partial"
                : "Good"}
        </span>
      </div>

      {card.question && (
        <div className="pc-note note-q">
          <span>❓</span>
          <span>{card.question}</span>
        </div>
      )}
      {card.symptoms.length > 0 && (
        <div className="pc-note note-s">
          <span>🔴</span>
          <span>Pre-visit: {card.symptoms.join(" · ")}</span>
        </div>
      )}
      {card.lifestyleFlagged && (
        <div className="pc-note note-l">
          <span>🥗</span>
          <span>Lifestyle concern flagged — see the intake for details</span>
        </div>
      )}
      {/* A suggestion, never an automatic assignment (§5). The coordinator
          still presses Assign. */}
      {card.routing.map((rule) => (
        <div className="pc-note note-r" key={rule.label}>
          <span>{rule.icon}</span>
          <span>
            <strong>{rule.label}</strong> — {rule.suggest}
          </span>
        </div>
      ))}

      <div className="pc-actions">
        {assignment.assigned ? (
          <span className="assign-tag at-ok">
            → {assignment.doctorName || assignment.sdName}
            {assignment.doctorName && assignment.sdName ? ` · SD ${assignment.sdName}` : ""}
          </span>
        ) : (
          <span className="assign-tag at-none">⏳ Unassigned</span>
        )}
        <button
          type="button"
          className={`pc-btn ${assignment.assigned ? "" : "tl"}`}
          onClick={() => onAssign(card)}
          disabled={busy}
        >
          {assignment.assigned ? "↺ Change" : "+ Assign"}
        </button>
        <button type="button" className="pc-btn push" onClick={() => onOpen(card)}>
          ↗ Open
        </button>
      </div>
    </article>
  );
}
