import { useId, useState } from "react";
import { toast } from "../../stores/uiStore";
import { codeTyped, digitsTyped, errorOf } from "./format";
import { financialYearOf } from "../../../shared/billingVocab.js";

const text = (v) => (v === null || v === undefined ? "" : String(v));
const indiaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const nextYear = (fy) => {
  const start = Number(fy.slice(0, 4)) + 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};
const TYPED = { prefix: codeTyped, number_width: digitsTyped, next_no: digitsTyped };
const typed = (key, value) => (TYPED[key] ? TYPED[key](value) : value);
const changedOnly = (after, before) =>
  Object.fromEntries(
    Object.entries(after).filter(([key, value]) => String(value) !== String(before[key])),
  );

function SeriesRow({ series, fy, row, labels, useSave }) {
  const initial = {
    prefix: text(row?.prefix),
    number_width: text(row?.number_width ?? 6),
    next_no: text(row?.next_no ?? 1),
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const save = useSave();
  const changes = row ? changedOnly(form, initial) : form;
  const dirty = !row || Object.keys(changedOnly(form, initial)).length > 0;
  const width = Number(form.number_width) || 0;
  const preview =
    width > 0 && /^\d+$/.test(form.next_no)
      ? `${form.prefix.trim()}${form.next_no.padStart(width, "0")}`
      : "—";
  const set = (key) => (e) => setForm({ ...form, [key]: typed(key, e.target.value) });
  const submit = async () => {
    setError("");
    try {
      await save.mutateAsync({ series, fy, ...changes });
      toast(`Saved the ${labels[series] ?? series} series for ${fy}`, "success");
    } catch (err) {
      setError(errorOf(err, "Could not save the series"));
    }
  };
  const label = labels[series] ?? series;
  return (
    <tr>
      <td data-label="Series">
        {label}
        {row ? null : <div className="flow-muted bill-items__sub">Not set up yet</div>}
      </td>
      <td data-label="Prefix">
        <input
          className="jb-assign"
          aria-label={`${label} prefix`}
          maxLength={30}
          placeholder="None"
          value={form.prefix}
          onChange={set("prefix")}
        />
      </td>
      <td data-label="Digits">
        <input
          className="jb-assign"
          aria-label={`${label} digits`}
          inputMode="numeric"
          maxLength={2}
          value={form.number_width}
          onChange={set("number_width")}
        />
      </td>
      <td data-label="Next number">
        <input
          className="jb-assign"
          aria-label={`${label} next number`}
          inputMode="numeric"
          maxLength={12}
          value={form.next_no}
          onChange={set("next_no")}
        />
      </td>
      <td data-label="Next looks like">
        <code>{preview}</code>
      </td>
      <td data-label="" className="bill-items__actions">
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini"
          aria-label={`Save ${label} series`}
          disabled={!dirty || save.isPending}
          onClick={submit}
        >
          {row ? "Save" : "Set up"}
        </button>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

export default function SeriesCard({
  series: seriesList,
  labels,
  useSeries,
  useSave,
  description,
}) {
  const { data: rows = [], isLoading, isError } = useSeries();
  const current = financialYearOf(indiaToday());
  const [fy, setFy] = useState(current);
  const id = useId();
  return (
    <section className="flow-card bill-stack" aria-label="Number series">
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Number series</h2>
      </div>
      <div className="fset__cardsub">{description}</div>
      <div className="bill-form bill-set__fy">
        <div className="fset__field fset__field--narrow bill-rates__asof">
          <label htmlFor={id}>Financial year</label>
          <select id={id} className="jb-assign" value={fy} onChange={(e) => setFy(e.target.value)}>
            <option value={current}>{current}</option>
            <option value={nextYear(current)}>{nextYear(current)}</option>
          </select>
        </div>
      </div>
      {isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : isError ? (
        <div className="fset__cardsub">Could not load the number series.</div>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table" aria-label={`Number series ${fy}`}>
            <thead>
              <tr>
                <th>Series</th>
                <th>Prefix</th>
                <th>Digits</th>
                <th>Next number</th>
                <th>Next looks like</th>
                <th className="bill-items__actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {seriesList.map((series) => {
                const row = rows.find((r) => r.series === series && r.fy === fy) ?? null;
                return (
                  <SeriesRow
                    key={`${series}-${fy}-${row ? row.updated_at : "new"}`}
                    series={series}
                    fy={fy}
                    row={row}
                    labels={labels}
                    useSave={useSave}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
