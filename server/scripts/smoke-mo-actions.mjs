import { moActions } from "../../src/lib/moActions.js";

let failed = 0;
const check = (label, got, want) => {
  const ok = Object.entries(want).every(([k, v]) => got[k] === v);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`,
  );
};

console.log("Reports are in — MO has chosen NORMAL");
check(
  "plan written -> Close only, enabled",
  moActions({ reportsReady: true, chosenOutcome: "normal", plan: "Reports normal, continuing" }),
  { showHandOver: false, showClose: true, closeDisabled: false, note: null },
);
check(
  "no plan -> Close shown but disabled, told why",
  moActions({ reportsReady: true, chosenOutcome: "normal", plan: "" }),
  { showHandOver: false, showClose: true, closeDisabled: true },
);
check(
  "whitespace-only plan counts as no plan",
  moActions({ reportsReady: true, chosenOutcome: "normal", plan: "   \n  " }),
  { showClose: true, closeDisabled: true },
);

console.log("\nReports are in — MO has chosen NEEDS CONSULTANT");
check(
  "plan written -> hand over only",
  moActions({ reportsReady: true, chosenOutcome: "needs_consultant", plan: "Please review" }),
  { showHandOver: true, handOverDisabled: false, showClose: false, note: null },
);
check(
  "no plan -> hand over disabled",
  moActions({ reportsReady: true, chosenOutcome: "needs_consultant", plan: "" }),
  { showHandOver: true, handOverDisabled: true, showClose: false },
);

console.log("\nReports are in — nothing chosen yet");
check(
  "no Close until the reports are read",
  moActions({ reportsReady: true, chosenOutcome: null, plan: "Something" }),
  { showHandOver: true, showClose: false },
);
check(
  "stale canClose from the server cannot show Close",
  moActions({ reportsReady: true, chosenOutcome: null, plan: "Something", canClose: true }),
  { showClose: false },
);

console.log("\nNo reports on this visit (nothing to review)");
check(
  "closeable patient -> both offered",
  moActions({ reportsReady: false, canClose: true, plan: "Plan" }),
  { showHandOver: true, showClose: true, closeDisabled: false },
);
check(
  "not closeable -> hand over only",
  moActions({ reportsReady: false, canClose: false, plan: "Plan" }),
  { showHandOver: true, showClose: false },
);
check(
  "no plan -> hand over disabled",
  moActions({ reportsReady: false, canClose: true, plan: "" }),
  { handOverDisabled: true, closeDisabled: true },
);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
