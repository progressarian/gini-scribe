import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import AnchoredPopover from "./AnchoredPopover.jsx";
import useDismissOnOutside from "../../hooks/useDismissOnOutside.js";
import "./Dropdown.css";

export default function Dropdown({ value, options, onChange, ariaLabel, variant, placeholder }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const listRef = useRef(null);

  useDismissOnOutside(
    [anchorRef, listRef],
    useCallback(() => setOpen(false), []),
    open,
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const select = (val) => {
    onChange(val);
    setOpen(false);
  };
  const current = options.find((o) => o.value === value);
  const color = current?.color;
  const label = current?.label || placeholder || options[0]?.label;

  return (
    <div className="doc-dd" ref={anchorRef}>
      <button
        type="button"
        className={
          variant === "color"
            ? `csel csel--${color || "gray"} doc-dd__btn`
            : `doc-dd__btn ${variant === "cell" ? "doc-dd__btn--cell" : ""}`
        }
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="doc-dd__label">{label}</span>
        {current?.badge ? (
          <span
            className={`doc-dd__badge doc-dd__badge--${current.badgeTone || "low"}`}
            title={current.badgeTitle}
          >
            {current.badge}
          </span>
        ) : null}
        <ChevronDown className={`doc-dd__arrow ${open ? "doc-dd__arrow--up" : ""}`} size={13} />
      </button>
      {open && (
        <AnchoredPopover anchorRef={anchorRef} popoverRef={listRef} minWidth gap={4}>
          <div className="doc-dd__list" role="listbox">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={value === o.value}
                className={`doc-dd__item ${value === o.value ? "doc-dd__item--active" : ""}`}
                onClick={() => select(o.value)}
              >
                <span className="doc-dd__item-label">{o.label}</span>
                {o.badge ? (
                  <span
                    className={`doc-dd__badge doc-dd__badge--${o.badgeTone || "low"}`}
                    title={o.badgeTitle}
                  >
                    {o.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}
