import { useCallback, useMemo, useState } from "react";
import FilterPopover from "../../ui/FilterPopover";

export const pickedLabel = (doctors) =>
  !doctors.length
    ? "All consultants"
    : doctors.length === 1
      ? doctors[0]
      : `${doctors.length} selected`;

export default function ConsultantPicker({ options, selected, onChange }) {
  const [draft, setDraft] = useState(null);
  const [term, setTerm] = useState("");
  const chosen = draft ?? selected;
  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, term]);
  const discard = useCallback(() => {
    setDraft(null);
    setTerm("");
  }, []);
  const toggle = (name) =>
    setDraft(chosen.includes(name) ? chosen.filter((n) => n !== name) : [...chosen, name]);
  return (
    <div className="fset__field brep-field">
      <span>Consultant</span>
      <FilterPopover
        label={pickedLabel(selected)}
        title="Choose consultants"
        activeCount={selected.length}
        applyLabel="Apply"
        onApply={() => {
          if (draft) onChange(draft);
        }}
        onClose={discard}
        onReset={() => setDraft([])}
      >
        <div className="opd-picker">
          <input
            type="search"
            className="jb-assign"
            aria-label="Search consultants"
            placeholder="Search by name"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
          <ul>
            {shown.map((option) => (
              <li key={option.name}>
                <label className="fset__check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(option.name)}
                    onChange={() => toggle(option.name)}
                  />
                  {option.name} <span className="bdash-muted">({option.visits})</span>
                </label>
              </li>
            ))}
            {!shown.length ? <li className="bdash-muted">No consultants match.</li> : null}
          </ul>
        </div>
      </FilterPopover>
    </div>
  );
}
