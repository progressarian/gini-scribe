import { useEffect, useState } from "react";
import useDebounced from "../../../hooks/useDebounced.js";

export function SearchField({ value, onSearch, label, placeholder }) {
  const [text, setText] = useState(value || "");
  const settled = useDebounced(text, 300);

  useEffect(() => {
    setText((current) => (current.trim() === (value || "") ? current : value || ""));
  }, [value]);

  useEffect(() => {
    if (settled.trim() !== (value || "").trim()) onSearch(settled.trim());
  }, [settled]);

  return (
    <label className="asg__field">
      <span className="asg__sr">{label}</span>
      <input
        className="rep__input"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        maxLength={100}
      />
    </label>
  );
}

export function FilterSelect({ label, value, onChange, allLabel, options }) {
  return (
    <label className="asg__field asg__field--narrow">
      <span className="asg__sr">{label}</span>
      <select
        className={`rep__input ${value ? "home__select--on" : ""}`}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ListStatus({ data, loading, err, retry, noun, active, onClear }) {
  return (
    <>
      <div className="home__count">
        <span className="rep__hint" aria-live="polite">
          {data ? `${data.total} ${noun}${data.total === 1 ? "" : "s"}` : loading ? "Loading…" : ""}
          {loading && data ? " · updating…" : ""}
        </span>
        {active && (
          <button type="button" className="asg__link" onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>
      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={retry}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}

export function ListBody({ data, loading, empty, filteredEmpty, active, onClear, children }) {
  return (
    <ul className="rep__list home__list" aria-busy={loading}>
      {loading &&
        !data &&
        Array.from({ length: 4 }, (_, i) => <li key={i} className="rep__row asg__skeleton" />)}
      {data && data.rows.length === 0 && !loading && (
        <li className="rep__empty">
          {active ? filteredEmpty : empty}
          {active && (
            <button type="button" className="asg__link" onClick={onClear}>
              Clear filters
            </button>
          )}
        </li>
      )}
      {children}
    </ul>
  );
}
