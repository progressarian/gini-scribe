import { needsUpiApp, TAKE_MODE_LABEL } from "./lineText";
import UpiAppField from "./UpiAppField";

export const PAID_MODES = Object.keys(TAKE_MODE_LABEL);

const REFERENCE_HINT = {
  upi: "UPI transaction ID",
  neft: "UTR or cheque no.",
};

export const needsReference = (mode) => !!mode && mode !== "cash";

export const paidModeProblem = ({ mode, upiApp, reference }) => {
  if (!mode) return "Choose how the patient paid — cash, card, UPI or NEFT / cheque.";
  if (needsUpiApp(mode) && !upiApp) return "Choose the UPI app.";
  return null;
};

export const paidModeBody = ({ mode, upiApp, reference }) => ({
  mode,
  reference: needsReference(mode) ? reference.trim() || null : null,
  upiApp: needsUpiApp(mode) ? upiApp : null,
});

export default function PaidModeFields({
  label,
  value,
  onChange,
  modes = PAID_MODES,
  placeholder,
}) {
  const { mode, upiApp, reference } = value;
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <label className="bc-field">
        <span className="bc-field__lbl">{label}</span>
        <select
          className="bc-field__in"
          value={mode}
          aria-invalid={placeholder && !mode ? true : undefined}
          onChange={(e) => set({ mode: e.target.value })}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {modes.map((m) => (
            <option key={m} value={m}>
              {TAKE_MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      {needsUpiApp(mode) && (
        <UpiAppField value={upiApp} onChange={(next) => set({ upiApp: next })} />
      )}
      {needsReference(mode) && (
        <label className="bc-field">
          <span className="bc-field__lbl">Reference (optional)</span>
          <input
            className="bc-field__in"
            value={reference}
            maxLength={60}
            placeholder={REFERENCE_HINT[mode] ?? "Last 4 digits or slip no."}
            onChange={(e) => set({ reference: e.target.value })}
          />
        </label>
      )}
    </>
  );
}
