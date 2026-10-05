import { useHealthrayBillLines } from "../../../queries/hooks/useBilling";
import SuggestedBillLines from "./SuggestedBillLines";
import LoadingCard from "./LoadingCard";

export default function HealthrayBillLines({ bill, onBill }) {
  const draft = bill.status === "draft";
  const { data, isLoading } = useHealthrayBillLines(bill.id, bill.version, { enabled: draft });

  if (draft && isLoading) {
    return (
      <LoadingCard title="On today's HealthRay bill" text="Checking today's HealthRay bill…" />
    );
  }
  if (!draft || !data?.shown) return null;
  const { lines, not_matched: notMatched } = data;

  return (
    <section className="bc-card" aria-label="On today's HealthRay bill">
      <h3 className="bc-card__title">
        On today's HealthRay bill
        <span className="grp-split">{lines.length + notMatched.length}</span>
      </h3>
      <div className="bc-hint">Billed in HealthRay but not on this bill yet.</div>
      <SuggestedBillLines
        bill={bill}
        onBill={onBill}
        lines={lines}
        notMatched={notMatched}
        source="HealthRay"
      />
    </section>
  );
}
