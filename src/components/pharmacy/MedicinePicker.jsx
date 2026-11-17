import { useEffect, useId, useState } from "react";
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
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

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
      <label htmlFor={id} className="mpick__label">
        {label}
      </label>
      <input
        id={id}
        className="jb-assign"
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
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label} results`}
        className="mpick__list"
        hidden={!expanded || !options.length}
      >
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
      <p className="mpick__status" role="status" aria-live="polite">
        {expanded ? status : null}
      </p>
    </div>
  );
}
