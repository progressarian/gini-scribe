import { useEffect, useState } from "react";
import {
  useLabResults,
  useTestNameSearch,
  useSaveLabResults,
} from "../../queries/hooks/useGiniflowLab";

// Typing the results in, instead of scanning them.
// docs/gini-flow/32-LAB-TYPED-RESULTS-PLAN.md
//
// The rows are prefilled from what this lab has actually reported before for the
// tests on the order — name, unit and reference range — and every one of them can
// be deleted or edited. The values land in lab_results, so the doctor sees them
// as ordinary labs: trended, flagged, comparable.

// The same rule the server applies, so the technician sees the flag their value
// will carry before they commit it to a patient's record — not afterwards.
const flagFor = (value, refRange) => {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  const raw = String(refRange || "").trim();
  const between = raw.match(/^([+-]?[\d.]+)\s*(?:-|–|—|to)\s*([+-]?[\d.]+)$/i);
  const above = raw.match(/^(?:>|>=|≥)\s*([+-]?[\d.]+)/);
  const below = raw.match(/^(?:<|<=|≤)\s*([+-]?[\d.]+)/);
  const min = between ? parseFloat(between[1]) : above ? parseFloat(above[1]) : null;
  const max = between ? parseFloat(between[2]) : below ? parseFloat(below[1]) : null;
  if (min == null && max == null) return null;
  if (min != null && n < min) return "LOW";
  if (max != null && n > max) return "HIGH";
  return null;
};

function AddRow({ onAdd }) {
  const [term, setTerm] = useState("");
  const { data: matches = [] } = useTestNameSearch(term);

  return (
    <div className="lr-add">
      <input
        className="ar-reason-input"
        placeholder="Add a test — start typing its name"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      {term.trim().length >= 2 && (
        <div className="lr-matches">
          {matches.map((m) => (
            <button
              key={m.canonicalName}
              type="button"
              className="lr-match"
              onClick={() => {
                onAdd({
                  testName: m.testName,
                  unit: m.unit || "",
                  refRange: m.refRange || "",
                  value: "",
                });
                setTerm("");
              }}
            >
              {m.testName}
              <span className="lr-match-meta">
                {m.unit || "—"} · {m.refRange || "no range"}
              </span>
            </button>
          ))}
          {/* The catalogue is history, and history has a first time for
              everything. A name nobody has reported before is still a result. */}
          <button
            type="button"
            className="lr-match"
            onClick={() => {
              onAdd({ testName: term.trim(), unit: "", refRange: "", value: "" });
              setTerm("");
            }}
          >
            Use “{term.trim()}” as typed
          </button>
        </div>
      )}
    </div>
  );
}

// A CBC with a KFT and an LFT prefills thirty-six rows, and a form that long is
// one nobody reads to the bottom. The first ten are on the screen; the rest of
// the order's own parameters are one pick away, which is also the honest shape —
// the lab types the handful it has values for, not every line it might.
const VISIBLE_ROWS = 10;

export default function LabResultsForm({ orderId, onSaved, onFailed }) {
  const { data, isLoading } = useLabResults(orderId);
  const save = useSaveLabResults();
  const [rows, setRows] = useState(null);
  // The order's remaining suggested parameters, offered in the picker below.
  const [rest, setRest] = useState([]);

  // Whatever has already been entered comes back for correcting; an order with
  // nothing on it yet opens on the suggested rows.
  useEffect(() => {
    if (!data || rows !== null) return;
    const entered = (data.results || []).map((r) => ({
      testName: r.testName,
      value: r.value ?? "",
      valueText: r.valueText || "",
      unit: r.unit || "",
      refRange: r.refRange || "",
      panelName: r.panelName || "",
    }));
    if (entered.length) {
      setRows(entered);
      return;
    }
    const suggested = (data.suggestions || []).flatMap((group) =>
      group.params.map((p) => ({
        testName: p.testName,
        value: "",
        valueText: "",
        unit: p.unit || "",
        refRange: p.refRange || "",
        panelName: group.test,
      })),
    );
    setRows(suggested.slice(0, VISIBLE_ROWS));
    setRest(suggested.slice(VISIBLE_ROWS));
  }, [data, rows]);

  const list = rows || [];
  const filled = list.filter((r) => String(r.value).trim() !== "" || r.valueText.trim() !== "");
  const patch = (i, next) => setRows(list.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  const submit = () =>
    save.mutate(
      { orderId, rows: filled },
      { onSuccess: (r) => onSaved?.(r), onError: (e) => onFailed?.(e) },
    );

  if (isLoading) return <div className="empty-note">Loading the results form…</div>;

  return (
    <div className="lr">
      <div className="lr-head">
        <span>Test</span>
        <span>Value</span>
        <span>Unit</span>
        <span>Reference</span>
        <span />
      </div>

      {list.map((row, i) => {
        const flag = flagFor(row.value, row.refRange);
        return (
          <div className="lr-row" key={`${row.testName}-${i}`}>
            <span className="lr-name">{row.testName}</span>
            <span className="lr-val">
              <input
                className="ar-reason-input"
                inputMode="decimal"
                placeholder="—"
                value={row.value}
                onChange={(e) => patch(i, { value: e.target.value })}
              />
              {/* Shown as they type: a value about to go on a patient's record
                  as HIGH should say so before it is saved, not after. */}
              {flag && <span className={`lr-flag lr-${flag.toLowerCase()}`}>{flag}</span>}
            </span>
            <input
              className="ar-reason-input lr-unit"
              placeholder="unit"
              value={row.unit}
              onChange={(e) => patch(i, { unit: e.target.value })}
            />
            <input
              className="ar-reason-input lr-ref"
              placeholder="range"
              value={row.refRange}
              onChange={(e) => patch(i, { refRange: e.target.value })}
            />
            <button
              type="button"
              className="jb-remove"
              title="Remove this test"
              onClick={() => {
                setRows(list.filter((_, idx) => idx !== i));
                // Back into the picker rather than gone: removing a row the desk
                // has no value for should not mean retyping its name and range
                // if the analyser prints it after all.
                if (row.panelName && !rest.some((r) => r.testName === row.testName)) {
                  setRest([...rest, { ...row, value: "", valueText: "" }]);
                }
              }}
            >
              ✕
            </button>
          </div>
        );
      })}

      {rest.length > 0 && (
        <select
          className="jb-add"
          value=""
          onChange={(e) => {
            const picked = rest.find((r) => r.testName === e.target.value);
            if (!picked) return;
            setRows([...list, picked]);
            setRest(rest.filter((r) => r.testName !== picked.testName));
          }}
        >
          <option value="">+ More from this order ({rest.length})</option>
          {rest.map((r) => (
            <option key={r.testName} value={r.testName}>
              {r.panelName ? `${r.panelName} · ` : ""}
              {r.testName}
              {r.unit ? ` (${r.unit})` : ""}
            </option>
          ))}
        </select>
      )}

      <AddRow onAdd={(row) => setRows([...list, { ...row, valueText: "", panelName: "" }])} />

      <div className="lr-foot">
        <button
          className="st-btn st-btn-grn btn-full"
          disabled={save.isPending || filled.length === 0}
          onClick={submit}
        >
          ✓ Save {filled.length || "no"} result{filled.length === 1 ? "" : "s"} — notify the MO
        </button>
        <span className="dp-hint">
          Empty rows are ignored. A report can still be attached below.
        </span>
      </div>
    </div>
  );
}
