import { useState } from "react";
import { useAddLabCaseTests, useLabCaseTests } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import LoadingCard from "./LoadingCard";

function serviceText(test, needsCategory) {
  const price = needsCategory || test.price === null ? "" : ` · ${fromPaise(test.price)}`;
  const removed = test.removed ? " · removed from this bill earlier" : "";
  return `${test.item_name}${price}${removed}`;
}

export default function LabCaseTests({ bill, onBill, needsCategory }) {
  const draft = bill.status === "draft";
  const { data, isLoading } = useLabCaseTests(bill.id, bill.version, { enabled: draft });
  const add = useAddLabCaseTests();
  const [error, setError] = useState(null);

  if (draft && isLoading) {
    return <LoadingCard title="From today's lab report" text="Checking today's lab report…" />;
  }
  if (!draft || !data?.shown) return null;
  const { tests, not_priced: notPriced } = data;

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
        From today's lab report<span className="grp-split">{tests.length + notPriced.length}</span>
      </h3>
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
              disabled={add.isPending}
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
      {tests.length > 1 && (
        <button
          type="button"
          className="st-btn st-btn-grn bc-labcase__all"
          disabled={add.isPending}
          onClick={() =>
            addTests(
              tests.map((test) => test.item_id),
              "These tests could not be added",
            )
          }
        >
          Add all ({tests.length})
        </button>
      )}
      {error && <div className="bc-err">{error}</div>}
    </section>
  );
}
