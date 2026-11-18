import { useEffect, useRef } from "react";
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
  const groupRef = useRef(null);

  const labels = options.map((o) => o.label).join("|");

  useEffect(() => {
    const group = groupRef.current;
    const pill = group?.querySelector('[aria-pressed="true"]');
    if (!group || !pill || group.scrollWidth <= group.clientWidth) return;
    const box = group.getBoundingClientRect();
    const at = pill.getBoundingClientRect();
    if (at.left < box.left || at.right > box.right) {
      group.scrollTo({
        left: group.scrollLeft + at.left - box.left - (box.width - at.width) / 2,
      });
    }
  }, [value, labels]);

  return (
    <div ref={groupRef} className="ph-pills" role="group" aria-label={label}>
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
