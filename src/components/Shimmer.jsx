import "./Shimmer.css";

/**
 * Shimmer skeleton loading component
 *
 * @param {"lines"|"list"|"stats"|"cards"|"table"} type
 * @param {number} count - number of items to render
 */
export default function Shimmer({ type = "lines", count = 3 }) {
  const items = Array.from({ length: count });

  if (type === "stats") {
    return (
      <div className="shimmer-stats">
        {items.map((_, i) => (
          <div key={i} className="shimmer-stat-card">
            <div className="shimmer shimmer-stat-icon" />
            <div className="shimmer shimmer-stat-value" />
            <div className="shimmer shimmer-stat-label" />
          </div>
        ))}
      </div>
    );
  }

  if (type === "list") {
    return (
      <div className="shimmer-list">
        {items.map((_, i) => (
          <div key={i} className="shimmer-list-item">
            <div className="shimmer shimmer-avatar" />
            <div className="shimmer-list-content">
              <div className="shimmer shimmer-list-title" />
              <div className="shimmer shimmer-list-sub" />
            </div>
            <div className="shimmer shimmer-list-badge" />
          </div>
        ))}
      </div>
    );
  }

  if (type === "cards") {
    return (
      <div className="shimmer-cards">
        {items.map((_, i) => (
          <div key={i} className="shimmer-card">
            <div className="shimmer-card-header">
              <div className="shimmer shimmer-card-title" />
              <div className="shimmer shimmer-card-tag" />
            </div>
            <div className="shimmer shimmer-card-body" />
            <div className="shimmer shimmer-card-body2" />
          </div>
        ))}
      </div>
    );
  }

  if (type === "table") {
    return (
      <div className="shimmer-table">
        {items.map((_, i) => (
          <div key={i} className="shimmer-table-row">
            <div className="shimmer shimmer-table-cell" />
            <div className="shimmer shimmer-table-cell" />
            <div className="shimmer shimmer-table-cell" />
          </div>
        ))}
      </div>
    );
  }

  // Default: lines
  return (
    <div className="shimmer-lines">
      {items.map((_, i) => (
        <div key={i} className="shimmer shimmer-line" />
      ))}
    </div>
  );
}
