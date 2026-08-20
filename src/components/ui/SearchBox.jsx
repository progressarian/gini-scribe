import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import "./SearchBox.css";

export default function SearchBox({ value, onChange, placeholder, label = "Search" }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open && !value) {
    return (
      <button
        type="button"
        className="sbox__toggle"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
      >
        <Search size={16} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="sbox">
      <Search className="sbox__icon" size={15} aria-hidden="true" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => !value && setOpen(false)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          onChange("");
          setOpen(false);
        }}
        placeholder={placeholder}
        className="sbox__input"
      />
      {value && (
        <button
          type="button"
          className="sbox__clear"
          onClick={() => {
            onChange("");
            setOpen(false);
          }}
          aria-label="Clear search"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
