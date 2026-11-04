import { money } from "../dashboard/dashboardText";
import { cashStatus } from "./staffText";

export default function CashBadge({ shift, withAmount = false }) {
  const status = cashStatus(shift);
  const amount =
    withAmount && (status.key === "short" || status.key === "over")
      ? ` ${shift.difference > 0 ? "+" : "−"}${money(Math.abs(shift.difference))}`
      : "";
  return (
    <span className={`bill-status bdash-cash bdash-cash--${status.key}`}>
      {status.label}
      {amount}
    </span>
  );
}
