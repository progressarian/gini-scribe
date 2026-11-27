import { moActions } from "../../src/lib/moActions.js";

let failed = 0;
const check = (label, got, want) => {
  const ok = Object.entries(want).every(([k, v]) => got[k] === v);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`,
  );
};

console.log("Plan written");
check("closeable patient -> both offered, enabled", moActions({ canClose: true, plan: "Plan" }), {
  showHandOver: true,
  handOverDisabled: false,
  showClose: true,
  closeDisabled: false,
  note: null,
});
check("not closeable -> hand over only", moActions({ canClose: false, plan: "Plan" }), {
  showHandOver: true,
  showClose: false,
});

console.log("\nNo plan");
check("hand over and close disabled", moActions({ canClose: true, plan: "" }), {
  handOverDisabled: true,
  closeDisabled: true,
});
check("whitespace-only plan counts as no plan", moActions({ canClose: true, plan: "   \n  " }), {
  handOverDisabled: true,
  closeDisabled: true,
});

console.log("\nNext visit");
check(
  "no next visit -> close disabled, told why",
  moActions({ canClose: true, plan: "Plan", hasNextVisit: false }),
  { showClose: true, closeDisabled: true, note: "Set the next visit before closing this patient" },
);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
