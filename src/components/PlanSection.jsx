import "./PlanSection.css";

// Plan block with hide/show toggle (buttons hidden on print)
export default function PlanBlock({ id, title, color, hidden, onToggle, children }) {
  if (hidden)
    return (
      <div className="no-print plan-block--hidden" onClick={onToggle}>
        <span className="plan-block__hidden-icon">{"\u2795"}</span>
        <span className="plan-block__hidden-title">{title}</span>
      </div>
    );
  return (
    <div className="plan-block">
      <div className="plan-block__header" style={{ borderBottom: `2px solid ${color}` }}>
        <div className="plan-block__title" style={{ color }}>
          {title}
        </div>
        <button
          className="no-print plan-block__hide-btn"
          onClick={onToggle}
          title="Hide this section"
        >
          {"\u2715"}
        </button>
      </div>
      {children}
    </div>
  );
}
