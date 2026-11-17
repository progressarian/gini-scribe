import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import AnchoredPopover from "./AnchoredPopover.jsx";
import useDismissOnOutside from "../../hooks/useDismissOnOutside.js";
import "./Dropdown.css";

const TYPEAHEAD_RESET_MS = 700;

const searchTextOf = (option) =>
  (typeof option.label === "string" ? option.label : String(option.value ?? ""))
    .trim()
    .toLowerCase();

function findMatch(options, query, from) {
  const total = options.length;
  for (let step = 0; step < total; step++) {
    const index = (from + step) % total;
    const option = options[index];
    if (!option.disabled && searchTextOf(option).startsWith(query)) return index;
  }
  return -1;
}

export default function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  variant,
  placeholder,
  disabled = false,
  title,
  className = "",
  id,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const listRef = useRef(null);
  const buttonRef = useRef(null);
  const typed = useRef({ text: "", at: 0 });

  useDismissOnOutside(
    [anchorRef, listRef],
    useCallback(() => setOpen(false), []),
    open,
  );

  const optionButtons = () => [...(listRef.current?.querySelectorAll('[role="option"]') ?? [])];

  const focusOption = (index) => {
    const target = optionButtons()[index];
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    if (!open) return;
    typed.current = { text: "", at: 0 };
    const selected = options.findIndex((o) => o.value === value && !o.disabled);
    const first = options.findIndex((o) => !o.disabled);
    const frame = requestAnimationFrame(() => {
      if (listRef.current?.contains(document.activeElement)) return;
      focusOption(selected >= 0 ? selected : first);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      buttonRef.current?.focus();
    };
    const step = (from, delta) => {
      const total = options.length;
      for (let i = 1; i <= total; i++) {
        const index = (from + delta * i + total * i) % total;
        if (!options[index].disabled) return index;
      }
      return from;
    };
    const onKey = (e) => {
      const focused = optionButtons().indexOf(document.activeElement);
      const current = focused >= 0 ? focused : options.findIndex((o) => o.value === value);
      if (e.key === "Escape") {
        e.preventDefault();
        return close();
      }
      if (e.key === "Tab") return setOpen(false);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return focusOption(step(current < 0 ? -1 : current, e.key === "ArrowDown" ? 1 : -1));
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        return focusOption(e.key === "Home" ? step(-1, 1) : step(options.length, -1));
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " " && !typed.current.text) return;
      e.preventDefault();
      const now = Date.now();
      const key = e.key.toLowerCase();
      const fresh = now - typed.current.at > TYPEAHEAD_RESET_MS;
      const text = fresh ? key : typed.current.text + key;
      typed.current = { text, at: now };
      const repeated = [...text].every((c) => c === key);
      const query = repeated ? key : text;
      const from = repeated || fresh ? current + 1 : Math.max(current, 0);
      let match = findMatch(options, query, from);
      if (match < 0 && query !== key) {
        typed.current = { text: key, at: now };
        match = findMatch(options, key, current + 1);
      }
      if (match >= 0) focusOption(match);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, options, value]);

  const select = (val) => {
    onChange(val);
    setOpen(false);
    buttonRef.current?.focus();
  };
  const current = options.find((o) => o.value === value);
  const color = current?.color;
  const label = current?.label || placeholder || options[0]?.label;

  return (
    <div className={`doc-dd ${className}`.trim()} ref={anchorRef}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        className={
          variant === "color"
            ? `csel csel--${color || "gray"} doc-dd__btn`
            : `doc-dd__btn ${variant === "cell" ? "doc-dd__btn--cell" : ""}`
        }
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-labelledby={id && !ariaLabel ? `${id}-label ${id}-value` : undefined}
      >
        <span className="doc-dd__label" id={id ? `${id}-value` : undefined}>
          {label}
        </span>
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
                aria-disabled={o.disabled || undefined}
                disabled={o.disabled}
                title={o.title}
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
