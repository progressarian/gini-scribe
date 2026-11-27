import { useEffect, useId, useState } from "react";
import {
  useAddBillLine,
  useApplyMembershipCard,
  useMembershipCard,
  useMembershipSearch,
  usePatientMemberships,
  usePlansOnSale,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";

export const cardBalanceText = (card) =>
  [
    `${card.consult_left} of ${card.consult_total} consultations left`,
    card.dietitian_total
      ? `${card.dietitian_left} of ${card.dietitian_total} dietitian visits left`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

const labText = (card) =>
  card.lab_discount_pct
    ? card.lab_discount_today
      ? `${card.lab_discount_pct}% off tests today`
      : "No lab discount — no consultations left"
    : null;

function CardSummary({ card }) {
  return (
    <div className="bc-member__card">
      <div>
        <strong>{card.card_no}</strong> · {card.plan.name}
        {card.status === "exhausted" && <span className="badge b-amb">Used up</span>}
      </div>
      <div className="bc-head__meta">
        Holder: {card.holder.name}
        {card.holder.file_no ? ` (${card.holder.file_no})` : ""}
      </div>
      <div className="bc-head__meta">{cardBalanceText(card)}</div>
      {labText(card) && <div className="bc-head__meta">{labText(card)}</div>}
    </div>
  );
}

function CardChoice({ card, busy, onApply, ownCard }) {
  return (
    <li className="bc-member__choice">
      <CardSummary card={card} />
      <button
        type="button"
        className="st-btn st-btn-g"
        disabled={busy}
        aria-label={`Use card ${card.card_no} of ${card.holder.name} on this bill`}
        onClick={() => onApply(card)}
      >
        {ownCard ? "Use card" : "Use this card"}
      </button>
    </li>
  );
}

function SellPlan({ bill, onBill }) {
  const id = useId();
  const { data: plans = [] } = usePlansOnSale();
  const add = useAddBillLine();
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState(null);
  const plan = plans.find((entry) => String(entry.id) === chosen);
  if (!plans.length) return null;

  const sell = async (e) => {
    e.preventDefault();
    if (!plan) return;
    setError(null);
    try {
      onBill(
        await add.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          item_id: plan.service_item_id,
        }),
      );
      setChosen("");
    } catch (err) {
      setError(errorOf(err, "The plan could not be added to this bill"));
    }
  };

  return (
    <form className="bc-member__sell" onSubmit={sell}>
      <label className="bc-field" htmlFor={`${id}-plan`}>
        <span className="bc-field__lbl">Sell a membership card</span>
        <select
          id={`${id}-plan`}
          className="bc-field__in"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
        >
          <option value="">Choose a plan…</option>
          {plans.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} — {fromPaise(entry.price)} · {entry.consult_count} consultations
              {entry.dietitian_count ? ` + ${entry.dietitian_count} dietitian` : ""}
              {entry.lab_discount_pct ? ` · ${entry.lab_discount_pct}% off lab` : ""}
            </option>
          ))}
        </select>
      </label>
      {plan && (
        <p className="bc-hint">
          Adds {fromPaise(plan.price)} to this bill. The card is made in this patient&apos;s name
          when the bill is final.
        </p>
      )}
      <button type="submit" className="st-btn st-btn-g" disabled={!plan || add.isPending}>
        {add.isPending ? "Adding…" : "Add plan to bill"}
      </button>
      {error && <div className="bc-err">{error}</div>}
    </form>
  );
}

export default function MembershipBox({ bill, onBill }) {
  const searchId = useId();
  const [q, setQ] = useState("");
  const [error, setError] = useState(null);
  const apply = useApplyMembershipCard();
  const stamp = `${bill.id}:${bill.version}:${bill.status}`;
  const { data: own = [] } = usePatientMemberships(bill.patient_id, stamp);
  const { data: applied, isError: appliedFailed } = useMembershipCard(
    bill.membership_card_id,
    stamp,
  );
  const search = useMembershipSearch(q);
  const usable = (card) => card.status === "active" || card.lab_discount_today;
  const ownUsable = own.filter(usable);
  const found = (search.data ?? []).filter(usable);

  useEffect(() => setError(null), [bill.id]);

  if (bill.bill_type !== "invoice") return null;
  if (!bill.editable && !bill.membership_card_id) return null;

  const choose = async (card) => {
    setError(null);
    try {
      onBill(
        await apply.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          cardId: card?.id ?? null,
        }),
      );
      setQ("");
    } catch (err) {
      setError(errorOf(err, "The card could not be used on this bill"));
    }
  };

  return (
    <section className="bc-card bc-member" aria-label="Membership card">
      <h3 className="bc-card__heading">Membership</h3>

      {bill.membership_card_id ? (
        <div className="bc-member__applied">
          {applied ? (
            <CardSummary card={applied} />
          ) : appliedFailed ? (
            <div className="bc-err">The card on this bill could not be loaded.</div>
          ) : (
            <div className="bc-hint" role="status">
              Loading the card…
            </div>
          )}
          {applied && applied.holder.id !== bill.patient_id && (
            <p className="bc-hint">This patient is using {applied.holder.name}&apos;s card.</p>
          )}
          {bill.editable && (
            <button
              type="button"
              className="st-btn st-btn-g"
              disabled={apply.isPending}
              onClick={() => choose(null)}
            >
              Take card off this bill
            </button>
          )}
        </div>
      ) : (
        <>
          {ownUsable.length > 0 && (
            <ul className="bc-member__list" aria-label="This patient's cards">
              {ownUsable.map((card) => (
                <CardChoice
                  key={card.id}
                  card={card}
                  ownCard
                  busy={apply.isPending}
                  onApply={choose}
                />
              ))}
            </ul>
          )}
          <label className="bc-field" htmlFor={searchId}>
            <span className="bc-field__lbl">Use someone else&apos;s card</span>
            <input
              id={searchId}
              type="search"
              className="bc-field__in"
              placeholder="Search by card number, holder name, UHID or phone"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          {q.trim().length >= 2 && search.isFetching && !search.data && (
            <div className="bc-hint" role="status">
              Searching…
            </div>
          )}
          {q.trim().length >= 2 && search.isError && (
            <div className="bc-err">Cards could not be searched. Try again.</div>
          )}
          {q.trim().length >= 2 && search.data && !found.length && (
            <div className="bc-hint" role="status">
              No usable card matches “{q.trim()}”.
            </div>
          )}
          {found.length > 0 && (
            <ul className="bc-member__list" aria-label="Cards found">
              {found.map((card) => (
                <CardChoice key={card.id} card={card} busy={apply.isPending} onApply={choose} />
              ))}
            </ul>
          )}
        </>
      )}

      {error && <div className="bc-err">{error}</div>}
      {bill.editable && <SellPlan bill={bill} onBill={onBill} />}
    </section>
  );
}
