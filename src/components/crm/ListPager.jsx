export default function ListPager({ page, pages, loading, onPage }) {
  if (!pages || pages <= 1) return null;
  return (
    <nav className="asg__pager" aria-label="Pages">
      <button
        type="button"
        className="rep__btn rep__btn--sm"
        onClick={() => onPage(page - 1)}
        disabled={page <= 1 || loading}
      >
        Previous
      </button>
      <span className="rep__hint">
        Page {page} of {pages}
      </span>
      <button
        type="button"
        className="rep__btn rep__btn--sm"
        onClick={() => onPage(page + 1)}
        disabled={page >= pages || loading}
      >
        Next
      </button>
    </nav>
  );
}
