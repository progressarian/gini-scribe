import "./Section.css";

export default function Section({ title, color, children }) {
  return (
    <div className="section">
      <div className="section__title" style={{ color, borderBottom: `2px solid ${color}` }}>
        {title}
      </div>
      {children}
    </div>
  );
}
