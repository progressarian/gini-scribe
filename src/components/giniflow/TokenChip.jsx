import "./tokenQueue.css";

export default function TokenChip({ token, className = "" }) {
  if (token == null) return null;
  return (
    <span
      className={`tok-chip ${className}`.trim()}
      title={`Token ${token} — seen by the Chief Endocrinologist in token order`}
    >
      Token {token}
    </span>
  );
}
