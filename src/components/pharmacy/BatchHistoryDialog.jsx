import { useState } from "react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { when } from "../billing/importText";
import Pagination from "../ui/Pagination";
import { showDate } from "./format";
import { useBatchMovements } from "../../queries/hooks/usePharmacyBatches";
import { MOVEMENT_KIND_LABEL } from "../../../shared/pharmacyVocab";

const PAGE_SIZE = 20;

export default function BatchHistoryDialog({ batch, location, onClose }) {
  const ref = useDialog(true, onClose);
  const [page, setPage] = useState(1);
  const history = useBatchMovements(batch.id, {
    location_id: location.id,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const info = history.data?.batch;
  const rows = history.data?.rows ?? [];

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <div
          ref={ref}
          className="flow-card bill-dialog bill-dialog--wide phv-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bh-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="bh-title" className="bill-dialog__title">
            Batch history · {batch.batch_no}
          </h2>
          <p className="flow-muted">
            {info ? `${info.medicine_name}, expiry ${showDate(info.expiry_date)}, ` : ""}
            {location.name}. Every change to this batch's stock, newest first.
          </p>
          {history.isError ? (
            <div className="phs-empty" role="alert">
              <p>Unable to load the batch history.</p>
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                onClick={() => history.refetch()}
              >
                Try again
              </button>
            </div>
          ) : history.isLoading ? (
            <p className="phs-empty" role="status">
              Loading history…
            </p>
          ) : !rows.length ? (
            <p className="phs-empty">No stock movements recorded for this batch here.</p>
          ) : (
            <>
              <div className="fset__scroll">
                <table
                  className="flow-table phs-table"
                  aria-label={`History of batch ${batch.batch_no}`}
                >
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>What</th>
                      <th className="phs-num">Change</th>
                      <th className="phs-num">Stock after</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td data-label="When">{when(r.at)}</td>
                        <td data-label="What">
                          <span className="phs-item">{MOVEMENT_KIND_LABEL[r.kind]}</span>
                          {r.reference || r.reason ? (
                            <span className="phs-meta">
                              {[r.reference, r.reason].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </td>
                        <td data-label="Change" className="phs-num">
                          {r.delta_units > 0 ? `+${r.delta_units}` : `−${Math.abs(r.delta_units)}`}{" "}
                          {info?.unit_label}
                        </td>
                        <td data-label="Stock after" className="phs-num">
                          {r.balance_after} {info?.unit_label}
                        </td>
                        <td data-label="By">
                          {r.actor_name ?? <span className="phs-meta">System</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={history.data?.total ?? 0}
                onChange={setPage}
                disabled={history.isFetching}
                unit="movements"
              />
            </>
          )}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </BillDialogLayer>
  );
}
