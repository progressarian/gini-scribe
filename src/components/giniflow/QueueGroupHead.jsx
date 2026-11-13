import { ChevronRight } from "lucide-react";
import Ico from "./Ico";

export default function QueueGroupHead({ icon, title, sub, count, open, onToggle, id }) {
  return (
    <h2 className="sq-gh">
      <button
        type="button"
        className="sq-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
          <ChevronRight size={14} />
        </span>
        <Ico as={icon} /> {title}
        {sub && <span className="sq-ghsub">— {sub}</span>}
        <span className="sq-count">{count}</span>
      </button>
    </h2>
  );
}
