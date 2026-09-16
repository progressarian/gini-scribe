import "../loadEnv.js";
import pool from "../config/db.js";
import { journeyProgress } from "../../shared/journeyOrder.js";
import { getDayBoard, getSlaConfig } from "../services/giniflow/board.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

let order = 0;
const step = (name, chain, status = "pending", extra = {}) => ({
  name,
  chain,
  status,
  order: ++order,
  background: false,
  test: false,
  ...extra,
});

const followUp = (vitals = "pending", extra = []) => {
  order = 0;
  return [
    step("Billing", null),
    step("Vitals", "with_vitals", vitals),
    step("Wait for Consultant", "ready_for_doctor"),
    step("SD Consultation", "with_doctor"),
    step("Prescription — Chief to prepare", "rx_pending", "pending", { background: true }),
    step("Wait for Chief", "ready_for_doctor"),
    step("Chief Endocrinologist Assessment", "with_sd"),
    ...extra,
    step("Prescription Explain", "with_rx"),
    step("Pharmacy / Exit", "dispensed"),
  ];
};

const line = (p) => `${p.done}/${p.total} ${p.nextStarted ? "now" : "next"}: ${p.next}`;

console.log("next station");

const arrived = journeyProgress(followUp(), "checked_in");
check(
  "checked in: vitals is next, not the billing counter",
  arrived.next === "Vitals",
  line(arrived),
);

const atVitals = journeyProgress(followUp("in_progress"), "with_vitals");
check("at vitals: now vitals", atVitals.next === "Vitals" && atVitals.nextStarted, line(atVitals));

const waitingChief = journeyProgress(followUp("done"), "vitals_done");
check(
  "vitals done: the Chief, whatever order the template lists the rooms in",
  waitingChief.next === "Chief Endocrinologist Assessment" && !waitingChief.nextStarted,
  line(waitingChief),
);
check(
  "vitals done: billing and vitals are behind them",
  waitingChief.done === 2,
  line(waitingChief),
);
check("background steps are not counted as stops", waitingChief.total === 8, line(waitingChief));

const withChief = journeyProgress(followUp("done"), "with_sd");
check(
  "in the Chief's room: now the Chief",
  withChief.next === "Chief Endocrinologist Assessment" && withChief.nextStarted,
  line(withChief),
);

const afterChief = journeyProgress(followUp("done"), "ready_for_doctor");
check(
  "after the Chief: the consultant, not the waiting area",
  afterChief.next === "SD Consultation",
  line(afterChief),
);

const rxWait = journeyProgress(
  followUp("done").map((s) => (s.background ? { ...s, status: "in_progress" } : s)),
  "rx_pending",
);
check(
  "prescription being written: next is the Rx desk, never the background step",
  rxWait.next === "Prescription Explain" && !rxWait.nextStarted,
  line(rxWait),
);

const withTests = followUp("done", [
  step("Blood Sample", null, "pending", { test: true }),
  step("Dietitian", null),
]);
const testsFirst = journeyProgress(withTests, "vitals_done");
check(
  "an open test comes before the doctors",
  testsFirst.next === "Blood Sample",
  line(testsFirst),
);
const testsLate = journeyProgress(withTests, "rx_pending");
check(
  "a test never taken is not 'next' once the doctor is done",
  testsLate.next === "Prescription Explain",
  line(testsLate),
);
const dietitian = journeyProgress(withTests, "with_sd");
check(
  "a stop with no floor status follows the room listed before it",
  dietitian.next === "Chief Endocrinologist Assessment",
  line(dietitian),
);
const afterRooms = journeyProgress(
  withTests.map((s) => (s.chain === "with_sd" ? { ...s, status: "done" } : s)),
  "doctor_done",
);
check("then the dietitian", afterRooms.next === "Dietitian", line(afterRooms));

const blocked = journeyProgress(followUp("done"), "blocked_reports", "vitals_done");
check(
  "an exception status reads from where they will resume",
  blocked.next === "Chief Endocrinologist Assessment",
  line(blocked),
);

const exited = journeyProgress(followUp("done"), "exited");
check("finished: every stop behind them", exited.next === null && exited.done === exited.total);

check("no steps: no journey line", journeyProgress([], "vitals_done") === null);

console.log("\ntoday's board (read-only)");

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const board = await getDayBoard(today, await getSlaConfig(pool));
const chainCards = board.columns
  .filter((c) => c.statuses && c.key !== "done")
  .flatMap((c) => c.cards);
const billingNext = chainCards.filter((c) => c.journey?.next === "Billing");
check(
  "no patient on the floor is sent back to the billing counter",
  billingNext.length === 0,
  billingNext.map((c) => `${c.name} (${c.status})`).join("; "),
);
const chiefWaiters = chainCards.filter((c) => c.status === "vitals_done" && c.journey);
check(
  "every patient waiting for the Chief after vitals is told the Chief or a test is next",
  chiefWaiters.every((c) =>
    /Chief|Test|Sample|Billing|X-?RAY|Echo|ECG|VPT|Fundus|ABI|TMT/i.test(c.journey.next || ""),
  ),
  chiefWaiters
    .filter((c) => !/Chief|Test|Sample|Billing/i.test(c.journey.next || ""))
    .map((c) => `${c.name}: ${c.journey.next}`)
    .join("; "),
);
console.log(`  ·  ${chainCards.length} card(s) on the chain columns`);

await pool.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
