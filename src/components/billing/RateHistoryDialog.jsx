import { useState } from "react";
import {
  useBillingRateHistory,
  useDeleteBillingCategoryRate,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { errorOf, rupees } from "./format";
import useDialog from "./useDialog";

export default function RateHistoryDialog({ item, code, categoryName, onClose }) {
  const {
    data: rates = [],
    isLoading,
    isError,
  } = useBillingRateHistory(code, item?.service_item_id);
  const remove = useDeleteBillingCategoryRate();
  const [confirming, setConfirming] = useState(null);
  const ref = useDialog(Boolean(item), onClose);
  if (!item) return null;

  const clear = async (validFrom) => {
    setConfirming(null);
    try {
      await remove.mutateAsync({
        scheme_code: code,
        service_item_id: item.service_item_id,
        valid_from: validFrom,
      });
      toast(`Cleared the rate from ${validFrom}`, "success");
    } catch (err) {
      toast(errorOf(err), "error");
    }
  };

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
        aria-labelledby="rate-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bill-dialog__head">
          <h2 id="rate-history-title" className="bill-dialog__title">
            {categoryName} rates · {item.name}
          </h2>
          <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onClose}>
            Close
          </button>
        </div>
        {isLoading ? (
          <p className="flow-muted">Loading…</p>
        ) : isError ? (
          <p className="flow-muted">Could not load the rates.</p>
        ) : !rates.length ? (
          <p className="flow-muted">
            {categoryName} has no rate of its own for this item — it uses {rupees(item.rate)}.
          </p>
        ) : (
          <table className="flow-table" aria-label="Every rate">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Rate</th>
                <th>Bill code</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.valid_from}>
                  <td>{rate.valid_from}</td>
                  <td>{rate.valid_to ?? "no end"}</td>
                  <td>{rate.rate === null ? "—" : rupees(rate.rate)}</td>
                  <td>{rate.bill_code ?? "—"}</td>
                  <td className="bill-items__actions">
                    {confirming === rate.valid_from ? (
                      <>
                        <button
                          type="button"
                          className="flow-btn flow-btn-red flow-btn-mini"
                          aria-label={`Confirm clear the rate from ${rate.valid_from}`}
                          disabled={remove.isPending}
                          onClick={() => clear(rate.valid_from)}
                        >
                          Confirm clear
                        </button>
                        <button
                          type="button"
                          className="flow-btn flow-btn-ghost flow-btn-mini"
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="flow-btn flow-btn-ghost flow-btn-mini"
                        aria-label={`Clear the rate from ${rate.valid_from}`}
                        onClick={() => setConfirming(rate.valid_from)}
                      >
                        Clear
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
    </div>
  );
}
