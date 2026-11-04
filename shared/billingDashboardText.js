export const dashboardFileName = ({ period, from, to }) =>
  `billing-mis-${period}-wise-${from}-to-${to}.xlsx`;

export const SHEET_MONEY = ["cash", "card", "upi_bharatpe", "upi_paytm", "neft"];

export const MIS_EXTRA_COLUMNS = [
  { key: "tax", label: "Tax" },
  { key: "round_off", label: "Round off" },
  { key: "claim", label: "To be claimed" },
  { key: "not_final_revenue", label: "Paid, not finalised" },
];

export const DISCOUNT_PARTS = [
  { key: "category_reduction", label: "of which category rates" },
  { key: "adjustment", label: "of which written off" },
];

export const PENDING_PARTS = [
  {
    key: "earlier_dues",
    effect: -1,
    label: "Money for bills dated on other days (dues paid, refunds of older bills)",
  },
  { key: "to_deposit", effect: -1, label: "Extra paid by patients (kept as deposit)" },
  { key: "unbilled", effect: -1, label: "Paid on bills not counted yet (part-paid drafts)" },
  { key: "from_deposit", effect: 1, label: "Bills paid from an earlier deposit" },
  { key: "kept_as_deposit", effect: -1, label: "Refunds kept as deposit (no money paid back)" },
  {
    key: "unsettled",
    effect: 1,
    label: "Not settled in this period (billed but unpaid, or a refund not paid back yet)",
  },
];

const EXPLAINING = PENDING_PARTS.filter((part) => part.key !== "unsettled");

export const unsettledOf = (pending, parts) =>
  pending - EXPLAINING.reduce((sum, part) => sum + part.effect * (parts[part.key] ?? 0), 0);

export const pendingEffects = (parts) =>
  PENDING_PARTS.map((part) => ({ ...part, amount: part.effect * (parts?.[part.key] ?? 0) })).filter(
    (part) => part.amount,
  );

export function misLayout(data) {
  const total = data.total;
  return {
    moneyColumns: data.columns.money.filter(
      (column) => SHEET_MONEY.includes(column.key) || total.money[column.key],
    ),
    extras: MIS_EXTRA_COLUMNS.filter((column) => total[column.key]),
    discountParts: DISCOUNT_PARTS.filter((column) => total[column.key]),
    cashOut: data.filters.period === "month" && total.cash_taken_out !== null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const partsOf = (day) => {
  const [year, month, date] = day.split("-").map(Number);
  return { year, month: MONTHS[month - 1], date };
};

export const dayLabel = (day) => {
  const { date, month } = partsOf(day);
  return `${date} ${month}`;
};

export const fullDayLabel = (day) => {
  const { date, month, year } = partsOf(day);
  return `${date} ${month} ${year}`;
};

export const rangeLabel = (from, to) => {
  if (from === to) return fullDayLabel(from);
  const a = partsOf(from);
  const b = partsOf(to);
  if (a.year === b.year && a.month === b.month) return `${a.date}–${b.date} ${b.month} ${b.year}`;
  if (a.year === b.year) return `${a.date} ${a.month} – ${b.date} ${b.month} ${b.year}`;
  return `${fullDayLabel(from)} – ${fullDayLabel(to)}`;
};

export function bucketLabel(row, period) {
  if (period === "day") return dayLabel(row.bucket);
  if (period === "week") {
    const a = partsOf(row.start);
    const b = partsOf(row.end);
    const days =
      a.month === b.month
        ? `${a.date}–${b.date} ${b.month}`
        : `${a.date} ${a.month}–${b.date} ${b.month}`;
    return `Wk ${row.week} · ${days}`;
  }
  const { month, year } = partsOf(row.bucket);
  return `${month} ${year}`;
}

export const PERIOD_LABELS = { day: "Day", week: "Week", month: "Month" };
