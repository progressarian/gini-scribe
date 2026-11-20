import { useCloseShift } from "../../../queries/hooks/useBilling";
import useAuthStore from "../../../stores/authStore";
import { countedProblem, countedWarning } from "../staff/staffText";
import { noteCountTotal, noteCountUsed, SHIFT_FORM, shiftFormKey } from "./counterForm";
import { useSavedForm } from "./useSavedForm";

export function useCloseShiftForm(shift) {
  const closeShift = useCloseShift();
  const userId = useAuthStore((s) => s.currentDoctor?.id);
  const form = useSavedForm(shiftFormKey(userId), SHIFT_FORM);
  const { counted, note } = form.value;
  const notes = form.value.notes ?? {};
  const byNotes = noteCountUsed(notes);
  const expected = Number(shift?.expected_cash ?? 0);
  const countedAmount = byNotes ? noteCountTotal(notes) / 100 : Number(counted || 0);
  const countedError = byNotes ? null : countedProblem(counted);
  const countWarning = countedError
    ? null
    : countedWarning(Math.round(countedAmount * 100), Math.round(expected * 100));

  const close = async () => {
    const closed = await closeShift.mutateAsync({
      ...(byNotes
        ? {
            counted_cash: countedAmount.toFixed(2),
            denominations: Object.fromEntries(
              Object.entries(notes)
                .filter(([, value]) => Number(value) > 0)
                .map(([key, value]) => [key, key === "coins" ? value : Number(value)]),
            ),
          }
        : { counted_cash: counted.trim() }),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    form.clear();
    return closed;
  };

  return {
    form,
    counted,
    note,
    notes,
    byNotes,
    expected,
    countedAmount,
    countedError,
    countWarning,
    difference: Number((countedAmount - expected).toFixed(2)),
    canClose: !(!byNotes && countedError) && !closeShift.isPending,
    pending: closeShift.isPending,
    setCounted: (next) => form.set("counted", next),
    setNote: (next) => form.set("note", next),
    setNotes: (patch) => form.set("notes", { ...notes, ...patch }),
    clearNotes: () => form.set("notes", {}),
    close,
  };
}
