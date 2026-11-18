export default function AllBillsFinal({ bills, onAddItems }) {
  const numbers = bills.map((b) => b.bill_no).filter(Boolean);
  return (
    <section className="bc-card" aria-label="Billing status for this visit" role="status">
      <h3 className="bc-card__title">All bills on this visit are final</h3>
      <div className="bc-hint">
        {numbers.length ? `${numbers.join(", ")} · ` : ""}Nothing is waiting to be billed.
      </div>
      <div className="bc-head__row">
        <button type="button" className="st-btn st-btn-g" onClick={onAddItems}>
          Add items to a new bill
        </button>
      </div>
    </section>
  );
}
