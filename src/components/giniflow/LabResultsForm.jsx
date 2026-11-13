import { useEffect, useState } from "react";
import {
  labReportHref,
  useLabResults,
  useTestNameSearch,
  useSaveLabResults,
} from "../../queries/hooks/useGiniflowLab";
import { PdfButton } from "../billing/counter/PdfViewer";
import {
  computeFormulas,
  flagFor as flagAgainstRange,
  formulaUsesPatient,
  notANumber,
} from "../../../shared/labFormula";

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

const nameKey = (name) =>
  String(name || "")
    .trim()
    .toLowerCase();

const savedValue = (r) => (r.value != null ? String(r.value) : r.valueText || "");

const needsNumber = (row) =>
  row.locked && !row.calculated && !row.isGroup && (row.inputType || "numeric") === "numeric";

const wrongValue = (row) => needsNumber(row) && notANumber(row.value);

const NUMBER_SO_FAR = /^(?:[<>]=?\s*)?-?\d*(?:\.\d*)?$/;
const MAX_NUMBER_CHARS = 10;

const RANGE_CHARS = /^[\d.\s<>=\-–]*$/;
const RANGE_FULL = /^(?:[<>]=?\s*-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*[-–]\s*-?\d+(?:\.\d+)?)$/;
const MAX_RANGE_CHARS = 21;

const wrongRange = (row) => {
  const raw = String(row.refRange ?? "").trim();
  return !row.locked && raw !== "" && RANGE_CHARS.test(raw) && !RANGE_FULL.test(raw);
};

const typedNumberOk = (row, text) => {
  const raw = text.trim();
  if (!NUMBER_SO_FAR.test(raw) || raw.length > MAX_NUMBER_CHARS) return false;
  const places = (raw.split(".")[1] || "").length;
  if (places > (row.decimals ?? 2)) return false;
  return !farOff({ ...row, value: raw });
};

