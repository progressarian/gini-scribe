import { useCallback, useId, useMemo, useState } from "react";

export const todayInIndia = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export const STATUS_ALL = "all";

export function useRequestFilters({ status = STATUS_ALL } = {}) {
  const defaults = useMemo(() => {
    const today = todayInIndia();
    return { status, kind: "", from: today, to: today, q: "" };
  }, [status]);
  const [value, setValue] = useState(defaults);
  const set = useCallback((patch) => setValue((current) => ({ ...current, ...patch })), []);
  const reset = useCallback(() => setValue(defaults), [defaults]);
  const isDefault = Object.keys(defaults).every((key) => value[key] === defaults[key]);
  return { value, set, reset, isDefault, today: defaults.from };
}

export default function RequestFilters({ filters, statuses, kinds, searchPlaceholder, onChange }) {
  const ids = {
    q: useId(),
    status: useId(),
    kind: useId(),
    from: useId(),
    to: useId(),
  };
  const { value } = filters;
  const statusShown = statuses.some(([key]) => key === value.status) ? value.status : STATUS_ALL;
  const change = (patch) => {
    filters.set(patch);
    onChange?.();
  };
  const today = todayInIndia();

  return (
    <div className="cxl-filters" role="search" aria-label="Filter requests">
      <div className="fset__field cxl-filters__search">
        <label htmlFor={ids.q}>Search</label>
        <input
          id={ids.q}
          type="search"
          className="jb-assign"
          placeholder={searchPlaceholder}
          value={value.q}
          maxLength={100}
          onChange={(e) => change({ q: e.target.value })}
        />
      </div>
      <div className="fset__field">
        <label htmlFor={ids.status}>Status</label>
        <select
          id={ids.status}
          className="jb-assign"
          value={statusShown}
          onChange={(e) => change({ status: e.target.value })}
        >
          {statuses.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {kinds ? (
        <div className="fset__field">
          <label htmlFor={ids.kind}>Kind</label>
          <select
            id={ids.kind}
            className="jb-assign"
            value={value.kind}
            onChange={(e) => change({ kind: e.target.value })}
          >
            {kinds.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="fset__field">
        <label htmlFor={ids.from}>From</label>
        <input
          id={ids.from}
          type="date"
          className="jb-assign"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => change({ from: e.target.value })}
        />
      </div>
      <div className="fset__field">
        <label htmlFor={ids.to}>To</label>
        <input
          id={ids.to}
          type="date"
          className="jb-assign"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => change({ to: e.target.value })}
        />
      </div>
      <div className="dri-filters__actions">
        {value.from !== today || value.to !== today ? (
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => change({ from: today, to: today })}
          >
            Today
          </button>
        ) : null}
        {filters.isDefault ? null : (
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => {
              filters.reset();
              onChange?.();
            }}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
