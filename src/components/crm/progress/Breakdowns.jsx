const GROUPS = [
  { key: "type", title: "By visit type" },
  { key: "outcome", title: "By outcome" },
  { key: "source", title: "By source" },
  { key: "territory", title: "By territory" },
];

function BarList({ title, items }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="prg__breakdown">
      <h3 className="prg__h3">{title}</h3>
      {items.length === 0 ? (
        <p className="rep__hint">No visits.</p>
      ) : (
        <ul className="prg__bars">
          {items.map((i) => (
            <li key={i.value || i.label}>
              <span className="prg__bar-label" title={i.label}>
                {i.label}
              </span>
              <span className="prg__bar-track" aria-hidden="true">
                <span className="prg__bar-fill" style={{ width: `${(i.count / max) * 100}%` }} />
              </span>
              <span className="prg__bar-n">{i.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Breakdowns({ breakdowns }) {
  return (
    <section className="prg__section" aria-labelledby="prg-breakdowns">
      <h2 id="prg-breakdowns" className="prg__h2">
        Visits breakdown
      </h2>
      <div className="prg__breakdowns">
        {GROUPS.map((g) => (
          <BarList key={g.key} title={g.title} items={breakdowns[g.key]} />
        ))}
      </div>
    </section>
  );
}
