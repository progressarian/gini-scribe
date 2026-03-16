import { DC, FRIENDLY } from "../config/constants.js";
import "./Badge.css";

export default function Badge({ id, friendly }) {
  return (
    <span
      className="badge"
      style={{
        background: (DC[id] || "#64748b") + "18",
        color: DC[id] || "#64748b",
        border: `1px solid ${DC[id] || "#64748b"}35`,
      }}
    >
      {friendly ? FRIENDLY[id] || id : id?.toUpperCase()}
    </span>
  );
}
