import { rupees } from "../format";

function whyNotBilled({ bill_no: billNo, due }) {
  if (!billNo) return "Not on any bill — add it to this bill with Add Service/Test.";
  if (due > 0) return `Billed on ${billNo} — collect the ${rupees(due)} still due on that bill.`;
  return `On ${billNo}, but not counted as paid for this order — ask an admin to check it.`;
}

export default function OrderedNotBilledTests({ tests }) {
  if (!tests?.length) return null;

  return (
    <section className="bc-card" aria-label="Ordered tests not on this bill">
      <h3 className="bc-card__title">
        Ordered tests not on this bill<span className="grp-split">{tests.length}</span>
      </h3>
      <div className="bc-hint">
        These tests were ordered on the floor and are still unpaid, so the lab will hold them until
        they are paid.
      </div>
      <ul className="bc-list">
        {tests.map((entry) => (
          <li key={entry.test}>
            <strong>{entry.test}</strong> — {whyNotBilled(entry)}
          </li>
        ))}
      </ul>
    </section>
  );
}
