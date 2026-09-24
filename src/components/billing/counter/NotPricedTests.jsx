export default function NotPricedTests({ tests }) {
  if (!tests?.length) return null;

  return (
    <section className="bc-card" aria-label="Ordered tests with no price">
      <h3 className="bc-card__title">
        Ordered tests with no price<span className="grp-split">{tests.length}</span>
      </h3>
      <div className="bc-hint">
        Ordered on the floor but no billing item exists for them, so they cannot go on this bill.
        Ask an admin to create the item.
      </div>
      <ul className="bc-list">
        {tests.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </section>
  );
}
