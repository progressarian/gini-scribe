import "./DoctorSelect.css";
import { useEffect, useMemo, useRef, useState } from "react";

export default function DoctorSelect({ value, onChange, doctors = [] }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return doctors;
    return doctors.filter((d) => d.toLowerCase().includes(q));
  }, [doctors, search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const pick = (v) => {
    onChange(v);
    setOpen(false);
  };

  const label = value === "all" ? "All doctors" : value;

  return (
    <div ref={wrapRef} className="dsel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`dsel__trigger ${open ? "dsel__trigger--open" : ""}`}
      >
        <span className="dsel__trigger-icon">🩺</span>
        <span className="dsel__trigger-label">{label}</span>
        <span className="dsel__trigger-caret">▾</span>
      </button>

      {open && (
        <div className="dsel__pop" role="listbox" aria-label="Choose doctor">
          {doctors.length > 4 && (
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search doctor..."
              className="dsel__search"
            />
          )}
          <div className="dsel__list">
            <button
              type="button"
              onClick={() => pick("all")}
              className={`dsel__opt ${value === "all" ? "dsel__opt--sel" : ""}`}
              role="option"
              aria-selected={value === "all"}
            >
              <span className="dsel__opt-icon">👥</span>
              <span className="dsel__opt-text">All doctors</span>
              {value === "all" && <span className="dsel__check">✓</span>}
            </button>
            {filtered.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => pick(d)}
                className={`dsel__opt ${value === d ? "dsel__opt--sel" : ""}`}
                role="option"
                aria-selected={value === d}
              >
                <span className="dsel__opt-icon">🩺</span>
                <span className="dsel__opt-text">{d}</span>
                {value === d && <span className="dsel__check">✓</span>}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="dsel__empty">No doctors match "{search}"</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
