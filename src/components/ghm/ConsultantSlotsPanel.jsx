import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, PanelLeft, PanelRight, X } from "lucide-react";
import api from "../../services/api";
import { qk } from "../../queries/keys";
import { availabilityQuery, SLOT_REASON } from "../../lib/slotAvailability";
import { PATIENT_TYPES, PATIENT_TYPE_LABELS } from "../../../shared/slotCapacity";
import "./ConsultantSlotsPanel.css";

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const SIDE_KEY = "ghm-slots-panel-side";

const readSide = () => {
  try {
    return localStorage.getItem(SIDE_KEY) === "right" ? "right" : "left";
  } catch {
    return "left";
  }
};

const saveSide = (side) => {
  try {
    localStorage.setItem(SIDE_KEY, side);
  } catch {
    return;
  }
};

const WIDTH_KEY = "ghm-slots-panel-width";
const MIN_WIDTH = 360;
const WIDTH_STEP = 20;

const maxWidth = () => Math.max(MIN_WIDTH, Math.min(960, Math.round(window.innerWidth * 0.9)));

const clampWidth = (w) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(w)));

const readWidth = () => {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w > 0 ? clampWidth(w) : null;
  } catch {
    return null;
  }
};

const saveWidth = (w) => {
  try {
    if (w == null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    return;
  }
};

const searchWords = (value) => value.trim().toLowerCase().split(/\s+/).filter(Boolean);

const matching = (doctors, words) =>
  doctors.filter((d) => words.every((t) => d.toLowerCase().includes(t)));

const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function TypeCounts({ slot }) {
  const limited = PATIENT_TYPES.filter((t) => slot.caps?.[t] != null);
  if (!limited.length) return <span className="cslots__nolimit">No limit</span>;
  return (
    <ul className="cslots__types">
      {limited.map((t) => {
        const count = slot.counts?.[t] ?? 0;
        const full = count >= slot.caps[t];
        return (
          <li key={t} className={full ? "is-full" : undefined}>
            {PATIENT_TYPE_LABELS[t]} {count}/{slot.caps[t]}
            {full ? " full" : ""}
          </li>
        );
      })}
    </ul>
  );
}

export default function ConsultantSlotsPanel({ doctors, defaultDoctor, defaultDate, onClose }) {
  const [doctor, setDoctor] = useState(defaultDoctor || "");
  const [date, setDate] = useState(defaultDate);
  const [search, setSearch] = useState("");
  const [side, setSide] = useState(readSide);
  const otherSide = side === "left" ? "right" : "left";

  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef(null);

  const resizeTo = (w) => {
    const next = clampWidth(w);
    setWidth(next);
    saveWidth(next);
  };

  const resetWidth = () => {
    setWidth(null);
    saveWidth(null);
  };

  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = panelRef.current.getBoundingClientRect().width;
    const direction = side === "left" ? 1 : -1;
    setResizing(true);
    const onMove = (ev) => setWidth(clampWidth(startWidth + (ev.clientX - startX) * direction));
    const onUp = (ev) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setResizing(false);
      resizeTo(startWidth + (ev.clientX - startX) * direction);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const resizeByKey = (e) => {
    const current = width ?? panelRef.current.getBoundingClientRect().width;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) resizeTo(current + WIDTH_STEP);
    else if (e.key === shrink) resizeTo(current - WIDTH_STEP);
    else if (e.key === "Home") resizeTo(MIN_WIDTH);
    else if (e.key === "End") resizeTo(maxWidth());
    else return;
    e.preventDefault();
  };

  useEffect(() => {
    const onResize = () => setWidth((w) => (w == null ? w : clampWidth(w)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const moveSide = () => {
    setSide(otherSide);
    saveSide(otherSide);
  };

  const terms = searchWords(search);
  const matches = matching(doctors, terms);
  const choices = doctor && !matches.includes(doctor) ? [doctor, ...matches] : matches;

  const onSearch = (value) => {
    setSearch(value);
    const words = searchWords(value);
    const hits = matching(doctors, words);
    if (words.length && hits.length === 1) setDoctor(hits[0]);
  };

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const day = useQuery({
    queryKey: [...qk.ghm.availability(doctor, date), "panel"],
    queryFn: async () => (await api.get(availabilityQuery(doctor, date))).data,
    enabled: !!doctor && !!date,
    staleTime: 30_000,
  });

  const slots = (day.data?.slots || []).filter((s) => s.blocked_by !== "not_working");
  const dayOff = slots.length > 0 && slots.every((s) => s.blocked_by === "day_off");
  const open = slots.filter((s) => s.available);
  const booked = slots.reduce((n, s) => n + (s.booked || 0), 0);
  const fullSlots = open.filter((s) =>
    PATIENT_TYPES.some((t) => s.caps?.[t] != null && (s.counts?.[t] ?? 0) >= s.caps[t]),
  ).length;

  return (
    <aside
      ref={panelRef}
      className={`cslots cslots--${side}${resizing ? " is-resizing" : ""}`}
      style={width ? { "--cslots-w": `${width}px` } : undefined}
      role="dialog"
      aria-modal="false"
      aria-labelledby="cslots-title"
    >
      <div
        className="cslots__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel width"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        aria-valuenow={width ?? undefined}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
        onDoubleClick={resetWidth}
      />
      <div className="cslots__frame">
        <div className="modal__hdr">
          <span className="modal__title" id="cslots-title">
            <CalendarClock size={16} aria-hidden="true" />
            Consultant slots
          </span>
          <div className="cslots__hdr-actions">
            <button
              type="button"
              className="cslots__side"
              onClick={moveSide}
              title={`Move panel to the ${otherSide} side`}
            >
              {otherSide === "right" ? (
                <PanelRight size={15} aria-hidden="true" />
              ) : (
                <PanelLeft size={15} aria-hidden="true" />
              )}
              Move {otherSide}
            </button>
            <button type="button" className="modal__x" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="modal__body cslots__body">
          <div className="cslots__pick">
            <label className="fld">
              <span>Search consultant</span>
              <input
                type="search"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Type a name, e.g. test or bhansali"
                aria-describedby="cslots-matches"
                autoFocus
              />
              <small id="cslots-matches" className="cslots__matches" aria-live="polite">
                {terms.length
                  ? matches.length
                    ? `${matches.length} of ${doctors.length} consultants match`
                    : `No consultant matches "${search.trim()}"`
                  : `${doctors.length} consultants`}
              </small>
            </label>
            <label className="fld">
              <span>Consultant</span>
              <select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
                <option value="">
                  {terms.length && !matches.length
                    ? "— No match, clear the search"
                    : "— Choose a consultant"}
                </option>
                {choices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <div className="fld">
              <span id="cslots-date">Date</span>
              <div className="cslots__daynav">
                <button
                  type="button"
                  aria-label="Previous day"
                  onClick={() => setDate((d) => shiftDay(d, -1))}
                >
                  ‹
                </button>
                <input
                  type="date"
                  aria-labelledby="cslots-date"
                  value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
                <button
                  type="button"
                  aria-label="Next day"
                  onClick={() => setDate((d) => shiftDay(d, 1))}
                >
                  ›
                </button>
              </div>
            </div>
          </div>

          {!doctor ? (
            <p className="cslots__empty">Choose a consultant to see their slots for the day.</p>
          ) : day.isLoading ? (
            <p className="cslots__empty">Loading…</p>
          ) : day.isError ? (
            <p className="cslots__empty" role="alert">
              Could not load the slots. Try again.{" "}
              <button type="button" className="cslots__retry" onClick={() => day.refetch()}>
                Try again
              </button>
            </p>
          ) : !day.data?.resolved ? (
            <p className="cslots__empty">No consultant called {doctor} was found.</p>
          ) : dayOff ? (
            <p className="cslots__empty">
              {longDate(date)} is a day off for {doctor}.
            </p>
          ) : !slots.length ? (
            <p className="cslots__empty">No slots on {longDate(date)}.</p>
          ) : (
            <>
              <p className="cslots__summary" role="status">
                {longDate(date)} · <strong>{open.length}</strong> of {slots.length} slots open ·{" "}
                <strong>{booked}</strong> patient{booked === 1 ? "" : "s"} booked
                {fullSlots ? (
                  <>
                    {" "}
                    · <strong>{fullSlots}</strong> slot{fullSlots === 1 ? "" : "s"} full for at
                    least one type
                  </>
                ) : null}
              </p>
              <div className="cslots__table-wrap">
                <table className="cslots__table" aria-label={`${doctor} slots on ${date}`}>
                  <thead>
                    <tr>
                      <th scope="col">Slot</th>
                      <th scope="col">Booked</th>
                      <th scope="col">Patients per slot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((s) => (
                      <tr key={s.slot_label} className={s.available ? undefined : "is-blocked"}>
                        <th scope="row">{s.slot_label}</th>
                        <td>{s.booked || 0}</td>
                        <td>
                          {s.available ? (
                            <TypeCounts slot={s} />
                          ) : (
                            <span className="cslots__reason">
                              {s.blocked_by === "break" && s.detail
                                ? `Break · ${s.detail}`
                                : SLOT_REASON[s.blocked_by] || "Unavailable"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
