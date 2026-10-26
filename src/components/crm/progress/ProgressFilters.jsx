import { useEffect, useState } from "react";
import { GROUPS, PERIODS, istToday } from "./progressText.js";

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
    filters.territory,
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
      <label className="prg__field">
        <span>Period</span>
        <select
          className="rep__input"
          value={filters.period || "this_month"}
          onChange={(e) =>
            onChange(
              e.target.value === "custom"
                ? { period: "custom", from: data?.filters.from, to: data?.filters.to }
                : { period: e.target.value, from: null, to: null },
            )
          }
          disabled={busy}
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

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

      <label className="prg__field">
        <span>Trend</span>
        <select
          className="rep__input"
          value={filters.group || ""}
          onChange={(e) => onChange({ group: e.target.value || null })}
          disabled={busy}
        >
          {GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </label>

      {data?.can_pick_staff && (
        <label className="prg__field">
          <span>Staff</span>
          <select
            className={`rep__input ${filters.rep && filters.rep !== "all" ? "home__select--on" : ""}`}
            value={filters.rep || "all"}
            onChange={(e) => onChange({ rep: e.target.value === "all" ? null : e.target.value })}
            disabled={busy}
          >
            <option value="all">All staff</option>
            {data.staff_options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="prg__field">
        <span>Territory</span>
        <select
          className={`rep__input ${filters.territory ? "home__select--on" : ""}`}
          value={filters.territory || ""}
          onChange={(e) => onChange({ territory: e.target.value || null })}
          disabled={busy}
        >
          <option value="">All territories</option>
          {(data?.territories || []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {changed && (
        <button type="button" className="asg__link prg__reset" onClick={onReset} disabled={busy}>
          Reset filters
        </button>
      )}
    </form>
  );
}
