import { Navigate, useLocation } from "react-router-dom";
import { receptionBillHref } from "../../components/billing/counter/billHref";

export default function BillingCounterPage() {
  const { search, state } = useLocation();
  const kept = Object.fromEntries(
    [...new URLSearchParams(search)].filter(([key]) => key !== "tab"),
  );
  return <Navigate replace to={receptionBillHref(kept)} state={state} />;
}
