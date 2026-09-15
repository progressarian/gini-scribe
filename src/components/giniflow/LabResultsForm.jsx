import { useEffect, useState } from "react";
import {
  useLabResults,
  useTestNameSearch,
  useSaveLabResults,
} from "../../queries/hooks/useGiniflowLab";
import { computeFormulas, flagFor as flagAgainstRange } from "../../../shared/labFormula";

// Typing the results in, instead of scanning them.
// docs/gini-flow/32-LAB-TYPED-RESULTS-PLAN.md
//
// The rows are prefilled from what this lab has actually reported before for the
// tests on the order — name, unit and reference range — and every one of them can
// be deleted or edited. The values land in lab_results, so the doctor sees them
// as ordinary labs: trended, flagged, comparable.

// A catalogue row is judged against HealthRay's own numbers; a hand-typed one
// still has only its printed range to go on.
const flagOf = (row) => {
  if (row.range) {
    const { flag, critical } = flagAgainstRange(row.value, row.range);
    return flag === "H"
      ? critical
        ? "CRITICAL"
        : "HIGH"
      : flag === "L"
        ? critical
          ? "CRITICAL"
          : "LOW"
        : null;
  }
  return flagFromText(row.value, row.refRange);
};

// The same rule the server applies, so the technician sees the flag their value
// will carry before they commit it to a patient's record — not afterwards.
const flagFromText = (value, refRange) => {
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

function splitCatalogRows(rows) {
  const required = [];
  const optional = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.depth > 0) {
      optional.push(row);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j].depth > 0) j++;
    const children = rows.slice(i + 1, j);
    if (row.isGroup) {
      const requiredChildren = children.filter((c) => c.required);
      if (requiredChildren.length) {
        required.push(row, ...requiredChildren);
      }
      optional.push(...children.filter((c) => !c.required));
    } else if (row.required) {
      required.push(row, ...children);
    } else {
      optional.push(row, ...children);
    }
    i = j;
  }
  return [required, optional];
}

export default function LabResultsForm({ orderId, caseNo, onSaved, onFailed }) {
  const { data, isLoading } = useLabResults({ orderId, caseNo });
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
        testId: p.testId || null,
        testName: p.testName,
        value: "",
        valueText: "",
        unit: p.unit || "",
        refRange: p.refRange || "",
        range: p.range || null,
        formula: p.formula || null,
        calculated: !!p.calculated,
        isGroup: !!p.isGroup,
        depth: p.depth || 0,
        locked: !!p.fromCatalog,
        required: p.required !== false,
        panelName: group.test,
      })),
    );
    const fromCatalog = suggested.filter((r) => r.locked);
    if (fromCatalog.length) {
      const [required, optional] = splitCatalogRows(fromCatalog);
      setRows(required);
      setRest(optional);
      return;
    }
    setRows(suggested.slice(0, VISIBLE_ROWS));
    setRest(suggested.slice(VISIBLE_ROWS));
  }, [data, rows]);

  const list = rows || [];
  const calculated = computeFormulas(
    list.filter((r) => r.testId).map((r) => ({ id: r.testId, formula: r.formula })),
    Object.fromEntries(list.filter((r) => r.testId && !r.formula).map((r) => [r.testId, r.value])),
  );
  const shown = list.map((r) => (r.formula ? { ...r, value: calculated[r.testId] ?? "" } : r));
  const filled = shown.filter(
    (r) => !r.isGroup && (String(r.value).trim() !== "" || r.valueText.trim() !== ""),
  );
  const patch = (i, next) => setRows(list.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  const submit = () =>
    save.mutate(
      {
        orderId,
        caseNo,
        rows: filled.map((r) => ({
          testId: r.testId,
          testName: r.testName,
          value: r.value,
          valueText: r.valueText,
          unit: r.unit,
          refRange: r.refRange,
          panelName: r.panelName,
        })),
      },
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

      {shown.map((row, i) => {
        const flag = flagOf(row);
        if (row.isGroup) {
          return (
            <div className="lr-group" key={`${row.testName}-${i}`}>
              {row.testName}
            </div>
          );
        }
        return (
          <div className="lr-row" key={`${row.testName}-${i}`}>
            <span className="lr-name" style={row.depth ? { paddingLeft: 12 } : undefined}>
              {row.testName}
              {row.calculated && (
                <span className="lr-calc" title={row.formula}>
                  auto
                </span>
              )}
            </span>
            <span className="lr-val">
              <input
                className="ar-reason-input"
                inputMode={row.inputType === "text" ? "text" : "decimal"}
                placeholder={row.calculated ? "worked out" : "—"}
                value={row.value}
                readOnly={row.calculated}
                onChange={(e) => patch(i, { value: e.target.value })}
              />
              {/* Shown as they type: a value about to go on a patient's record
                  as HIGH should say so before it is saved, not after. */}
              {flag && <span className={`lr-flag lr-${flag.toLowerCase()}`}>{flag}</span>}
            </span>
            {row.locked ? (
              <span className="lr-unit lr-fixed">{row.unit || "—"}</span>
            ) : (
              <input
                className="ar-reason-input lr-unit"
                placeholder="unit"
                value={row.unit}
                onChange={(e) => patch(i, { unit: e.target.value })}
              />
            )}
            {row.locked ? (
              <span className="lr-ref lr-fixed">{row.refRange || "no range"}</span>
            ) : (
              <input
                className="ar-reason-input lr-ref"
                placeholder="range"
                value={row.refRange}
                onChange={(e) => patch(i, { refRange: e.target.value })}
              />
            )}
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
          {filled.length
            ? `✓ Save ${filled.length} result${filled.length === 1 ? "" : "s"} — notify the MO`
            : "Type a value to save — or upload the report below"}
        </button>
        <span className="dp-hint">
          Empty rows are ignored. Typing values and attaching the report are two ways to finish the
          same sample, and either one notifies the MO — a case can carry both.
        </span>
      </div>
    </div>
  );
}
