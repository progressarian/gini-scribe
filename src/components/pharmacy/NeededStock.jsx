import { useState } from "react";
import Pagination from "../ui/Pagination";
import { requestErrorOf } from "../billing/format";
import { when } from "../billing/importText";
import {
  useClearNeededOrdered,
  useMarkNeededOrdered,
  useNeededStock,
} from "../../queries/hooks/usePharmacyStock";

const STATUS_TEXT = { not_stocked: "Not stocked", out_of_stock: "Out of stock" };

export default function NeededStock({ canOrder }) {
  const { data, isLoading, isError, refetch } = useNeededStock();
  const mark = useMarkNeededOrdered();
  const clear = useClearNeededOrdered();
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const items = data?.items ?? [];
  const lastPage = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, lastPage);
  const shown = items.slice((current - 1) * pageSize, current * pageSize);
  const busy = mark.isPending || clear.isPending;

  const run = async (action, body, fallback) => {
    setError("");
    try {
      await action.mutateAsync(body);
    } catch (e) {
      setError(requestErrorOf(e, fallback));
    }
  };

  return (
    <section className="flow-card" aria-labelledby="phs-needed-title">
      <div className="fset__cardhead">
        <h2 id="phs-needed-title" className="flow-sec-title">
          Needed in stock
        </h2>
        {data ? <span className="fset__count">{items.length}</span> : null}
      </div>
      <p className="fset__cardsub">
        Medicines doctors prescribed in the last {data?.days ?? 30} days that the pharmacy does not
        stock or has run out of. A medicine leaves this list once a stock upload includes it.
      </p>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      {isError ? (
        <p className="fset__cardsub">
          Could not load the list.{" "}
          <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={refetch}>
            Try again
          </button>
        </p>
      ) : isLoading ? (
        <p className="fset__cardsub">Loading…</p>
      ) : !items.length ? (
        <p className="fset__cardsub">Everything prescribed recently is in stock.</p>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table" aria-label="Medicines needed in stock">
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Status</th>
                <th className="phs-count">Patients</th>
                <th className="phs-count">Prescriptions</th>
                <th>Prescribed by</th>
                <th>Last prescribed</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.medicineKey}>
                  <td data-label="Medicine">{item.medicineName}</td>
                  <td data-label="Status">
                    <span
                      className={`bill-status phs-badge phs-badge--${item.status === "out_of_stock" ? "review" : "out"}`}
                    >
                      {STATUS_TEXT[item.status]}
                    </span>
                  </td>
                  <td data-label="Patients" className="phs-count">
                    {item.patients}
                  </td>
                  <td data-label="Prescriptions" className="phs-count">
                    {item.prescriptions}
                  </td>
                  <td data-label="Prescribed by">{item.doctors.join(", ") || "—"}</td>
                  <td data-label="Last prescribed">{item.lastPrescribed}</td>
                  <td data-label="Order">
                    {item.ordered ? (
                      <>
                        <span className="bill-status phs-badge phs-badge--ok">Ordered</span>{" "}
                        <span className="phs-muted">
                          {item.ordered.by ? `by ${item.ordered.by} · ` : ""}
                          {when(item.ordered.at)}
                        </span>
                        {canOrder ? (
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini"
                            disabled={busy}
                            aria-label={`Undo the order mark for ${item.medicineName}`}
                            onClick={() =>
                              run(
                                clear,
                                { medicineKey: item.medicineKey },
                                "The order mark could not be removed",
                              )
                            }
                          >
                            Undo
                          </button>
                        ) : null}
                      </>
                    ) : canOrder ? (
                      <button
                        type="button"
                        className="flow-btn flow-btn-ghost flow-btn-mini"
                        disabled={busy}
                        aria-label={`Mark ${item.medicineName} as ordered`}
                        onClick={() =>
                          run(
                            mark,
                            { medicineKey: item.medicineKey, medicineName: item.medicineName },
                            "It could not be marked as ordered",
                          )
                        }
                      >
                        Mark ordered
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={current}
        pageSize={pageSize}
        total={items.length}
        onChange={setPage}
        onPageSizeChange={setPageSize}
        unit="medicines"
      />
    </section>
  );
}
