import Dropdown from "../ui/Dropdown";
import DatePicker from "../DatePicker";
import "./Fields.css";

const DATE_STYLE = {
  height: 36,
  padding: "0 32px 0 34px",
  borderRadius: 8,
  border: "1px solid var(--ui-field)",
  fontSize: 13,
  color: "var(--ui-ink)",
};

export const optionsOf = (labels) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

export function SelectInput({ className = "", ...props }) {
  return <Dropdown className={`ph-dd ${className}`.trim()} {...props} />;
}

export function DateInput({ placeholder = "Choose a date", clearable = false, style, ...props }) {
  return (
    <DatePicker
      yearNav
      clearable={clearable}
      placeholder={placeholder}
      style={{ ...DATE_STYLE, ...style }}
      {...props}
    />
  );
}
