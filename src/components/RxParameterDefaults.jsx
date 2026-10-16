import { useEffect, useState } from "react";
import {
  useRxParameterDefaults,
  useSaveRxParameterDefaults,
} from "../queries/hooks/useRxParameters";
import { toast } from "../stores/uiStore.js";

const sourceText = (source) => {
  if (source?.vital) return `Vitals · ${source.vital.replace("_", " ")}`;
  if (source?.labs?.length) return `Lab · ${[...source.labs, ...(source.sides || [])].join(", ")}`;
  return "Entered at the station";
};

const keyFor = (label, taken) => {
  const base =
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 36) || "param";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
};

export default function RxParameterDefaults() {
  const { data, isLoading, isError, refetch } = useRxParameterDefaults();
  const save = useSaveRxParameterDefaults();
  const [list, setList] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState({ label: "", unit: "", lab: "" });

  useEffect(() => {
    if (data?.parameters && !dirty) setList(data.parameters);
  }, [data, dirty]);

  const change = (next) => {
    setList(next);
    setDirty(true);
  };
  const edit = (i, field, value) =>
    change(list.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));
  const move = (i, by) => {
    const next = [...list];
    const [row] = next.splice(i, 1);
    next.splice(i + by, 0, row);
    change(next);
  };

  const add = () => {
    const label = draft.label.trim();
    if (!label) return;
    const key = keyFor(label, new Set(list.map((p) => p.key)));
    const lab = draft.lab.trim();
    change([
      ...list,
      { key, label, unit: draft.unit.trim(), source: lab ? { labs: [lab] } : null },
    ]);
    setDraft({ label: "", unit: "", lab: "" });
  };

  const submit = (e) => {
    e.preventDefault();
    const empty = list.find((p) => !String(p.label).trim());
    if (empty) {
      toast("Every parameter needs a name.", "error");
      return;
    }
    save.mutate(list, {
      onSuccess: () => {
        setDirty(false);
        toast("Parameter list saved — used on the next prescriptions.", "success");
      },
      onError: (err) => toast(err?.response?.data?.error || "Could not save the list.", "error"),
    });
  };

  return (
    <form className="rxf__form" onSubmit={submit} aria-labelledby="rxp-defaults-title">
      <fieldset className="rxf__group">
        <legend className="rxf__legend" id="rxp-defaults-title">
          Vitals &amp; biomarkers table
        </legend>
        <p className="rxf__hint">
          The rows printed in the table after Diagnoses, with the last 5 visits and today. At the
          station, staff can still add or remove rows for one prescription.
        </p>
        {isLoading ? (
          <p className="rxf__loading">Loading…</p>
        ) : isError ? (
          <p className="rxf__hint" role="alert">
            Couldn&apos;t load the list.{" "}
            <button type="button" className="rxf__add" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <ol className="rxp-def-list">
            {list.map((p, i) => (
              <li key={p.key} className="rxp-def-row">
                <input
                  className="rxf__input"
                  aria-label={`Name of parameter ${i + 1}`}
                  value={p.label}
                  maxLength={60}
                  onChange={(e) => edit(i, "label", e.target.value)}
                />
                <input
                  className="rxf__input rxp-def-unit"
                  aria-label={`Unit of ${p.label}`}
                  placeholder="Unit"
                  value={p.unit || ""}
                  maxLength={20}
                  onChange={(e) => edit(i, "unit", e.target.value)}
                />
                <span className="rxf__hint rxp-def-src">{sourceText(p.source)}</span>
                <button
                  type="button"
                  className="rxf__add"
                  aria-label={`Move ${p.label} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="rxf__add"
                  aria-label={`Move ${p.label} down`}
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="rxf__add"
                  aria-label={`Remove ${p.label}`}
                  disabled={list.length === 1}
                  onClick={() => change(list.filter((_, idx) => idx !== i))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="rxp-def-row">
          <input
            className="rxf__input"
            placeholder="New parameter name"
            aria-label="New parameter name"
            maxLength={60}
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <input
            className="rxf__input rxp-def-unit"
            placeholder="Unit"
            aria-label="New parameter unit"
            maxLength={20}
            value={draft.unit}
            onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
          />
          <input
            className="rxf__input"
            placeholder="Lab test name (optional)"
            aria-label="Lab test name for the new parameter"
            maxLength={60}
            value={draft.lab}
            onChange={(e) => setDraft({ ...draft, lab: e.target.value })}
          />
          <button type="button" className="rxf__add" disabled={!draft.label.trim()} onClick={add}>
            Add
          </button>
        </div>
      </fieldset>
      <div className="rxf__actions">
        <button className="rxf__save" type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving…" : "Save list"}
        </button>
        <span className="rxf__note">
          Applies to prescriptions printed from now on. A value only fills in automatically when its
          lab test name matches Scribe&apos;s lab records; otherwise staff enter it at the station.
        </span>
      </div>
    </form>
  );
}
