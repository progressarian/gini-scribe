import { useBillingPriceHistory } from "../../queries/hooks/useBillingMaster";
import { rupees } from "./format";
import useDialog from "./useDialog";

const when = (value) =>
  new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default function PriceHistoryDialog({ item, onClose }) {
  const { data: history = [], isLoading, isError } = useBillingPriceHistory(item?.id);
  const ref = useDialog(Boolean(item), onClose);
  if (!item) return null;
  return (
    <div
      className="flow-dialog-backdrop bill-drawer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <aside
        ref={ref}
        className="flow-card bill-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="price-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bill-dialog__head">
          <h2 id="price-history-title" className="bill-dialog__title">
            Price history · {item.name}
          </h2>
          <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onClose}>
            Close
          </button>
        </div>
        {isLoading ? (
          <p className="flow-muted">Loading…</p>
        ) : isError ? (
          <p className="flow-muted">Could not load the price history.</p>
        ) : (
          <table className="flow-table" aria-label="Past prices">
            <thead>
              <tr>
                <th>When</th>
                <th>Price</th>
                <th>Reason</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={`${h.changed_at}-${h.new_price}`}>
                  <td>{when(h.changed_at)}</td>
                  <td>
                    {h.old_price === null
                      ? rupees(h.new_price)
                      : `${rupees(h.old_price)} → ${rupees(h.new_price)}`}
                  </td>
                  <td>{h.reason || "—"}</td>
                  <td>{h.changed_by_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
    </div>
  );
}
