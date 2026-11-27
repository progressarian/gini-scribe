export function moActions({ hasNextVisit = true, finalizeHere = false, ...rest } = {}) {
  const acts = planActions({ ...rest, finalizeHere });
  if (!acts.showClose || hasNextVisit) return acts;
  return {
    ...acts,
    closeDisabled: true,
    note:
      acts.note ||
      (finalizeHere
        ? "Set the next visit before finalizing"
        : "Set the next visit before closing this patient"),
  };
}

function planActions({ plan = "", canClose = false, finalizeHere = false }) {
  const hasPlan = String(plan || "").trim().length > 0;
  if (finalizeHere) {
    return {
      showHandOver: false,
      handOverDisabled: true,
      showClose: true,
      closeDisabled: !hasPlan,
      note: hasPlan ? null : "Write a plan before finalizing",
    };
  }
  return {
    showHandOver: true,
    handOverDisabled: !hasPlan,
    showClose: canClose,
    closeDisabled: !hasPlan,
    note: canClose || hasPlan ? null : "Write a plan before closing this patient",
  };
}
