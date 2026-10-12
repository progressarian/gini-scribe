import { useState } from "react";
import {
  useAddLabCaseTests,
  useLabCaseTests,
  useRemoveBillLine,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import LoadingCard from "./LoadingCard";

function serviceText(test, needsCategory) {
  const price = needsCategory || test.price === null ? "" : ` · ${fromPaise(test.price)}`;
  const removed = test.removed ? " · removed from this bill earlier" : "";
  const refunded = test.refunded ? " · refunded in HealthRay today — add only if billed again" : "";
  return `${test.item_name}${price}${removed}${refunded}`;
}

export default function LabCaseTests({ bill, onBill, needsCategory }) {
  const draft = bill.status === "draft";
  const { data, isLoading } = useLabCaseTests(bill.id, bill.version, { enabled: draft });
  const add = useAddLabCaseTests();
  const remove = useRemoveBillLine();
  const [error, setError] = useState(null);

  if (draft && isLoading) {
    return <LoadingCard title="From today's lab report" text="Checking today's lab report…" />;
  }
  if (!draft || !data?.shown) return null;
  const { tests, not_priced: notPriced, refunded_on_bill: refundedOnBill = [] } = data;
  const addable = tests.filter((test) => !test.refunded);
  const busy = add.isPending || remove.isPending;

  const removeRefunded = async (line) => {
    setError(null);
    try {
      onBill(
        await remove.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          lineId: line.line_id,
          reason: "Refunded in HealthRay",
        }),
      );
    } catch (e) {
      setError(errorOf(e, `${line.bill_name} could not be removed`));
    }
  };

  const addTests = async (itemIds, fallback) => {
    setError(null);
    try {
      onBill(await add.mutateAsync({ billId: bill.id, visitId: bill.visit_id, itemIds }));
    } catch (e) {
      setError(errorOf(e, fallback));
    }
  };

  return (
    <section className="bc-card" aria-label="From today's lab report">
      <h3 className="bc-card__title">
        From today's lab report
        <span className="grp-split">{tests.length + notPriced.length + refundedOnBill.length}</span>
      </h3>
      {refundedOnBill.length > 0 && (
        <ul className="bc-labcase" aria-label="Refunded in HealthRay">
          {refundedOnBill.map((line) => (
            <li key={line.line_id} className="bc-labcase__row">
              <span className="bc-labcase__name">
                ⚠ {line.bill_name}
                <span className="bc-labcase__service">
                  on this bill from the lab report, but refunded in HealthRay today
                </span>
              </span>
              <button
                type="button"
                className="st-btn st-btn-g"
                aria-label={`Remove ${line.bill_name}`}
                disabled={busy}
                onClick={() => removeRefunded(line)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="bc-labcase">
        {tests.map((test) => (
          <li key={test.item_id} className="bc-labcase__row">
            <span className="bc-labcase__name">
              {test.test_name}
              <span className="bc-labcase__service">{serviceText(test, needsCategory)}</span>
            </span>
            <button
              type="button"
              className="st-btn st-btn-grn"
              aria-label={`Add ${test.item_name}`}
              disabled={busy}
              onClick={() => addTests([test.item_id], `${test.item_name} could not be added`)}
            >
              Add
            </button>
          </li>
        ))}
        {notPriced.map((name) => (
          <li key={name} className="bc-labcase__row">
            <span className="bc-labcase__name">
              {name}
              <span className="bc-labcase__service">no price — link it in Settings → Services</span>
            </span>
          </li>
        ))}
      </ul>
      {addable.length > 1 && (
        <button
          type="button"
          className="st-btn st-btn-grn bc-labcase__all"
          disabled={busy}
          onClick={() =>
            addTests(
              addable.map((test) => test.item_id),
              "These tests could not be added",
            )
          }
        >
          Add all ({addable.length})
        </button>
      )}
      {error && <div className="bc-err">{error}</div>}
    </section>
  );
}
