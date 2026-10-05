import { useState } from "react";
import { useAddBillLine } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise, moneyTyped } from "../format";

const priceText = (line, source) =>
  line.price === null
    ? "price for this patient"
    : `${fromPaise(line.price)}${line.price !== line.amount ? ` · ${source} ${fromPaise(line.amount)}` : ""}`;

export default function SuggestedBillLines({ bill, onBill, lines, notMatched, source }) {
  const addLine = useAddBillLine();
  const [prices, setPrices] = useState({});
  const [error, setError] = useState(null);
  const priceOf = (line) => prices[line.item_id] ?? String(line.amount / 100);

  const addLines = async (chosen) => {
    setError(null);
    try {
      let latest = null;
      for (const line of chosen) {
        latest = await addLine.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          item_id: line.item_id,
          ...(line.price_per_patient ? { agreed_rate: priceOf(line).trim() } : {}),
        });
      }
      if (latest) onBill(latest);
    } catch (e) {
      setError(errorOf(e, "That line could not be added"));
    }
  };

  return (
    <>
      <ul className="bc-labcase">
        {lines.map((line) => (
          <li key={line.item_id} className="bc-labcase__row">
            <span className="bc-labcase__name">
              {line.desc}
              <span className="bc-labcase__service">
                {line.item_name} · {priceText(line, source)}
              </span>
            </span>
            {line.price_per_patient && (
              <input
                className="bc-field__in bc-result__price"
                inputMode="decimal"
                aria-label={`${line.item_name}: price for this patient`}
                value={priceOf(line)}
                onChange={(e) =>
                  setPrices((was) => ({ ...was, [line.item_id]: moneyTyped(e.target.value) }))
                }
              />
            )}
            <button
              type="button"
              className="st-btn st-btn-grn"
              aria-label={`Add ${line.item_name}`}
              disabled={addLine.isPending || (line.price_per_patient && !priceOf(line).trim())}
              onClick={() => addLines([line])}
            >
              Add
            </button>
          </li>
        ))}
        {notMatched.map((line) => (
          <li key={line.desc} className="bc-labcase__row">
            <span className="bc-labcase__name">
              {line.desc}
              <span className="bc-labcase__service">
                {fromPaise(line.amount)} · not in billing — link it in Settings → Services
              </span>
            </span>
          </li>
        ))}
      </ul>
      {lines.length > 1 && (
        <button
          type="button"
          className="st-btn st-btn-grn bc-labcase__all"
          disabled={addLine.isPending}
          onClick={() => addLines(lines)}
        >
          Add all ({lines.length})
        </button>
      )}
      {error && <div className="bc-err">{error}</div>}
    </>
  );
}
