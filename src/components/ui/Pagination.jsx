import Dropdown from "./Dropdown";
import "./Pagination.css";

// Numbered pager: "Showing 1–25 of 120", a rows-per-page selector, and
// Previous / Page X of Y / Next.
//
// Extracted from the inline implementation in AppPatientsPage so the markup and
// styling live in one place. Pages are 1-indexed. The size selector reuses the
// shared Dropdown rather than introducing a second select control.
//
// Props:
//   page              — current page, 1-indexed
//   pageSize          — rows per page
//   total             — total row count across all pages
//   onChange          — (nextPage) => void
//   onPageSizeChange  — (nextSize) => void; omit to hide the size selector
//   pageSizeOptions   — sizes offered in the selector
//   disabled          — disable the controls while a fetch is in flight
//   unit              — noun for the range label, e.g. "patients" (optional)
export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100];

export default function Pagination({
  page,
  pageSize,
  total,
  onChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  disabled = false,
  unit = "",
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (!total) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // Changing the size can leave the current page out of range, so land the
  // reader back on the first page rather than on an empty one.
  const changeSize = (next) => {
    onPageSizeChange(Number(next));
    onChange(1);
  };

  return (
    <div className="pgn">
      <span className="pgn__range">
        Showing {from}–{to} of {total}
        {unit ? ` ${unit}` : ""}
      </span>

      <div className="pgn__controls">
        {onPageSizeChange && (
          <label className="pgn__size">
            <span className="pgn__size-label">Rows</span>
            <Dropdown
              value={pageSize}
              options={pageSizeOptions.map((n) => ({ value: n, label: String(n) }))}
              onChange={changeSize}
              ariaLabel="Rows per page"
            />
          </label>
        )}

        {totalPages > 1 && (
          <>
            <button
              type="button"
              className="pgn__btn"
              onClick={() => onChange(Math.max(1, page - 1))}
              disabled={disabled || page <= 1}
            >
              ‹ Previous
            </button>
            <span className="pgn__page">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              className="pgn__btn"
              onClick={() => onChange(Math.min(totalPages, page + 1))}
              disabled={disabled || page >= totalPages}
            >
              Next ›
            </button>
          </>
        )}
      </div>
    </div>
  );
}
