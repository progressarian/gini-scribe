import "./Pills.css";

export function Pill({ pressed, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      className={`ph-pill ph-pill--solo${pressed ? " is-on" : ""}`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function PillGroup({ label, options, value, onChange, disabled = false }) {
  return (
    <div className="ph-pills" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={`ph-pill${value === option.key ? " is-on" : ""}`}
          aria-pressed={value === option.key}
          disabled={disabled}
          onClick={() => value !== option.key && onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
