import { useEffect, useId, useRef, useState } from "react";
import AnchoredPopover from "../ui/AnchoredPopover";
import { inr, localDate, packUnits, showDate } from "./format";
import "./MedicinePicker.css";

const daysLeft = (iso) =>
  Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${localDate()}T00:00:00`)) / 86400000);

export const batchNearExpiry = (batch, warnDays) =>
  !batch.expired && daysLeft(batch.expiry_date) <= warnDays;

const expiryNote = (batch, warnDays) => {
  if (batch.expired) return "Expired — cannot be sold";
  if (!batchNearExpiry(batch, warnDays)) return null;
  const left = daysLeft(batch.expiry_date);
  return `${left} day${left === 1 ? "" : "s"} left — choosing confirms`;
};

export const batchText = (batch) => `${batch.batch_no} · exp ${showDate(batch.expiry_date)}`;

const firstSellable = (batches) =>
  Math.max(
    batches.findIndex((b) => !b.expired),
    0,
  );

export default function BatchSelect({
  medicine,
  batches,
  warnDays,
  chosen,
  onChoose,
  inputRef,
  disabled = false,
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const fieldRef = useRef(null);
  const [active, setActive] = useState(() => firstSellable(batches));

  const term = text.trim().toLowerCase();
  const shown = term ? batches.filter((b) => b.batch_no.toLowerCase().includes(term)) : batches;
  const expanded = open && shown.length > 0;

  useEffect(() => {
    setText("");
    setActive(firstSellable(batches));
  }, [batches]);

  useEffect(() => setActive(firstSellable(shown)), [term]);

  const choose = (batch) => {
    if (!batch || batch.expired) return;
    onChoose(batch);
    setText("");
    setOpen(false);
  };

  const step = (from, by) => {
    for (let i = from + by; i >= 0 && i < shown.length; i += by) {
      if (!shown[i].expired) return i;
    }
    return from;
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => step(i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => step(i, -1));
    } else if (e.key === "Enter") {
      if (expanded && shown[active] && !shown[active].expired) {
        e.preventDefault();
        choose(shown[active]);
      } else if (chosen) {
        e.preventDefault();
        onChoose(chosen);
      }
    } else if (e.key === "Escape" && expanded) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="mpick" ref={fieldRef}>
      <input
        id={id}
        ref={inputRef}
        className="jb-assign mpick__input phb-entry__batch"
        role="combobox"
        aria-label={`Batch for ${medicine.name}`}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={
          expanded && shown[active] ? `${listId}-${shown[active].id}` : undefined
        }
        autoComplete="off"
        disabled={disabled}
        placeholder={chosen ? batchText(chosen) : "Choose a batch"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {expanded ? (
        <AnchoredPopover
          anchorRef={fieldRef}
          minWidth
          container={fieldRef.current?.closest(".flow-root")}
        >
          <ul
            id={listId}
            role="listbox"
            aria-label={`Batches of ${medicine.name}`}
            className="mpick__list mpick__list--floating phb-entry__list"
          >
            {shown.map((b, i) => {
              const note = expiryNote(b, warnDays);
              return (
                <li
                  key={b.id}
                  id={`${listId}-${b.id}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={b.expired || undefined}
                  className={`mpick__option${i === active ? " is-active" : ""}${b.expired ? " is-disabled" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(b);
                  }}
                  onMouseEnter={() => !b.expired && setActive(i)}
                >
                  <span className="mpick__name">{batchText(b)}</span>
                  <span className="mpick__meta">
                    {[
                      `${packUnits(b.qty_units, medicine)} in stock`,
                      b.rack_no && `Rack ${b.rack_no}`,
                      `MRP ${inr(b.mrp)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {note ? (
                    <span
                      className={`bill-status phs-badge phs-badge--${b.expired ? "out" : "review"}`}
                    >
                      {note}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}
