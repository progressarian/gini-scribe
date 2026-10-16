import { useEffect, useId, useMemo, useState } from "react";
import { useRxParameters, useSaveRxParameters } from "../../../queries/hooks/useRxParameters";
import "./rxParameters.css";

const shortDate = (ymd) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });

const keyFor = (label) =>
  `c-${String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)}`;

const fromServer = (data) =>
  (data?.rows || []).map((r) => ({
    key: r.key,
    label: r.label,
    unit: r.unit,
    custom: r.custom,
    history: r.values.slice(0, -1),
    today: r.edited ? (r.values.at(-1) ?? "") : (r.measuredToday ?? ""),
    measuredToday: r.measuredToday ?? "",
    edited: r.edited,
    show: r.show,
  }));

const toOverrides = (rows, removed) => [
  ...rows.map((r, order) => ({
    key: r.key,
    order,
    ...(r.custom ? { custom: true, label: r.label, unit: r.unit || "" } : {}),
    ...(r.edited ? { value: String(r.today ?? "").trim() || null } : {}),
    ...(r.show ? { show: true } : {}),
  })),
  ...removed.map((key) => ({ key, removed: true })),
];

export default function RxParameterSection({
  visitId,
  readOnly,
  onToast,
  onUnsaved,
  station = "doctor",
}) {
  const { data, isLoading, isError, refetch } = useRxParameters(visitId, station);
  const save = useSaveRxParameters(visitId, station);
  const [rows, setRows] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState("");
  const [custom, setCustom] = useState({ label: "", unit: "", value: "" });
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const pickId = useId();
  const locked = readOnly || data?.locked;

  useEffect(() => {
    if (station === "mo") refetch();
  }, [readOnly, station, refetch]);

  useEffect(() => {
    if (!data || dirty) return;
    setRows(fromServer(data));
    setRemoved((data.removed || []).map((r) => r.key));
  }, [data, dirty]);

  const touch = (next) => {
    setRows(next);
    setDirty(true);
    onUnsaved?.();
  };

  const addable = useMemo(() => {
    const present = new Set(rows.map((r) => r.key));
    return (data?.catalog || []).filter((c) => !present.has(c.key));
  }, [data, rows]);

  const setToday = (key, value) =>
    touch(rows.map((r) => (r.key === key ? { ...r, today: value, edited: true } : r)));
  const resetToday = (key) =>
    touch(rows.map((r) => (r.key === key ? { ...r, today: r.measuredToday, edited: false } : r)));
  const move = (index, by) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    touch(next);
  };
  const remove = (key) => {
    const row = rows.find((r) => r.key === key);
    if (!row?.custom) setRemoved((list) => [...new Set([...list, key])]);
    touch(rows.filter((r) => r.key !== key));
  };
  const toggleShow = (key) => touch(rows.map((r) => (r.key === key ? { ...r, show: !r.show } : r)));

  const addFromList = () => {
    const item = (data?.catalog || []).find((c) => c.key === adding);
    if (!item) return;
    setRemoved((list) => list.filter((k) => k !== item.key));
    const cols = (data?.columns || []).length - 1;
    touch([
      ...rows,
      {
        ...item,
        custom: false,
        history: Array(cols).fill(null),
        today: "",
        measuredToday: "",
        edited: false,
        show: true,
      },
    ]);
    setAdding("");
  };

  const addCustom = (e) => {
    e.preventDefault();
    const label = custom.label.trim();
    if (!label) return;
    const key = keyFor(label);
    if (rows.some((r) => r.key === key)) {
      onToast?.(`"${label}" is already in the table.`);
      return;
    }
    const cols = (data?.columns || []).length - 1;
    touch([
      ...rows,
      {
        key,
        label,
        unit: custom.unit.trim(),
        custom: true,
        history: Array(cols).fill(null),
        today: custom.value.trim(),
        measuredToday: "",
        edited: !!custom.value.trim(),
        show: true,
      },
    ]);
    setCustom({ label: "", unit: "", value: "" });
  };

  const submit = () =>
    save.mutate(toOverrides(rows, removed), {
      onSuccess: () => {
        setDirty(false);
        onToast?.("Parameter table saved — it will print on this prescription.");
      },
      onError: (e) => onToast?.(e?.response?.data?.error || "Could not save the parameter table."),
    });

  const discard = () => {
    setDirty(false);
    setRows(fromServer(data));
    setRemoved((data?.removed || []).map((r) => r.key));
  };

  const columns = data?.columns || [];
  const hasValue = (r) => [...r.history, r.today].some((v) => v != null && v !== "");
  const filledCount = rows.filter((r) => hasValue(r) || r.show || r.custom).length;
  const emptyCount = rows.length - filledCount;
  const listAll = showAll || (editing && !locked);
  const shown = listAll ? rows : rows.filter((r) => hasValue(r) || r.show || r.custom);
  const canEdit = editing && !locked;

  return (
    <section className="csec" id="s-rx-parameters" aria-labelledby="rx-params-title">
      <div className="cs-head">
        <h2 id="rx-params-title">📊 Vitals &amp; biomarkers table</h2>
        <span className="cs-sub">
          prints after Diagnoses · last {Math.max(columns.length - 1, 0)} visits + today
          {data?.updatedBy && !dirty ? ` · edited by ${data.updatedBy}` : ""}
        </span>
        <div className="cs-head-r">
          {!locked && (
            <button
              type="button"
              className={canEdit ? "btn-sm on" : "btn-sm"}
              aria-pressed={canEdit}
              onClick={() => setEditing((v) => !v)}
            >
              {canEdit ? "Done editing" : "Edit rows"}
            </button>
          )}
          {dirty && (
            <button type="button" className="btn-sm" onClick={discard} disabled={save.isPending}>
              Discard
            </button>
          )}
          <button
            type="button"
            className={dirty ? "btn-sm on" : "btn-sm"}
            disabled={locked || !dirty || save.isPending}
            onClick={submit}
          >
            {save.isPending ? "Saving…" : dirty ? "Save table" : "Saved"}
          </button>
        </div>
      </div>

      {data?.locked && (
        <p className="cn-empty">
          {data.lockedReason === "not_with_chief"
            ? "The patient has moved on from the Chief Endocrinologist — the consultant edits this table now."
            : "This prescription is finalized. Use Re-issue to change the table."}
        </p>
      )}

      {isLoading ? (
        <p className="cn-empty">Loading…</p>
      ) : isError ? (
        <p className="cn-empty" role="alert">
          Couldn&apos;t load the parameter table.{" "}
          <button type="button" className="btn-sm" onClick={() => refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <>
          <div className="ltablewrap">
            <table className="ltable rxp-table">
              <thead>
                <tr>
                  <th scope="col">Parameter</th>
                  {columns.map((c) => (
                    <th key={c.date} scope="col" className={c.today ? "rxp-today" : ""}>
                      {c.today ? `Today (${shortDate(c.date)})` : shortDate(c.date)}
                    </th>
                  ))}
                  {canEdit && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const i = rows.indexOf(r);
                  const empty = !hasValue(r);
                  return (
                    <tr key={r.key} data-key={r.key}>
                      <th scope="row">
                        {r.label}
                        {r.unit ? <span className="lt-ref"> ({r.unit})</span> : null}
                        {r.custom ? <span className="lt-ref"> · added</span> : null}
                      </th>
                      {r.history.map((v, ci) => (
                        <td key={columns[ci]?.date || ci} className={v == null ? "cn-empty" : ""}>
                          {v ?? "—"}
                        </td>
                      ))}
                      <td className="rxp-today">
                        <input
                          className="cp-inp rxp-inp"
                          value={r.today ?? ""}
                          maxLength={40}
                          disabled={locked}
                          aria-label={`Today's ${r.label}`}
                          onChange={(e) => setToday(r.key, e.target.value)}
                        />
                        {r.edited && r.measuredToday !== "" && r.today !== r.measuredToday && (
                          <button
                            type="button"
                            className="btn-sm"
                            disabled={locked}
                            title={`Measured today: ${r.measuredToday}`}
                            onClick={() => resetToday(r.key)}
                          >
                            Use {r.measuredToday}
                          </button>
                        )}
                      </td>
                      {canEdit && (
                        <td className="rxp-acts">
                          {empty && (
                            <label className="lt-ref">
                              <input
                                type="checkbox"
                                checked={!!r.show}
                                disabled={locked}
                                onChange={() => toggleShow(r.key)}
                              />{" "}
                              print empty
                            </label>
                          )}
                          <button
                            type="button"
                            className="btn-sm"
                            aria-label={`Move ${r.label} up`}
                            disabled={locked || i === 0}
                            onClick={() => move(i, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn-sm"
                            aria-label={`Move ${r.label} down`}
                            disabled={locked || i === rows.length - 1}
                            onClick={() => move(i, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="btn-sm"
                            aria-label={`Remove ${r.label}`}
                            disabled={locked}
                            onClick={() => remove(r.key)}
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!canEdit && emptyCount > 0 && (
            <button
              type="button"
              className="rxp-more"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? `▴ Show only filled rows (${filledCount})`
                : `▸ Show all ${rows.length} parameters (${emptyCount} empty)`}
            </button>
          )}

          {canEdit && (
            <div className="rxp-add">
              <label htmlFor={pickId} className="lt-ref">
                Add from list
              </label>
              <select
                id={pickId}
                className="cp-inp"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              >
                <option value="">Choose a parameter…</option>
                {addable.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                    {c.unit ? ` (${c.unit})` : ""}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-sm" disabled={!adding} onClick={addFromList}>
                Add
              </button>
              <form className="rxp-custom" onSubmit={addCustom}>
                <input
                  className="cp-inp"
                  placeholder="New parameter name"
                  aria-label="New parameter name"
                  maxLength={60}
                  value={custom.label}
                  onChange={(e) => setCustom({ ...custom, label: e.target.value })}
                />
                <input
                  className="cp-inp rxp-unit"
                  placeholder="Unit"
                  aria-label="New parameter unit"
                  maxLength={20}
                  value={custom.unit}
                  onChange={(e) => setCustom({ ...custom, unit: e.target.value })}
                />
                <input
                  className="cp-inp rxp-inp"
                  placeholder="Today's value"
                  aria-label="New parameter value"
                  maxLength={40}
                  value={custom.value}
                  onChange={(e) => setCustom({ ...custom, value: e.target.value })}
                />
                <button type="submit" className="btn-sm" disabled={!custom.label.trim()}>
                  Add new
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </section>
  );
}