function farOff(row) {
  if (!needsNumber(row) || !row.range) return false;
  const raw = String(row.value ?? "").trim();
  const digits = raw.replace(/^[<>]=?\s*/, "");
  const max = row.range.maxValue == null ? null : Number(row.range.maxValue);
  const min = row.range.minValue == null ? null : Number(row.range.minValue);
  if (min != null && min >= 0 && digits.startsWith("-")) return true;
  const n = Number(digits);
  if (digits === "" || !Number.isFinite(n)) return false;
  return max != null && max > 0 && n > max * 10;
}

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
    const saved = new Map((data.results || []).map((r) => [nameKey(r.testName), r]));
    const withSaved = (row) => {
      const hit = saved.get(nameKey(row.testName));
      if (!hit) return row;
      saved.delete(nameKey(row.testName));
      return { ...row, value: savedValue(hit), valueText: "" };
    };
    const suggested = (data.suggestions || [])
      .flatMap((group) =>
        group.params.map((p) => ({
          testId: p.testId || null,
          testName: p.testName,
          value: "",
          valueText: "",
          unit: p.unit || "",
          refRange: p.refRange || "",
          range: p.range || null,
          formula: p.formula || null,
          decimals: p.decimals ?? 2,
          inputType: p.inputType || "numeric",
          options: p.options || [],
          calculated: !!p.calculated,
          isGroup: !!p.isGroup,
          depth: p.depth || 0,
          locked: !!p.fromCatalog,
          required: p.required !== false,
          panelName: group.test,
        })),
      )
      .map(withSaved);
    const shownRows = [];
    const extraRows = [];
    for (const test of (data.suggestions || []).map((g) => g.test)) {
      const own = suggested.filter((r) => r.panelName === test);
      if (own.some((r) => r.locked)) {
        const [required, optional] = splitCatalogRows(own.filter((r) => r.locked));
        shownRows.push(...required);
        extraRows.push(...optional);
      } else {
        shownRows.push(...own.slice(0, VISIBLE_ROWS));
        extraRows.push(...own.slice(VISIBLE_ROWS));
      }
    }
    const hasValue = (r) => String(r.value ?? "").trim() !== "";
    const leftover = [...saved.values()].map((r) => ({
      testName: r.testName,
      value: savedValue(r),
      valueText: "",
      unit: r.unit || "",
      refRange: r.refRange || "",
      panelName: r.panelName || "",
    }));
    setRows([...shownRows, ...extraRows.filter(hasValue), ...leftover]);
    setRest(extraRows.filter((r) => !hasValue(r)));
  }, [data, rows]);

  const [open, setOpen] = useState(null);

  const list = rows || [];
  const calculated = computeFormulas(
    list
      .filter((r) => r.testId)
      .map((r) => ({ id: r.testId, formula: r.formula, decimals: r.decimals })),
    Object.fromEntries(list.filter((r) => r.testId && !r.formula).map((r) => [r.testId, r.value])),
    data?.patientValues || {},
  );
  const patient = data?.patientValues || {};
  const usesPatient = list.some((r) => formulaUsesPatient(r.formula));
  const missingPatient = [
    patient.age == null && list.some((r) => /@age\b/.test(r.formula || "")) ? "age" : null,
    patient.female == null && list.some((r) => /@female\b/.test(r.formula || ""))
      ? "sex (male or female)"
      : null,
    patient.weight == null && list.some((r) => /@weight\b/.test(r.formula || ""))
      ? "today's weight"
      : null,
  ].filter(Boolean);
  const shown = list.map((r) => (r.formula ? { ...r, value: calculated[r.testId] ?? "" } : r));
  const filled = shown.filter(
    (r) => !r.isGroup && (String(r.value).trim() !== "" || r.valueText.trim() !== ""),
  );
  const patch = (i, next) => setRows(list.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  const filledKeys = new Set(filled.map((r) => nameKey(r.testName)));
  const toClear = (data?.results || [])
    .filter((r) => !filledKeys.has(nameKey(r.testName)))
    .map((r) => r.testName);

  const submit = () =>
    save.mutate(
      {
        orderId,
        caseNo,
        cleared: toClear,
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

  const savedResults = data?.results || [];
  const sameValue = (a, b) => {
    const x = String(a ?? "").trim();
    const y = String(b ?? "").trim();
    return x === y || (x !== "" && y !== "" && Number(x) === Number(y));
  };
  const savedByName = new Map(savedResults.map((r) => [nameKey(r.testName), savedValue(r)]));
  const unsavedChanges =
    toClear.length > 0 ||
    filled.some(
      (r) =>
        !savedByName.has(nameKey(r.testName)) ||
        !sameValue(savedByName.get(nameKey(r.testName)), String(r.value).trim() || r.valueText),
    );

  const fileTests = (data?.suggestions || []).filter((g) => g.asFile).map((g) => g.test);
  const onlyFiles =
    fileTests.length > 0 &&
    fileTests.length === (data?.suggestions || []).length &&
    !(data?.results || []).length;

  const renderRow = (row, i) => {
    const wrong = wrongValue(row);
    const flag = wrong ? null : flagOf(row);
    const check = !wrong && farOff(row);
    const errorId = `lr-err-${i}`;
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
          {row.inputType === "select" && row.options?.length ? (
            <select
              className="ar-reason-input"
              value={row.value}
              aria-label={`${row.testName} result`}
              onChange={(e) => patch(i, { value: e.target.value })}
            >
              <option value="">—</option>
              {row.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={`ar-reason-input${wrong ? " lr-invalid" : ""}`}
              inputMode={row.inputType === "text" ? "text" : "decimal"}
              placeholder={row.calculated ? "worked out" : "—"}
              value={row.value}
              readOnly={row.calculated}
              aria-label={`${row.testName} result`}
              aria-invalid={wrong || undefined}
              aria-describedby={wrong ? errorId : undefined}
              onChange={(e) => {
                const next = e.target.value;
                if (needsNumber(row) && !typedNumberOk(row, next)) return;
                patch(i, { value: next });
              }}
            />
          )}
          {!row.calculated && String(row.value ?? "").trim() !== "" ? (
            <button
              type="button"
              className="lr-clear"
              aria-label={`Clear ${row.testName} value`}
              onClick={() => patch(i, { value: "", valueText: "" })}
            >
              Clear
            </button>
          ) : null}
          {flag && <span className={`lr-flag lr-${flag.toLowerCase()}`}>{flag}</span>}
          {check ? (
            <span className="lr-err lr-err--check" role="status">
              Check this value — far outside the usual range
            </span>
          ) : null}
          {wrong ? (
            <span className="lr-err" id={errorId} role="alert">
              Enter a number, e.g. 12.5 or &lt;0.1
            </span>
          ) : null}
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
          <span className="lr-refbox">
            <input
              className={`ar-reason-input lr-ref${wrongRange(row) ? " lr-invalid" : ""}`}
              placeholder="e.g. 0.7 - 1.3"
              value={row.refRange}
              aria-label={`${row.testName} reference range`}
              aria-invalid={wrongRange(row) || undefined}
              onChange={(e) => {
                const next = e.target.value;
                if (!RANGE_CHARS.test(next) || next.length > MAX_RANGE_CHARS) return;
                patch(i, { refRange: next });
              }}
            />
            {wrongRange(row) ? (
              <span className="lr-err" role="alert">
                Like 0.7 - 1.3, &lt;5 or &gt;40
              </span>
            ) : null}
          </span>
        )}
        <button
          type="button"
          className="jb-remove"
          title="Remove this test"
          aria-label={`Remove ${row.testName}`}
          onClick={() => {
            setRows(list.filter((_, idx) => idx !== i));
            if (row.panelName && !rest.some((r) => r.testName === row.testName)) {
              setRest([...rest, { ...row, value: "", valueText: "" }]);
            }
          }}
        >
          ✕
        </button>
      </div>
    );
  };

  const orderedTests = (data?.suggestions || []).map((g) => g.test);
  const sectionKeys = [
    ...orderedTests,
    ...[...new Set(list.map((r) => r.panelName || ""))].filter((k) => !orderedTests.includes(k)),
  ];
  const sections = sectionKeys
    .map((key) => {
      const indexes = shown
        .map((r, i) => ((r.panelName || "") === key ? i : -1))
        .filter((i) => i >= 0);
      const valueRows = indexes.map((i) => shown[i]).filter((r) => !r.isGroup);
      return {
        key: key || "other",
        title: key || "Other values",
        asFile: fileTests.includes(key),
        indexes,
        rest: rest.filter((r) => (r.panelName || "") === key),
        total: valueRows.length,
        filled: valueRows.filter(
          (r) => String(r.value).trim() !== "" || (r.valueText || "").trim() !== "",
        ).length,
        flags: valueRows.filter((r) => !wrongValue(r) && flagOf(r)).length,
        wrong: valueRows.filter((r) => wrongValue(r) || wrongRange(r)).length,
        check: valueRows.filter(farOff).length,
      };
    })
    .filter(
      (sec) =>
        sec.asFile || sec.indexes.length || sec.rest.length || orderedTests.includes(sec.title),
    );
  const wrongCount = sections.reduce((n, sec) => n + sec.wrong, 0);
  const firstOpen = sections.find((sec) => !sec.asFile && sec.filled < sec.total) || sections[0];
  const openSet = open ?? new Set(firstOpen ? [firstOpen.key] : []);
  const firstOpenKey = firstOpen?.key ?? null;
  useEffect(() => {
    if (open === null && rows !== null && firstOpenKey) setOpen(new Set([firstOpenKey]));
  }, [open, rows, firstOpenKey]);
  const toggleSection = (key) => {
    const next = new Set(openSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };

  if (isLoading) return <div className="empty-note">Loading the results form…</div>;

  if (onlyFiles)
    return (
      <p className="lr-asfile">
        {fileTests.join(", ")}: the result comes as a report file — upload it below. No values to
        type.
      </p>
    );

  return (
    <div className="lr">
      {sections.length > 1 ? (
        <div className="lr-secbar">
          <span>
            {sections.length} tests · {filled.length} value{filled.length === 1 ? "" : "s"} typed
          </span>
          <button
            type="button"
            className="lr-secbar__btn"
            onClick={() =>
              setOpen(
                openSet.size === sections.length
                  ? new Set()
                  : new Set(sections.map((sec) => sec.key)),
              )
            }
          >
            {openSet.size === sections.length ? "Close all" : "Open all"}
          </button>
        </div>
      ) : null}
      {usesPatient ? (
        <p className={missingPatient.length ? "lr-patient lr-patient--missing" : "lr-patient"}>
          {missingPatient.length
            ? `Some results are worked out from the patient's details, but ${missingPatient.join(", ")} is not recorded — those stay blank. Record it (weight comes from today's vitals) and reopen this form.`
            : `Worked out using age ${patient.age}, ${patient.female ? "female" : "male"}${
                patient.weight != null ? `, weight ${patient.weight} kg (today's vitals)` : ""
              }.`}
        </p>
      ) : null}
      {sections.map((section) => {
        const isOpen = openSet.has(section.key);
        const panelId = `lr-sec-${section.key.replace(/[^a-z0-9]/gi, "-")}`;
        return (
          <section className="lr-sec" key={section.key}>
            <button
              type="button"
              className="lr-sec__head"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggleSection(section.key)}
            >
              <span className="lr-sec__chev" aria-hidden="true">
                {isOpen ? "▾" : "▸"}
              </span>
              <span className="lr-sec__name">{section.title}</span>
              <span className="lr-sec__meta">
                {section.asFile
                  ? "report file"
                  : section.total
                    ? `${section.filled} of ${section.total} filled`
                    : "no fields"}
              </span>
              {section.wrong ? <span className="lr-sec__wrong">{section.wrong} to fix</span> : null}
              {section.check ? (
                <span className="lr-sec__check">{section.check} to check</span>
              ) : null}
              {section.flags ? (
                <span className="lr-sec__flags">{section.flags} abnormal</span>
              ) : null}
            </button>
            {isOpen ? (
              <div id={panelId} className="lr-sec__body">
                {section.asFile ? (
                  <p className="lr-asfile">The result comes as a report file — upload it below.</p>
                ) : null}
                {section.indexes.length ? (
                  <div className="lr-head">
                    <span>Test</span>
                    <span>Value</span>
                    <span>Unit</span>
                    <span>Reference</span>
                    <span />
                  </div>
                ) : !section.asFile ? (
                  <p className="lr-sec__empty">
                    No result fields for this test yet — add a value with “Add a test” below, or
                    upload the report.
                  </p>
                ) : null}
                {section.indexes.map((i) => renderRow(shown[i], i))}
                {section.rest.length > 0 && (
                  <select
                    className="jb-add"
                    value=""
                    aria-label={`More fields from ${section.title}`}
                    onChange={(e) => {
                      const picked = section.rest.find((r) => r.testName === e.target.value);
                      if (!picked) return;
                      setRows([...list, picked]);
                      setRest(rest.filter((r) => r !== picked));
                    }}
                  >
                    <option value="">
                      + More from {section.title} ({section.rest.length})
                    </option>
                    {section.rest.map((r) => (
                      <option key={r.testName} value={r.testName}>
                        {r.testName}
                        {r.unit ? ` (${r.unit})` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : null}
          </section>
        );
      })}

      <AddRow onAdd={(row) => setRows([...list, { ...row, valueText: "", panelName: "" }])} />

      <div className="lr-foot">
        <button
          className="st-btn st-btn-grn btn-full"
          disabled={save.isPending || !unsavedChanges || wrongCount > 0}
          onClick={submit}
        >
          {save.isPending
            ? "Saving…"
            : wrongCount
              ? `Fix ${wrongCount} value${wrongCount === 1 ? "" : "s"} before saving`
              : !unsavedChanges
                ? savedResults.length
                  ? "✓ All values saved"
                  : "Type a value to save — or upload the report below"
                : filled.length
                  ? `✓ Save ${filled.length} result${filled.length === 1 ? "" : "s"}${
                      toClear.length ? ` · clear ${toClear.length}` : ""
                    } — notify the MO`
                  : `Clear ${toClear.length} saved value${toClear.length === 1 ? "" : "s"}`}
        </button>
        {toClear.length > 0 && !save.isPending ? (
          <span className="lr-foot__note lr-foot__note--warn" role="status">
            Saving removes {toClear.join(", ")} from this patient's results.
          </span>
        ) : null}
        <span className="lr-foot__note">
          Empty rows are skipped. Saving values or uploading the report notifies the MO.
        </span>
        {savedResults.length > 0 && (
          <div className="lr-report">
            <PdfButton
              className="st-btn st-btn-g btn-full"
              href={labReportHref({ orderId, caseNo })}
              title="Lab report"
              fileName="lab-report.pdf"
              disabled={unsavedChanges}
            >
              {unsavedChanges
                ? "Save the new values first to include them in the report"
                : "📄 Generate report"}
            </PdfButton>
            <span className="lr-foot__note">
              The report lists only the {savedResults.length} saved value
              {savedResults.length === 1 ? "" : "s"}. It is marked provisional until verified.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
