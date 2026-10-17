import { resolveAssignee } from "../crm/assignees.js";

const staff = [
  { id: "v", full_name: "Virender Satija", role: "head_of_growth" },
  { id: "r", full_name: "Rajesh Sharma", role: "growth_executive" },
  { id: "s", full_name: "Sandeep Sangroy", role: "growth_executive" },
];
const others = [
  { id: "c", full_name: "Sandeep", role: "ceo_admin" },
  { id: "g", full_name: "Gurjot", role: "ceo_admin" },
];

const cases = [
  ["Rajesh Sharma", "matched", "r", null],
  ["  rajesh   SHARMA ", "matched", "r", null],
  ["Rajesh sharma", "matched", "r", null],
  ["Virender", "matched", "v", "Matched by first name"],
  ["Sandeep", "matched", "s", "Matched by first name"],
  ["Satija", "matched", "v", "Matched by surname"],
  ["Sandeep Sangory", "matched", "s", "Check spelling"],
  ["Sandeep sangroy", "matched", "s", null],
  ["Mr. Rajesh Sharma", "matched", "r", null],
  ["Ramesh", "failed", null, null, "r"],
  ["Rajsh Sharma", "failed", null, null, "r"],
  ["Gurjot", "failed", null, null, null],
  ["Nobody Here", "failed", null, null, null],
  ["", "blank", null, null],
];

let failed = 0;
for (const [typed, status, id, note, suggestion] of cases) {
  const got = resolveAssignee(typed, staff, others);
  const ok =
    got.status === status &&
    (id == null || got.assignee?.id === id) &&
    (status !== "matched" || (got.note ?? null) === note) &&
    (suggestion === undefined || (got.suggestion?.id ?? null) === suggestion);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${JSON.stringify(typed)} -> ${JSON.stringify(got)}`);
}

const twoRajesh = [...staff, { id: "r2", full_name: "Rajesh Kumar", role: "growth_executive" }];
const amb = resolveAssignee("Rajesh", twoRajesh, others);
const ambOk = amb.status === "failed" && /Matches 2 staff/.test(amb.reason);
if (!ambOk) failed++;
console.log(`${ambOk ? "ok  " : "FAIL"} "Rajesh" with two Rajeshes -> ${JSON.stringify(amb)}`);

console.log(failed ? `\n${failed} case(s) failed` : "\nall cases passed");
process.exit(failed ? 1 : 0);
