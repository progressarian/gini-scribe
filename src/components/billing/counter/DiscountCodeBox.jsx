import { useState } from "react";
import { useAddCode, useRemoveCode } from "../../../queries/hooks/useBilling";
import { codeTyped, errorOf, fromPaise } from "../format";

export default function DiscountCodeBox({ bill, onBill }) {
  const addCode = useAddCode();
  const removeCode = useRemoveCode();
  const [code, setCode] = useState("");
  const [accepted, setAccepted] = useState(null);
  const [refused, setRefused] = useState(null);

  const codes = bill.codes || [];
  const automatic = (bill.discounts || []).filter((entry) => entry.method === "auto");
  const detailOf = (entered) =>
    (bill.discounts || []).find(
      (entry) => entry.method === "code" && entry.code?.toLowerCase() === entered.toLowerCase(),
    );
  const chipText = (entered) => {
    const detail = detailOf(entered);
    return detail ? `${entered} · ${detail.name} · ${fromPaise(detail.amount)} off` : entered;
  };

  const apply = async (event) => {
    event.preventDefault();
    setAccepted(null);
    setRefused(null);
    const wanted = code.trim();
    if (!wanted) return;
    try {
      onBill(await addCode.mutateAsync({ billId: bill.id, visitId: bill.visit_id, code: wanted }));
      setAccepted(`${wanted} applied`);
      setCode("");
    } catch (e) {
      setRefused(errorOf(e, `The code ${wanted} could not be used on this bill`));
    }
  };

  const drop = async (entered) => {
    setAccepted(null);
    setRefused(null);
    try {
      onBill(
        await removeCode.mutateAsync({ billId: bill.id, visitId: bill.visit_id, code: entered }),
      );
    } catch (e) {
      setRefused(errorOf(e, `The code ${entered} could not be taken off`));
    }
  };

  return (
    <section className="bc-card" aria-label="Discount codes">
      <h3 className="bc-card__title">Discount codes</h3>

      {bill.status === "draft" && (
        <form className="bc-head__row" onSubmit={apply}>
          <label className="bc-field">
            <span className="bc-field__lbl">Discount code</span>
            <input
              className="bc-field__in"
              value={code}
              placeholder="Enter a code"
              onChange={(e) => setCode(codeTyped(e.target.value))}
            />
          </label>
          <button
            type="submit"
            className="st-btn st-btn-grn"
            disabled={!code.trim() || addCode.isPending}
          >
            Apply code
          </button>
        </form>
      )}

      {accepted && <div className="bc-note">{accepted}</div>}
      {refused && <div className="bc-err">{refused}</div>}

      {!!codes.length && (
        <ul className="bc-chips" aria-label="Codes on this bill">
          {codes.map((entered) => (
            <li key={entered} className="bc-chip">
              <span>{chipText(entered)}</span>
              {bill.status === "draft" && (
                <button
                  type="button"
                  className="bc-chip__x"
                  aria-label={`Remove ${entered}`}
                  disabled={removeCode.isPending}
                  onClick={() => drop(entered)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!!automatic.length && (
        <ul className="bc-chips" aria-label="Automatic discounts">
          {automatic.map((entry) => (
            <li key={entry.name} className="bc-chip bc-chip--auto">
              {entry.name} · {fromPaise(entry.amount)}
            </li>
          ))}
        </ul>
      )}

      {!codes.length && !automatic.length && (
        <div className="empty-note">No discount on this bill.</div>
      )}
    </section>
  );
}
