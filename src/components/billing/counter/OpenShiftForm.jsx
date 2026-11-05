import { useState } from "react";
import { useOpenShift } from "../../../queries/hooks/useBilling";
import useAuthStore from "../../../stores/authStore";
import { errorOf } from "../format";
import { cashTyped } from "../staff/staffText";
import { SHIFT_FORM, shiftFormKey } from "./counterForm";
import { useSavedForm } from "./useSavedForm";

export default function OpenShiftForm({ form, onOpening }) {
  const openShift = useOpenShift();
  const [error, setError] = useState(null);
  const { opening } = form.value;

  const open = async () => {
    setError(null);
    onOpening?.();
    try {
      await openShift.mutateAsync(opening.trim() ? { opening_cash: opening.trim() } : {});
      form.clear();
    } catch (e) {
      setError(errorOf(e, "That shift could not be opened"));
    }
  };

  return (
    <>
      <div className="bc-head__row">
        <label className="bc-field">
          <span className="bc-field__lbl">Opening cash</span>
          <input
            className="bc-field__in"
            inputMode="decimal"
            value={opening}
            onChange={(e) => form.set("opening", cashTyped(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="st-btn st-btn-grn"
          disabled={openShift.isPending}
          onClick={open}
        >
          {openShift.isPending ? "Opening…" : "Open shift"}
        </button>
      </div>
      {error && <div className="bc-err">{error}</div>}
    </>
  );
}

export function SavedOpenShiftForm() {
  const userId = useAuthStore((s) => s.currentDoctor?.id);
  const form = useSavedForm(shiftFormKey(userId), SHIFT_FORM);
  return <OpenShiftForm form={form} />;
}
