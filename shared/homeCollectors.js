export const HOME_COLLECTORS = ["Harwinder", "Pratham"];

export const HOME_PAY_MODES = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
];

export const HOME_AMOUNT_MAX = 100000;
export const HOME_NOTE_MAX = 160;
const CLOCK_SKEW_MIN = 2;
export const FUTURE_TIME = "The collection time can't be in the future";

const minutesOf = (clock) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(clock || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function homeSampleProblems(answer, nowClock, { brief = false } = {}) {
  const problems = {};
  if (!["collected", "not_collected"].includes(answer?.sample)) {
    problems.sample = "Choose whether the sample was collected at home";
    return problems;
  }
  if (answer.sample === "not_collected" || brief) return problems;
  if (answer.collectedTime) {
    const at = minutesOf(answer.collectedTime);
    if (at === null) problems.collectedTime = "Enter the time as HH:MM, or leave it empty";
    else if (nowClock && at > minutesOf(nowClock) + CLOCK_SKEW_MIN)
      problems.collectedTime = FUTURE_TIME;
  }
  if (!HOME_COLLECTORS.includes(answer.collectedBy))
    problems.collectedBy = `Choose who collected it: ${HOME_COLLECTORS.join(" or ")}`;
  if (!["paid", "pending"].includes(answer.payment)) {
    problems.payment = "Choose whether the payment was made at home";
    return problems;
  }
  if (answer.payment === "paid") {
    const amount = Number(answer.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > HOME_AMOUNT_MAX)
      problems.amount = `Enter the amount in whole rupees, from ₹1 to ₹${HOME_AMOUNT_MAX.toLocaleString("en-IN")}`;
    if (!HOME_PAY_MODES.some((m) => m.value === answer.mode))
      problems.mode = "Choose how the patient paid";
  }
  return problems;
}

const STILL_NEEDED = {
  sample: "collected at home or not",
  collectedTime: "collection time",
  collectedBy: "collected by",
  payment: "paid at home or pending",
  amount: "amount paid",
  mode: "how they paid",
};

export const homeStillNeeded = (problems) =>
  Object.keys(STILL_NEEDED)
    .filter((key) => problems[key])
    .map((key) =>
      key === "collectedTime" && problems[key] === FUTURE_TIME
        ? "collection time (it can't be in the future)"
        : STILL_NEEDED[key],
    );

const modeLabel = (mode) => HOME_PAY_MODES.find((m) => m.value === mode)?.label || mode;

export function homeRecordText(record, clockOf) {
  if (!record) return { sample: "Not recorded", payment: "Not recorded", pending: false };
  if (record.sample === "not_collected")
    return { sample: "Not collected", payment: null, pending: false };
  const sample =
    `Collected at home ${[clockOf(record.collectedAt), record.collectedBy && `(${record.collectedBy})`].filter(Boolean).join(" ")}`.trim();
  if (record.payment === "paid")
    return {
      sample,
      payment: `Paid at home (reported) ₹${Number(record.amount).toLocaleString("en-IN")} · ${modeLabel(record.mode)}`,
      pending: false,
    };
  if (record.payment === "pending") return { sample, payment: "Payment pending", pending: true };
  return { sample, payment: null, pending: false };
}
