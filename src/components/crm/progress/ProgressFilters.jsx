import { useEffect, useState } from "react";
import Dropdown from "../../ui/Dropdown.jsx";
import { GROUPS, PERIODS, istToday } from "./progressText.js";
import { DOCTOR_PRIORITIES } from "../../../../shared/crmVocab.js";

const priorityOptions = (current) =>
  DOCTOR_PRIORITIES.filter((p) => !p.retired || p.value === current).map((p) => ({
    value: p.value,
    label: p.label,
  }));

function PickField({ label, value, options, onChange, disabled, active }) {
  return (
    <div className={`prg__field crm-dd ${active ? "crm-dd--on" : ""}`}>
      <span aria-hidden="true">{label}</span>
      <Dropdown
        ariaLabel={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

export default function ProgressFilters({ filters, data, onChange, onReset, busy }) {
  const [from, setFrom] = useState(filters.from || "");
  const [to, setTo] = useState(filters.to || "");
  const custom = filters.period === "custom";

  useEffect(() => {
    setFrom(filters.from || data?.filters.from || "");
    setTo(filters.to || data?.filters.to || "");
  }, [filters.from, filters.to, data?.filters.from, data?.filters.to]);

  const today = istToday();
  const changed = Boolean(
    (filters.period && filters.period !== "this_month") ||
    filters.group ||
    (filters.rep && filters.rep !== "all") ||
    filters.territory ||
    filters.priority,
  );

  return (
    <form
      className="prg__filters"
      aria-label="Report filters"
      onSubmit={(e) => {
        e.preventDefault();
        if (custom) onChange({ from, to });
      }}
    >
      <PickField
        label="Period"
        value={filters.period || "this_month"}
        options={PERIODS}
        onChange={(period) =>
          onChange(
            period === "custom"
              ? { period: "custom", from: data?.filters.from, to: data?.filters.to }
              : { period, from: null, to: null },
          )
        }
        disabled={busy}
      />

      {custom && (
        <>
          <label className="prg__field">
            <span>From</span>
            <input
              className="rep__input"
              type="date"
              value={from}
              max={to || today}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </label>
          <label className="prg__field">
            <span>To</span>
            <input
              className="rep__input"
              type="date"
              value={to}
              min={from || undefined}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="rep__btn rep__btn--sm prg__apply" disabled={busy}>
            Apply
          </button>
        </>
      )}

      <PickField
        label="Trend"
        value={filters.group || ""}
        options={GROUPS}
        onChange={(group) => onChange({ group: group || null })}
        disabled={busy}
      />

      {data?.can_pick_staff && (
        <PickField
          label="Staff"
          value={filters.rep || "all"}
          active={Boolean(filters.rep && filters.rep !== "all")}
          options={[
            { value: "all", label: "All staff" },
            ...data.staff_options.map((s) => ({ value: s.id, label: s.full_name })),
          ]}
          onChange={(rep) => onChange({ rep: rep === "all" ? null : rep })}
          disabled={busy}
        />
      )}

      <PickField
        label="Territory"
        value={filters.territory || ""}
        active={Boolean(filters.territory)}
        options={[
          { value: "", label: "All territories" },
          ...(data?.territories || []).map((t) => ({ value: t.id, label: t.name })),
        ]}
        onChange={(territory) => onChange({ territory: territory || null })}
        disabled={busy}
      />

      <PickField
        label="Priority"
        value={filters.priority || ""}
        active={Boolean(filters.priority)}
        options={[{ value: "", label: "All priorities" }, ...priorityOptions(filters.priority)]}
        onChange={(priority) => onChange({ priority: priority || null })}
        disabled={busy}
      />

      {changed && (
        <button type="button" className="asg__link prg__reset" onClick={onReset} disabled={busy}>
          Reset filters
        </button>
      )}
    </form>
  );
}
