export function LoadingLines({ count = 2 }) {
  return Array.from({ length: count }, (_, n) => (
    <div className="bc-opening__line" key={n} aria-hidden="true">
      <span className="bc-skel bc-skel--name" />
      <span className="bc-skel bc-skel--amount" />
    </div>
  ));
}

export default function LoadingCard({ title, text, lines = 2, className = "" }) {
  return (
    <section
      className={`bc-card bc-loading ${className}`.trim()}
      aria-label={`${title} — loading`}
      aria-busy="true"
    >
      <h3 className="bc-card__title">{title}</h3>
      <div className="bc-opening__label" role="status">
        {text}
      </div>
      <LoadingLines count={lines} />
    </section>
  );
}
