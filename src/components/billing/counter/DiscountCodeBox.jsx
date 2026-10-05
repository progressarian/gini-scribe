import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  useAddCode,
  useRemoveCode,
  useSetBillDiscount,
  useSuggestedCodes,
} from "../../../queries/hooks/useBilling";
import { codeTyped, errorOf, fromPaise } from "../format";
import ManualDiscountFields, {
  discountDraft,
  discountNote,
  discountProblem,
} from "./ManualDiscountFields";

export default function DiscountCodeBox({ bill, onBill, form }) {
  const addCode = useAddCode();
  const removeCode = useRemoveCode();
  const code = form.value.code;
  const [accepted, setAccepted] = useState(null);
  const [refused, setRefused] = useState(null);
  const setBillDiscount = useSetBillDiscount();
  const [extra, setExtra] = useState(null);
  const [extraError, setExtraError] = useState(null);
  const manual = bill.manual_discount;
  const manualTotal = (bill.discounts || [])
    .filter((entry) => entry.method === "manual")
    .reduce((sum, entry) => sum + entry.amount, 0);

  const draft = bill.status === "draft";
  const { data: suggested, isLoading: findingCodes } = useSuggestedCodes(bill.id, bill.version, {
    enabled: draft && bill.lines.length > 0,
  });
  const offers = draft ? suggested?.codes || [] : [];
  const codes = bill.codes || [];
  const automatic = (bill.discounts || []).filter((entry) => entry.method === "auto");
  const nothing = !codes.length && !automatic.length && !manualTotal;
  const detailOf = (entered) =>
    (bill.discounts || []).find(
      (entry) => entry.method === "code" && entry.code?.toLowerCase() === entered.toLowerCase(),
    );
  const chipText = (entered) => {
    const detail = detailOf(entered);
    return detail ? `${entered} · ${detail.name} · ${fromPaise(detail.amount)} off` : entered;
  };

  const applyCode = async (wanted, typed) => {
    setAccepted(null);
    setRefused(null);
    if (!wanted) return;
    try {
      onBill(await addCode.mutateAsync({ billId: bill.id, visitId: bill.visit_id, code: wanted }));
      setAccepted(`${wanted} applied`);
      if (typed) form.drop("code");
    } catch (e) {
      setRefused(errorOf(e, `The code ${wanted} could not be used on this bill`));
    }
  };

  const apply = (event) => {
    event.preventDefault();
    applyCode(code.trim(), true);
  };

  const saveExtra = async (cleared) => {
    setExtraError(null);
    const value = cleared ? null : extra;
    try {
      onBill(
        await setBillDiscount.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          kind: value?.kind ?? manual?.kind ?? "percent",
          value: value ? value.value.trim() : 0,
          reason: value ? value.reason.trim() : "",
        }),
      );
      setExtra(null);
    } catch (e) {
      setExtraError(errorOf(e, "The bill discount could not be saved"));
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
    <section className="bc-card bc-disc" aria-label="Discount codes">
      <h3 className="bc-card__heading">Discounts</h3>

      {bill.status === "draft" && (
        <form className="bc-disc__row" onSubmit={apply}>
          <label className="bc-disc__field">
            <span className="sr-only">Discount code</span>
            <input
              className="bc-field__in"
              value={code}
              placeholder="Enter discount code"
              onChange={(e) => form.set("code", codeTyped(e.target.value))}
            />
          </label>
          <button
            type="submit"
            aria-label="Apply code"
            className="st-btn st-btn-grn"
            disabled={!code.trim() || addCode.isPending}
          >
            Apply
          </button>
          {nothing && <span className="bc-disc__none">No discount applied</span>}
        </form>
      )}

      {draft && findingCodes && (
        <div className="bc-hint" role="status">
          Finding discount codes for this patient…
        </div>
      )}
      {offers.length > 0 && (
        <div className="bc-offers">
          <h4 className="bc-offers__title">
            <Sparkles size={14} aria-hidden="true" />
            Suggested for this patient
          </h4>
          <ul className="bc-offers__list" aria-label="Suggested discount codes">
            {offers.map((offer) => (
              <li key={offer.code} className="bc-offer">
                <span className="bc-offer__body">
                  <span className="bc-offer__top">
                    <span className="bc-offer__code">{offer.code}</span>
                    <span className="bc-offer__name">{offer.name}</span>
                  </span>
                  {offer.because.length > 0 && (
                    <span className="bc-offer__why">{offer.because.join(" · ")}</span>
                  )}
                </span>
                <span className="bc-offer__saves">Saves {fromPaise(offer.saves)}</span>
                <button
                  type="button"
                  className="st-btn st-btn-grn"
                  aria-label={`Apply ${offer.code}`}
                  disabled={addCode.isPending}
                  onClick={() => applyCode(offer.code, false)}
                >
                  Apply
                </button>
              </li>
            ))}
          </ul>
        </div>
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

      {manualTotal > 0 && (
        <ul className="bc-chips" aria-label="Manual discounts">
          <li className="bc-chip bc-chip--auto">Manual discounts · {fromPaise(manualTotal)}</li>
        </ul>
      )}

      <div className="bc-mdisc__bill" aria-label="Additional discount on the bill" role="group">
        {manual && !extra && (
          <div className="bc-mdisc__current">
            <span>Additional discount on the bill: {discountNote(manual)}</span>
            {draft && (
              <>
                <button
                  type="button"
                  className="st-btn st-btn-g"
                  onClick={() => {
                    setExtraError(null);
                    setExtra(discountDraft(manual));
                  }}
                >
                  Change
                </button>
                <button
                  type="button"
                  className="st-btn st-btn-g"
                  disabled={setBillDiscount.isPending}
                  onClick={() => saveExtra(true)}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        )}
        {draft && !manual && !extra && bill.lines.length > 0 && (
          <button
            type="button"
            className="st-btn st-btn-g"
            onClick={() => {
              setExtraError(null);
              setExtra(discountDraft(null));
            }}
          >
            + Additional discount on the bill
          </button>
        )}
        {draft && extra && (
          <form
            className="bc-mdisc__form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!discountProblem(extra)) saveExtra(false);
            }}
          >
            <p className="bc-hint">
              Comes off the whole bill after line discounts and codes, shared across the lines.
            </p>
            <ManualDiscountFields id="bc-bill-discount" value={extra} onChange={setExtra} />
            <div className="bc-head__row">
              <button
                type="submit"
                className="st-btn st-btn-grn"
                disabled={Boolean(discountProblem(extra)) || setBillDiscount.isPending}
              >
                {setBillDiscount.isPending ? "Saving…" : "Apply discount"}
              </button>
              <button type="button" className="st-btn st-btn-g" onClick={() => setExtra(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {extraError && <div className="bc-err">{extraError}</div>}
      </div>

      {bill.status !== "draft" && nothing && (
        <div className="bc-disc__none">No discount applied</div>
      )}
    </section>
  );
}
