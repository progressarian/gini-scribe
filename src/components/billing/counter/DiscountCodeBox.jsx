import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  useAddCode,
  useRemoveCode,
  useDiscardBillEdit,
  useSetBillDiscount,
  useSuggestedCodes,
} from "../../../queries/hooks/useBilling";
import { codeTyped, errorOf, fromPaise } from "../format";
import { HOME_COLLECTION_CODE } from "../../../../shared/billingVocab.js";

const TAKEN_ABOVE_BILL = "taken_above_bill";
import FinalBillDiscount from "./FinalBillDiscount";
import ManualDiscountFields, {
  discountDraft,
  discountNote,
  discountProblem,
} from "./ManualDiscountFields";

export default function DiscountCodeBox({ bill, onBill, form, patient }) {
  const addCode = useAddCode();
  const removeCode = useRemoveCode();
  const code = form.value.code;
  const [accepted, setAccepted] = useState(null);
  const [refused, setRefused] = useState(null);
  const setBillDiscount = useSetBillDiscount();
  const discardEdit = useDiscardBillEdit();
  const [overPaid, setOverPaid] = useState(null);
  const [prefill, setPrefill] = useState(null);
  const [extra, setExtra] = useState(null);
  const [extraError, setExtraError] = useState(null);
  const [confirmHome, setConfirmHome] = useState(false);
  const isHome = (entered) => entered.toLowerCase() === HOME_COLLECTION_CODE.toLowerCase();
  const manual = bill.manual_discount;
  const extraRules = { allowZero: Boolean(manual) };
  const manualTotal = (bill.discounts || [])
    .filter((entry) => entry.method === "manual")
    .reduce((sum, entry) => sum + entry.amount, 0);

  const draft = bill.editable;
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
    const label = isHome(entered) ? `${entered} (auto)` : entered;
    return detail ? `${label} · ${detail.name} · ${fromPaise(detail.amount)} off` : label;
  };

  const applyCode = async (wanted, typed) => {
    setAccepted(null);
    setRefused(null);
    setOverPaid(null);
    if (!wanted) return;
    try {
      onBill(await addCode.mutateAsync({ billId: bill.id, visitId: bill.visit_id, code: wanted }));
      setAccepted(`${wanted} applied`);
      if (typed) form.drop("code");
    } catch (e) {
      const data = e?.response?.data;
      if (bill.editing && data?.code === TAKEN_ABOVE_BILL) {
        setOverPaid({
          collected: data.collected,
          wanted: data.wanted_payable,
          by: `the code ${wanted}`,
          discount: {
            kind: "flat",
            value: String((data.collected - data.wanted_payable) / 100),
            reason: `Code ${wanted}`,
          },
        });
        return;
      }
      setRefused(errorOf(e, `The code ${wanted} could not be used on this bill`));
    }
  };

  const apply = (event) => {
    event.preventDefault();
    applyCode(code.trim(), true);
  };

  const giveAsCreditNote = async () => {
    setExtraError(null);
    try {
      onBill(
        await discardEdit.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          version: bill.version,
        }),
      );
      setPrefill({ ...overPaid.discount, at: Date.now() });
      setOverPaid(null);
      setExtra(null);
    } catch (e) {
      setExtraError(errorOf(e, "The edit could not be closed"));
    }
  };

  const saveExtra = async (cleared) => {
    setExtraError(null);
    setOverPaid(null);
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
      const data = e?.response?.data;
      if (bill.editing && data?.code === TAKEN_ABOVE_BILL && value) {
        setOverPaid({
          collected: data.collected,
          wanted: data.wanted_payable,
          by: "this discount",
          discount: { kind: value.kind, value: value.value.trim(), reason: value.reason.trim() },
        });
        return;
      }
      setExtraError(errorOf(e, "The bill discount could not be saved"));
    }
  };

  const drop = async (entered) => {
    setAccepted(null);
    setRefused(null);
    setConfirmHome(false);
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

      {draft && (
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
              {draft && (
                <button
                  type="button"
                  className="bc-chip__x"
                  aria-label={`Remove ${entered}`}
                  disabled={removeCode.isPending}
                  onClick={() => (isHome(entered) ? setConfirmHome(true) : drop(entered))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirmHome && draft && (
        <div className="bc-mdisc__current" role="alertdialog" aria-label="Remove home discount">
          <span>
            Remove the home-collection discount
            {detailOf(HOME_COLLECTION_CODE)
              ? ` (${fromPaise(detailOf(HOME_COLLECTION_CODE).amount)})`
              : ""}{" "}
            from this bill? It stays off this bill until the code is entered again.
          </span>
          <button
            type="button"
            className="st-btn st-btn-red"
            disabled={removeCode.isPending}
            onClick={() => drop(HOME_COLLECTION_CODE)}
          >
            Remove discount
          </button>
          <button type="button" className="st-btn st-btn-g" onClick={() => setConfirmHome(false)}>
            Keep
          </button>
        </div>
      )}

      {draft && bill.home_code_removed && (
        <div className="bc-hint">
          Home-collection discount removed from this bill. Enter {HOME_COLLECTION_CODE} to add it
          back.
        </div>
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
              if (!discountProblem(extra, extraRules)) saveExtra(Number(extra.value) === 0);
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
                disabled={Boolean(discountProblem(extra, extraRules)) || setBillDiscount.isPending}
              >
                {setBillDiscount.isPending ? "Saving…" : "Apply discount"}
              </button>
              <button type="button" className="st-btn st-btn-g" onClick={() => setExtra(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {overPaid && (
          <div className="bc-unfinal-banner" role="alert">
            <p>
              The patient has paid <strong>{fromPaise(overPaid.collected)}</strong>. With{" "}
              {overPaid.by} the bill comes to <strong>{fromPaise(overPaid.wanted)}</strong>, so{" "}
              <strong>{fromPaise(overPaid.collected - overPaid.wanted)}</strong> must go back to
              them. A paid bill gives money back through a discount credit note.
            </p>
            <div className="bc-head__row">
              <button
                type="button"
                className="st-btn st-btn-grn"
                disabled={discardEdit.isPending}
                onClick={giveAsCreditNote}
              >
                {discardEdit.isPending ? "Opening…" : "Give it as a credit note…"}
              </button>
              <button type="button" className="st-btn st-btn-g" onClick={() => setOverPaid(null)}>
                Keep editing
              </button>
            </div>
            <p className="bc-hint">
              This closes the edit without saving other changes, then opens the discount with your{" "}
              {overPaid.discount.kind === "percent"
                ? `${overPaid.discount.value}%`
                : fromPaise(overPaid.collected - overPaid.wanted)}{" "}
              filled in. You choose: refund in cash now, or keep it in the patient&apos;s deposit.
            </p>
          </div>
        )}
        {extraError && <div className="bc-err">{extraError}</div>}
      </div>

      <FinalBillDiscount bill={bill} patient={patient} onBill={onBill} prefill={prefill} />

      {!draft && nothing && <div className="bc-disc__none">No discount applied</div>}
    </section>
  );
}
