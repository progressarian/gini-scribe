import { useMemo, useState } from "react";
import PdfViewerModal from "../visit/PdfViewerModal";

const COLLAPSED = 3;

const dateOf = (r) => r.doc_date || (r.created_at || "").slice(0, 10);

const toDoc = (r) => ({
  id: r.id,
  title: r.title || r.doc_type || "Report",
  file_name: r.file_name || `${r.doc_type || "report"}.pdf`,
  mime_type: r.mime_type,
});

function Row({ report, today, onOpen }) {
  return (
    <button type="button" className={`lrep${today ? " is-today" : ""}`} onClick={onOpen}>
      <span className="lr-ico">🧪</span>
      <span className="lr-t">
        <strong>{report.title || report.doc_type}</strong>
        <em>{dateOf(report) || "—"}</em>
      </span>
      <span className="lr-go">View →</span>
    </button>
  );
}

export default function ReportsList({ reports = [], visitDate, empty = "No documents on file." }) {
  const [viewingDoc, setViewingDoc] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const { today, earlier } = useMemo(() => {
    const t = [];
    const e = [];
    for (const r of reports) (visitDate && dateOf(r) === visitDate ? t : e).push(r);
    return { today: t, earlier: e };
  }, [reports, visitDate]);

  const shownEarlier = expanded ? earlier : earlier.slice(0, COLLAPSED);
  const hidden = earlier.length - shownEarlier.length;

  if (!reports.length) return <div className="cn-empty">{empty}</div>;

  return (
    <div className="lreports">
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}

      {today.length > 0 && (
        <>
          <div className="lrep-grp">🟢 Today&apos;s visit ({today.length})</div>
          {today.map((r) => (
            <Row key={r.id} report={r} today onOpen={() => setViewingDoc(toDoc(r))} />
          ))}
        </>
      )}

      {earlier.length > 0 && (
        <>
          {today.length > 0 && <div className="lrep-grp">Earlier ({earlier.length})</div>}
          {shownEarlier.map((r) => (
            <Row key={r.id} report={r} onOpen={() => setViewingDoc(toDoc(r))} />
          ))}
          {(hidden > 0 || expanded) && (
            <button type="button" className="lrep-more" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show fewer" : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
