// Overview — gini-doctor-final.html `s-overview`.
//
// Three sources of concern, never merged (plan §6.1): a number from a machine, a
// sentence from the patient, and a change over time are different kinds of
// evidence, and a consultant weighs them differently.

const TONE_ICON = { red: "🔴", amber: "🟡", green: "✅" };

function ConcernBlock({ title, rows, empty }) {
  return (
    <div className="cn-block">
      <div className="cn-head">{title}</div>
      {rows.length === 0 && <div className="cn-empty">{empty}</div>}
      {rows.map((r, i) => (
        <div className="cn-row" key={`${r.key || r.title}-${i}`}>
          <span className="cn-ico">{TONE_ICON[r.tone] || "•"}</span>
          <span>
            <strong>{r.title}</strong>
            {r.detail ? ` — ${r.detail}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function OverviewSection({ consult, onTile }) {
  const { concerns, tiles, diagnoses, moPlan } = consult;
  const primary = diagnoses.filter((d) => d.category === "primary");
  const others = diagnoses.filter((d) => d.category !== "primary");

  return (
    <section className="csec" id="s-overview">
      <div className="cs-head">
        <h2>📋 Overview — visit {consult.visitNumber ?? "—"}</h2>
        <span className="cs-sub">today's concerns · key numbers · diagnoses</span>
      </div>

      {/* The MO's workup, read first and never edited here — the consultant is
          reading what another clinician concluded, not rewriting it. */}
      {moPlan?.plan && (
        <div className="mo-plan">
          <div className="cn-head">🩺 MO / SD plan{moPlan.author ? ` — ${moPlan.author}` : ""}</div>
          <p>{moPlan.plan}</p>
        </div>
      )}

      <div className="cn-grid">
        <ConcernBlock
          title="🧪 From reports"
          rows={concerns.reports}
          empty="No results to read yet."
        />
        <ConcernBlock
          title="💬 Patient reported"
          rows={concerns.patient}
          empty="Nothing recorded before this visit."
        />
        <ConcernBlock
          title="📅 Since last visit"
          rows={concerns.sinceLast}
          empty="No change recorded since the last visit."
        />
      </div>

      <div className="cs-head">
        <h3>Key numbers</h3>
        <span className="cs-sub">tap any for the trend</span>
      </div>
      <div className="ktiles">
        {tiles.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`ktile kt-${t.status}`}
            onClick={() => t.value != null && onTile(t)}
            disabled={t.value == null}
          >
            <div className="kt-val">
              {t.value ?? "—"}
              <span className="kt-unit">{t.unit}</span>
            </div>
            <div className="kt-lab">{t.label}</div>
            <div className="kt-delta">
              {t.previous == null
                ? "no previous reading"
                : t.movement === "worse"
                  ? `↑ worse — from ${t.previous}`
                  : t.movement === "better"
                    ? `↓ better — from ${t.previous}`
                    : `stable — was ${t.previous}`}
            </div>
          </button>
        ))}
      </div>

      <div className="cs-head">
        <h3>Diagnoses</h3>
        <span className="cs-sub">{diagnoses.length} active</span>
      </div>
      {diagnoses.length === 0 && <div className="cn-empty">No diagnoses recorded.</div>}
      {primary.length > 0 && (
        <>
          <div className="dx-group">Primary</div>
          <div className="dx-row">
            {primary.map((d) => (
              <span className="dx" key={d.diagnosis_id}>
                {d.label}
                {d.key_value && <em>{d.key_value}</em>}
              </span>
            ))}
          </div>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="dx-group">Complications &amp; comorbidities</div>
          <div className="dx-row">
            {others.map((d) => (
              <span className="dx" key={d.diagnosis_id}>
                {d.label}
                {d.key_value && <em>{d.key_value}</em>}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
