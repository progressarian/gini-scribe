import { cloneElement, useId } from "react";
import "./FormField.css";

export default function FormField({
  label,
  hint,
  error,
  required = false,
  className = "",
  children,
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`fset__field ${className}`.trim()}>
      <label htmlFor={id} id={`${id}-label`}>
        {label}
        {required ? (
          <span className="form-field__required" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {cloneElement(children, {
        id,
        required,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })}
      {hint ? (
        <small id={hintId} className="flow-muted">
          {hint}
        </small>
      ) : null}
      {error ? (
        <small id={errorId} className="form-field__error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}
