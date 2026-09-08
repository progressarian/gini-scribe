// The questions a journey template can hang a step on.
//
// flow_step_templates.condition_key has carried these since the 2026-06-15 seed
// migration, but nothing read it: every conditional step was included in every
// journey and reception deleted the ones that did not apply. This is the shared
// vocabulary for the gate that now honours it — imported by the reception desk
// (which asks the questions) and by the Settings journey editor (which assigns
// them), so the two screens cannot drift apart on the wording or the keys.

export const CONDITIONS = [
  {
    key: "needs_tests",
    label: "Tests today",
    // Reception's phrasing, not the database's: the desk is answering a
    // question about the patient, not setting a flag.
    question: "Having tests today?",
    hint: "Blood draw, lab billing and the lab's own stages",
  },
  {
    key: "needs_chief",
    label: "Seeing the chief",
    question: "Seeing the chief?",
    hint: "The wait for the chief and the chief's consultation",
  },
  {
    key: "needs_diet",
    label: "Dietitian",
    question: "Seeing the dietitian?",
    hint: "The dietitian's room",
  },
];

export const CONDITION_KEYS = CONDITIONS.map((c) => c.key);

export const conditionLabel = (key) => CONDITIONS.find((c) => c.key === key)?.label || key || "";

export const isConditionKey = (key) => CONDITION_KEYS.includes(key);

// A step with no condition is always in. A step with one is in only when the
// desk has said yes — and an unanswered condition counts as yes, so a template
// that names a condition nobody has been asked about behaves exactly as it did
// before this gate existed.
export function stepPassesConditions(step, answers) {
  const key = step?.conditionKey || step?.condition_key;
  if (!key) return true;
  return answers?.[key] !== false;
}
