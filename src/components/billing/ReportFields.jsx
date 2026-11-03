import { useId } from "react";

export function Choice({ label, value, onChange, options, anyLabel }) {
  const id = useId();
  return (
    <div className="fset__field brep-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="jb-assign"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DateField({ label, value, onChange }) {
  const id = useId();
  return (
    <div className="fset__field brep-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        className="jb-assign"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
