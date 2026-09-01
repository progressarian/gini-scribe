import TriageCard from "./TriageCard";

// One category, its lead line and its patients. The right-hand column is the
// one that pays for the screen — `no_reports` is the list of people who will
// otherwise arrive and waste a consultation, so its empty state says so rather
// than reading as "nothing to do" (§4.2).

const EMPTY_TEXT = {
  no_reports: "Everyone on this day has numbers on file.",
  in_control: "Nobody is at target yet.",
};

export default function TriageColumn({ column, onAssign, onUpload, onOpen, busyId }) {
  return (
    <section className={`tcol tcol-${column.tone}`} aria-label={column.label}>
      <header className="tc-head">
        <div>
          <div className="tc-title">
            {column.icon} {column.short}
          </div>
          <div className="tc-sub">{column.lead}</div>
        </div>
        <div className="tc-count">{column.count}</div>
      </header>
      <div className="tc-body">
        {column.cards.length === 0 ? (
          <div className="tc-empty">{EMPTY_TEXT[column.key] || "No patients in this column."}</div>
        ) : (
          column.cards.map((card) => (
            <TriageCard
              key={card.visitId}
              card={card}
              onAssign={onAssign}
              onUpload={onUpload}
              onOpen={onOpen}
              busy={busyId === card.visitId}
            />
          ))
        )}
      </div>
    </section>
  );
}
