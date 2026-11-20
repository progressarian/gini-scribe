import { useState } from "react";
import { useCurrentShift } from "../../../queries/hooks/useBilling";
import EarlierShiftDialog from "./EarlierShiftDialog";
import { shiftReminder } from "./shiftReminder";

export function useEarlierShiftCheck() {
  const { data: shift } = useCurrentShift();
  const [pending, setPending] = useState(null);
  const due = shiftReminder(shift) === "earlier" && !shift?.close_skipped_today;

  const guard =
    (action) =>
    (...args) => {
      if (!due) return action(...args);
      setPending({ run: () => action(...args), shift });
      return undefined;
    };

  const dialog = pending ? (
    <EarlierShiftDialog
      shift={pending.shift}
      onContinue={() => {
        setPending(null);
        pending.run();
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { guard, dialog };
}
