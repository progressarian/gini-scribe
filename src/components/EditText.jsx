import { useState, useEffect } from "react";
import "./EditText.css";

// Editable text span (click to edit, hidden controls on print)
export default function EditText({ value, onChange, style: s }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  if (editing)
    return (
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          onChange(val);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onChange(val);
            setEditing(false);
          }
        }}
        autoFocus
        className="edit-text__input"
        style={s}
      />
    );
  return (
    <span onClick={() => setEditing(true)} className="edit-text__display editable-hover" style={s}>
      {value}
    </span>
  );
}
