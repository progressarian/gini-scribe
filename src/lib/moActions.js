export function moActions({ hasNextVisit = true, ...rest } = {}) {
  const acts = planActions(rest);
  if (!acts.showClose || hasNextVisit) return acts;
  return {
    ...acts,
    closeDisabled: true,
    note: acts.note || "Set the next visit before closing this patient",
  };
}

function planActions({ plan = "", canClose = false }) {
  const hasPlan = String(plan || "").trim().length > 0;
  return {
    showHandOver: true,
    handOverDisabled: !hasPlan,
    showClose: canClose,
    closeDisabled: !hasPlan,
    note: canClose || hasPlan ? null : "Write a plan before closing this patient",
  };
}
