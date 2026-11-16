import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, X } from "lucide-react";
import AnchoredPopover from "./AnchoredPopover.jsx";
import useDismissOnOutside from "../../hooks/useDismissOnOutside.js";
import "./TimePicker.css";

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));

const split = (value) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  return match ? { hour: match[1], minute: match[2] } : { hour: "", minute: "" };
};

export const timeText = (value) => {
  const { hour, minute } = split(value);
  if (!hour) return "";
  const h = Number(hour);
  return `${String(h % 12 || 12).padStart(2, "0")}:${minute} ${h < 12 ? "AM" : "PM"}`;
};

function Column({ label, items, selected, onPick, disabled, open }) {
  const listRef = useRef(null);
  useEffect(() => {
    if (!open || !selected) return;
    listRef.current
      ?.querySelector(`[data-value="${selected}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [open, selected]);
  return (
    <div className="tpick__col">
      <div className="tpick__col-head" aria-hidden="true">
        {label}
      </div>
      <div className="tpick__list" role="listbox" aria-label={label} ref={listRef}>
        {items.map((item) => (
          <button
            key={item}
            type="button"
            role="option"
            data-value={item}
            aria-selected={selected === item}
            disabled={disabled}
            className={`tpick__opt${selected === item ? " tpick__opt--on" : ""}`}
            onClick={() => onPick(item)}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TimePicker({
  value,
  onChange,
  ariaLabel,
  placeholder = "Any time",
  clearable = true,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const { hour, minute } = split(value);

  useDismissOnOutside(
    [anchorRef, popRef],
    useCallback(() => setOpen(false), []),
    open,
  );

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const shown = timeText(value);

  return (
    <div className="tpick" ref={anchorRef}>
      <button
        type="button"
        className={`tpick__btn${shown ? "" : " tpick__btn--empty"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}: ${shown || placeholder}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Clock size={14} aria-hidden="true" className="tpick__icon" />
        <span className="tpick__text">{shown || placeholder}</span>
      </button>
      {shown && clearable && !disabled ? (
        <button
          type="button"
          className="tpick__clear"
          aria-label={ariaLabel ? `Clear ${ariaLabel.toLowerCase()}` : "Clear time"}
          title="Clear"
          onClick={() => onChange("")}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
      {open && (
        <AnchoredPopover anchorRef={anchorRef} popoverRef={popRef} width={200} gap={6}>
          <div className="tpick__pop" role="dialog" aria-label={ariaLabel || "Choose a time"}>
            <div className="tpick__cols">
              <Column
                label="Hours"
                items={HOURS}
                selected={hour}
                open={open}
                onPick={(h) => onChange(`${h}:${minute || "00"}`)}
              />
              <Column
                label="Minutes"
                items={MINUTES}
                selected={minute}
                open={open}
                onPick={(m) => onChange(`${hour || "00"}:${m}`)}
              />
            </div>
            <div className="tpick__foot">
              <button
                type="button"
                className="tpick__link"
                disabled={!shown}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                Clear
              </button>
              <button type="button" className="tpick__done" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}
