import { UPI_APP_LABEL } from "../../../../shared/billingVocab.js";

export default function UpiAppField({
  value,
  onChange,
  className = "bc-field",
  labelClassName = "bc-field__lbl",
  selectClassName = "bc-field__in",
  label = "UPI app",
}) {
  return (
    <label className={className}>
      <span className={labelClassName}>{label}</span>
      <select
        className={selectClassName}
        value={value || ""}
        required
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          Choose the app
        </option>
        {Object.entries(UPI_APP_LABEL).map(([app, text]) => (
          <option key={app} value={app}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
