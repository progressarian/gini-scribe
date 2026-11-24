import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import AnchoredPopover from "../ui/AnchoredPopover";
import { useMedicineList } from "../../queries/hooks/usePharmacyMedicines";
import "./MedicinePicker.css";

const describe = (m) =>
  [
    m.code,
    `${m.pack_label} of ${m.pack_size} ${m.unit_label}`,
    m.default_rack && `Rack ${m.default_rack}`,
  ]
    .filter(Boolean)
    .join(" · ");

const useMasterOptions = (q) => {
  const search = useMedicineList({ q, status: "active", limit: 10 }, { enabled: Boolean(q) });
  return { ...search, options: search.data?.rows ?? [] };
};

export default function MedicinePicker({
  label = "Medicine",
  onSelect,
  excludeIds = [],
  placeholder = "Type at least 2 letters of the name or code",
  autoFocus = false,
  useOptions = useMasterOptions,
  describeOption = describe,
  optionId = (m) => m.id,
  noMatchText = "No active medicine matches. Add it on the Medicines page first.",
  disabled = false,
  inputRef,
  hideLabel = false,
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const fieldRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim().length >= 2 ? text.trim() : ""), 200);
    return () => clearTimeout(t);
  }, [text]);

  const search = useOptions(q);
  const options = (q ? search.options : []).filter((m) => !excludeIds.includes(optionId(m)));
  const expanded = open && Boolean(q);

  useEffect(() => setActive(0), [q]);

  const choose = (medicine) => {
    onSelect(medicine);
    setText("");
    setQ("");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && expanded && options[active]) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape" && expanded) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const inDialog = Boolean(fieldRef.current?.closest('[role="dialog"]'));

  const list = (className) => (
    <ul id={listId} role="listbox" aria-label={`${label} results`} className={className}>
      {options.map((m, i) => (
        <li
          key={optionId(m)}
          id={`${listId}-${optionId(m)}`}
          role="option"
          aria-selected={i === active}
          className={`mpick__option${i === active ? " is-active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            choose(m);
          }}
          onMouseEnter={() => setActive(i)}
        >
          <span className="mpick__name">{m.name}</span>
          <span className="mpick__meta">{describeOption(m)}</span>
        </li>
      ))}
    </ul>
  );

  const status = !q
    ? null
    : search.isError
      ? "Could not search medicines. Try again."
      : search.isFetching && !search.data
        ? "Searching…"
        : options.length
          ? `${options.length} medicine${options.length === 1 ? "" : "s"} found`
          : noMatchText;

  return (
    <div className="mpick">
      <label htmlFor={id} className={`mpick__label${hideLabel ? " mpick__label--hidden" : ""}`}>
        {label}
      </label>
      <div className="mpick__field" ref={fieldRef}>
        <Search size={15} className="mpick__icon" aria-hidden="true" />
        <input
          id={id}
          ref={inputRef}
          className="jb-assign mpick__input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={
            expanded && options[active] ? `${listId}-${optionId(options[active])}` : undefined
          }
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {expanded && options.length ? (
        inDialog ? (
          list("mpick__list")
        ) : (
          <AnchoredPopover
            anchorRef={fieldRef}
            minWidth
            container={fieldRef.current?.closest(".flow-root")}
          >
            {list("mpick__list mpick__list--floating")}
          </AnchoredPopover>
        )
      ) : null}
      <p className="mpick__status" role="status" aria-live="polite">
        {expanded ? status : null}
      </p>
    </div>
  );
}
