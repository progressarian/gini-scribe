export function moActions({
  chosenOutcome = null,
  plan = "",
  canClose = false,
  reportsReady = false,
} = {}) {
  const hasPlan = String(plan || "").trim().length > 0;

  if (reportsReady && chosenOutcome === "normal") {
    return {
      showHandOver: false,
      showClose: true,
      closeDisabled: !hasPlan,
      note: hasPlan ? null : "Write a plan before closing this patient",
    };
  }

  if (reportsReady && chosenOutcome === "needs_consultant") {
    return {
      showHandOver: true,
      handOverDisabled: !hasPlan,
      showClose: false,
      note: hasPlan ? null : "Write a plan before handing this patient over",
    };
  }

  if (reportsReady) {
    return {
      showHandOver: true,
      handOverDisabled: !hasPlan,
      showClose: false,
      note: hasPlan
        ? "Read the reports and say what they show before closing"
        : "Write a plan before closing this patient",
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
