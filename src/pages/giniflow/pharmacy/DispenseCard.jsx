import { useState } from "react";

// The medicine card with dispense controls — gini-stations.html #pharmPane.
//
// The SAME card the consultant sees (`buildCard`), rendered slot by slot with
// the clock time, plus one control per row. It does not compute the schedule
// again: four implementations of a dosing schedule would be four chances to
// tell a patient the wrong time (14 §5).

const NOT_GIVEN_REASONS = [
  "Out of stock",
  "Patient declined",
  "Brought from outside",
  "Already has stock at home",
];

const forLine = (m) => {
  if (m.note) return m.note;
  if (m.forDiagnosis?.length) return m.forDiagnosis.join(" · ");
  return m.medGroup || null;
};

const takeLine = (m) =>
  m.instruction ||
  (Array.isArray(m.whenToTake) ? m.whenToTake.join(", ") : m.whenToTake) ||
  m.timing;

const doseLine = (m) =>
  [m.dose, m.form, m.route, m.frequency]
    .map((v) => (v || "").trim())
    .filter(Boolean)
    .join(" · ");

function StockChip({ stock }) {
  // Absent, not "in stock": a row with no inventory entry is unknown, and a
  // false in-stock sends a patient to a counter that cannot serve them.
  if (!stock) return null;
  if (stock.out) return <span className="mm-stock out">✗ Out of stock</span>;
  if (stock.low) return <span className="mm-stock low">⚠ Low · {stock.qty} left</span>;
  return <span className="mm-stock">✓ {stock.qty} in stock</span>;
}

function MedicineRow({ medicine, onDispense, busy }) {
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const mark = medicine.collection;
  const alternative = medicine.stock?.out ? medicine.stock.alternatives?.[0] : null;

  const done = mark?.status === "given" || mark?.status === "partial";
  const refused = mark?.status === "not_given";

  const send = (status, why) => {
    onDispense(medicine, status, why);
    setAskingReason(false);
    setReason("");
  };

  return (
    <div
      className={`mc-med ph-med${medicine.external ? " mm-ext" : ""}${done ? " is-done" : ""}${
        refused ? " is-refused" : ""
      }${medicine.stock?.out ? " is-out" : ""}`}
    >
      <div className="mm-ico">{medicine.stock?.out ? "⚠️" : "💊"}</div>

      <div className="mm-body">
        <div className="mm-name">
          {medicine.name}
          {medicine.changeType === "new" && <span className="mm-new-tag">NEW this visit</span>}
          {medicine.changeType === "changed" && <span className="mm-chg-tag">Dose changed</span>}
          {medicine.external && <span className="mm-ext-tag">External</span>}
        </div>
        {doseLine(medicine) && <div className="mm-dose">{doseLine(medicine)}</div>}
        {forLine(medicine) && <div className="mm-for">🩺 For: {forLine(medicine)}</div>}
        {takeLine(medicine) && <div className="mm-instr">{takeLine(medicine)}</div>}
        {medicine.previousDose && medicine.changeType === "changed" && (
          <div className="mm-instr mm-was">Was {medicine.previousDose}</div>
        )}
        <div className={`mm-dr${medicine.external ? "" : " gini"}`}>
          {medicine.external
            ? `Prescribed by: ${medicine.prescriber || "another doctor"}`
            : "Prescribed by: Gini Health"}
        </div>
        {medicine.warning && (
          <div className={`mm-warn mm-warn-${medicine.warning.tone}`}>
            {medicine.name} — {medicine.warning.message}
          </div>
        )}
        {refused && <div className="mm-refused">Not given — {mark.reason}</div>}
      </div>

      <div className="mm-r">
        <StockChip stock={medicine.stock} />

        {/* External medicines get NO control. Shown because the patient takes
            them; not dispensed, and never recorded as dispensed. */}
        {!medicine.dispensable ? (
          <div className="mm-qty">External · not dispensed by Gini</div>
        ) : askingReason ? (
          <div className="mm-reason">
            {NOT_GIVEN_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                className="mm-reason-chip"
                onClick={() => send("not_given", r)}
              >
                {r}
              </button>
            ))}
            <input
              className="mm-reason-input"
              value={reason}
              placeholder="Other reason…"
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && reason.trim() && send("not_given", reason.trim())
              }
            />
            <button
              type="button"
              className="st-btn st-btn-g"
              onClick={() => setAskingReason(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={`dispense-btn${done ? " db-done" : ""}`}
              disabled={busy}
              onClick={() => send("given")}
            >
              {done
                ? "✓ Dispensed"
                : alternative
                  ? `Use ${alternative}`
                  : medicine.stock?.out
                    ? "Dispense anyway"
                    : "Dispense"}
            </button>
            <button
              type="button"
              className={`ph-refuse${refused ? " on" : ""}`}
              disabled={busy}
              onClick={() => setAskingReason(true)}
            >
              {refused ? "Change reason" : "Not given"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function DispenseCard({ card, onDispense, busy }) {
  if (!card?.groups?.length) {
    return (
      <div className="empty-note">
        No active medicines on this patient&apos;s card — nothing to dispense.
      </div>
    );
  }

  return (
    <div className="ph-card">
      {card.groups.map((group) => (
        <div className="mc-slot ph-slot" key={group.key}>
          <div className="mc-when">
            <strong>{group.label}</strong>
            {group.timeLabel && <em>{group.timeLabel}</em>}
          </div>
          <div className="mc-meds">
            {group.medicines.map((m) => (
              <MedicineRow key={m.medicationId} medicine={m} onDispense={onDispense} busy={busy} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
