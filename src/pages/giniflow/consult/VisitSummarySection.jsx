import { useEffect } from "react";
import { useGenerateVisitSummary, useVisitSummary } from "../../../queries/hooks/useRxParameters";
import "./rxParameters.css";

export default function VisitSummarySection({
  visitId,
  onToast,
  station = "doctor",
  readOnly = false,
}) {
  const { data, isLoading, isError, refetch } = useVisitSummary(visitId, station);
  const generate = useGenerateVisitSummary(visitId, station);

  useEffect(() => {
    if (station === "mo") refetch();
  }, [readOnly, station, refetch]);
  const paragraphs = String(data?.text || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const write = () =>
    generate.mutate(undefined, {
      onError: (e) => onToast?.(e?.response?.data?.error || "Could not write the visit summary."),
    });

  return (
    <section className="csec" id="s-visit-summary" aria-labelledby="visit-summary-title">
      <div className="cs-head">
        <h2 id="visit-summary-title">📝 Visit summary</h2>
        <span className="cs-sub">for explaining to the patient · not printed</span>
        <div className="cs-head-r">
          {data?.canGenerate && !readOnly && (
            <button type="button" className="btn-sm" disabled={generate.isPending} onClick={write}>
              {generate.isPending ? "Writing…" : paragraphs.length ? "Rewrite" : "Write summary"}
            </button>
          )}
        </div>
      </div>
      {isLoading ? (
        <p className="cn-empty">Loading…</p>
      ) : isError ? (
        <p className="cn-empty" role="alert">
          Couldn&apos;t load the visit summary.{" "}
          <button type="button" className="btn-sm" onClick={() => refetch()}>
            Try again
          </button>
        </p>
      ) : paragraphs.length ? (
        <div className="vsum-text">
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ) : (
        <p className="cn-empty">
          No summary yet. It is written when the prescription is saved, or press Write summary.
        </p>
      )}
    </section>
  );
}
