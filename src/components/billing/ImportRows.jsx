import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  DECISION_TEXT,
  OUTCOME_TEXT,
  STATUS_TEXT,
  TONE,
  labelOf,
  shown,
  typed,
} from "./importText";

function Badge({ value, text }) {
  return (
    <span className={`bill-src bill-import__status--${TONE[value] ?? value}`}>
      {labelOf(value, text)}
    </span>
  );
}

function Details({ row, parentLink }) {
  const errors = row.errors.length
    ? row.errors
    : row.reason
      ? [{ column: null, message: row.reason }]
      : [];
  const brief = Object.entries(row.input ?? {})
    .filter(([, text]) => text !== "" && text !== null && text !== undefined)
    .slice(0, 3);
  return (
    <ul className="bill-import__msgs">
      {errors.map((e, i) => (
        <li key={`e${i}`} className="bill-import__msg--error">
          {e.column ? <strong>{e.column}: </strong> : null}
          {e.message}
          {e.column && row.input?.[e.column] !== undefined ? (
            <span className="flow-muted"> · typed {typed(row.input[e.column])}</span>
          ) : null}
        </li>
      ))}
      {row.depends_on ? (
        <li>
          <Link className="bill-import__jump" to={parentLink(row.depends_on)}>
            Go to {row.depends_on.sheet} row {row.depends_on.row}
            {row.depends_on.key ? ` (${row.depends_on.key})` : ""}
          </Link>
        </li>
      ) : null}
      {row.changes.map((c) => (
        <li key={`c${c.column}`} className="bill-import__change">
          <strong>{c.column}: </strong>
          <span className="bill-import__from">{shown(c.from)}</span> →{" "}
          <span className="bill-import__to">{shown(c.to)}</span>
        </li>
      ))}
      {(row.warnings ?? []).map((w, i) => (
        <li key={`w${i}`} className="bill-import__msg--warning">
          {w.column ? <strong>{w.column}: </strong> : null}
          {w.message}
        </li>
      ))}
      {row.status === "ready" ? (
        <li className="flow-muted">
          {brief.map(([column, text]) => `${column}: ${text}`).join(" · ")}
        </li>
      ) : null}
    </ul>
  );
}

function Decision({ row, mayDecide, busy, onDecide }) {
  if (row.status !== "override") return null;
  const name = `${row.sheet} row ${row.row}`;
  return (
    <div className="bill-import__decision">
      <span className={`bill-import__decided bill-import__decided--${row.decision}`}>
        {labelOf(row.decision, DECISION_TEXT)}
      </span>
      {mayDecide ? (
        <span className="bill-import__choices" role="group" aria-label={`Decision for ${name}`}>
          <button
            type="button"
            className="flow-btn flow-btn-mini flow-btn-primary"
            aria-label={`Override ${name}`}
            aria-pressed={row.decision === "override"}
            disabled={busy || row.decision === "override"}
            onClick={() => onDecide([row.id], "override")}
          >
            Override
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-mini flow-btn-ghost"
            aria-label={`Keep ${name}`}
            aria-pressed={row.decision === "keep"}
            disabled={busy || row.decision === "keep"}
            onClick={() => onDecide([row.id], "keep")}
          >
            Keep
          </button>
          {row.decision !== "pending" ? (
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              aria-label={`Undo decision on ${name}`}
              disabled={busy}
              onClick={() => onDecide([row.id], "pending")}
            >
              Undo
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export default function ImportRows({
  rows,
  committed,
  mayDecide,
  busy,
  onDecide,
  highlight,
  parentLink,
}) {
  const jumped = useRef(null);
  useEffect(() => {
    if (!highlight || jumped.current === highlight) return;
    const target = document.getElementById(`import-row-${highlight}`);
    if (!target) return;
    jumped.current = highlight;
    target.scrollIntoView({ block: "center" });
  }, [highlight, rows]);

  return (
    <div className="fset__scroll fset__scroll--wide">
      <table className="flow-table bill-import__rows" aria-label="Import rows">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Code / name</th>
            <th scope="col">Status</th>
            {committed ? <th scope="col">Outcome</th> : null}
            <th scope="col">Details</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              id={`import-row-${row.id}`}
              className={row.id === highlight ? "bill-import__row--jump" : undefined}
              aria-current={row.id === highlight ? "true" : undefined}
            >
              <td>
                <div>{row.sheet}</div>
                <div className="flow-muted">row {row.row}</div>
              </td>
              <td className="bill-import__key">
                <strong>{row.key || "—"}</strong>
                {row.label ? <div className="flow-muted">{row.label}</div> : null}
              </td>
              <td>
                <Badge value={row.status} text={STATUS_TEXT} />
              </td>
              {committed ? (
                <td>{row.outcome ? <Badge value={row.outcome} text={OUTCOME_TEXT} /> : null}</td>
              ) : null}
              <td className="bill-import__details">
                <Details row={row} parentLink={parentLink} />
              </td>
              <td>
                <Decision
                  row={row}
                  mayDecide={mayDecide && !committed}
                  busy={busy}
                  onDecide={onDecide}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
