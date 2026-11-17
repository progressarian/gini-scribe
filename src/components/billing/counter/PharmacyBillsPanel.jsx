import { useEffect, useState } from "react";
import MasterFormDialog from "../../pharmacy/MasterFormDialog";
import BillPayments, { paymentProblems, paymentsForApi } from "../../pharmacy/BillPayments";
import Pagination from "../../ui/Pagination";
import { inr, showDate } from "../../pharmacy/format";
import { requestErrorOf } from "../format";
import { toast } from "../../../stores/uiStore";
import {
  useReceptionCollect,
  useReceptionDues,
} from "../../../queries/hooks/usePharmacyDepartments";
import { toPaise, toRupees } from "../../../../shared/pharmacyMoney";
import { SALE_TYPE_LABEL } from "../../../../shared/pharmacyVocab";
import "../../../pages/pharmacy/pharmacyStock.css";
import "../../../pages/pharmacy/pharmacyVendors.css";
import "../../../pages/pharmacy/pharmacyBills.css";

function CollectDialog({ bill, onClose }) {
  const collect = useReceptionCollect();
  const due = toPaise(bill.due_amount);
  const [rows, setRows] = useState([
    { mode: "cash", amount: toRupees(due), reference: "", upi_app: "" },
  ]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const shortBy = toRupees(Math.max(due - 1, 0));
  const check = paymentProblems(rows, bill.due_amount, shortBy);

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (!check.ok) return;
    try {
      const after = await collect.mutateAsync({
        billId: bill.id,
        version: bill.version,
        payments: paymentsForApi(rows),
      });
      toast(
        Number(after.due_amount)
          ? `Collected on pharmacy bill ${after.bill_no}. ${inr(after.due_amount)} still due.`
          : `Pharmacy bill ${after.bill_no} is fully paid.`,
      );
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not collect the payment"));
    }
  };

  return (
    <MasterFormDialog
      title={`Collect pharmacy bill ${bill.bill_no}`}
      intro={
        <dl className="adj-facts">
          <div>
            <dt>Patient</dt>
            <dd>
              {bill.patient_name} ({bill.patient_file_no ?? "—"})
            </dd>
          </div>
          <div>
            <dt>Bill total</dt>
            <dd>{inr(bill.net_amount)}</dd>
          </div>
          <div>
            <dt>Due now</dt>
            <dd>{inr(bill.due_amount)}</dd>
          </div>
        </dl>
      }
      dirty={touched}
      busy={collect.isPending}
      error={error}
      submitLabel={`Collect ${inr(toRupees(due - Math.max(check.gap, 0)))}`}
      onSubmit={submit}
      onClose={onClose}
    >
      <BillPayments
        rows={rows}
        net={bill.due_amount}
        shortBy={shortBy}
        onChange={setRows}
        showErrors={touched}
        totalLabel="the amount due"
        legend="Collect"
      />
      <p className="phs-meta">
        Pharmacy money gets its own PHR receipt. Cash goes into your shift&apos;s drawer and is
        shown as pharmacy cash when you close the shift.
      </p>
    </MasterFormDialog>
  );
}

export default function PharmacyBillsPanel() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [collecting, setCollecting] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useReceptionDues({
    ...(q ? { q } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = query.data?.rows ?? [];

  return (
    <section className="phs phb phb-reception" aria-labelledby="bc-pharmacy-title">
      <div className="fset__cardhead">
        <h2 id="bc-pharmacy-title" className="flow-sec-title">
          Pharmacy bills to collect
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
        <span className="phb-due-total">Outstanding {inr(query.data?.total_due ?? 0)}</span>
      </div>
      <div className="phs-filters">
        <label className="sr-only" htmlFor="bc-pharmacy-search">
          Search pharmacy bills
        </label>
        <input
          id="bc-pharmacy-search"
          type="search"
          className="jb-assign phs-search"
          placeholder="Search by patient, file number, mobile or bill number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load pharmacy bills. Please try again.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.isLoading ? (
        <p className="phs-empty" role="status">
          Loading pharmacy bills…
        </p>
      ) : !rows.length ? (
        <p className="phs-empty">
          {q ? "No pharmacy bills match the search." : "No pharmacy bills are waiting for payment."}
        </p>
      ) : (
        <>
          <div className="fset__scroll">
            <table className="flow-table phs-table" aria-label="Pharmacy bills to collect">
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Patient</th>
                  <th>Type</th>
                  <th className="phs-num">Bill total</th>
                  <th className="phs-num">Due</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Bill">
                      <span className="phv-mono">{r.bill_no}</span>
                      <span className="phs-meta">{showDate(r.bill_date)}</span>
                    </td>
                    <td data-label="Patient">
                      {r.patient_name}
                      <span className="phs-meta">
                        {[r.patient_file_no, r.patient_phone].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td data-label="Type">
                      {SALE_TYPE_LABEL[r.sale_type]}
                      {r.ipd_number ? <span className="phs-meta">{r.ipd_number}</span> : null}
                    </td>
                    <td data-label="Bill total" className="phs-num">
                      {inr(r.net_amount)}
                    </td>
                    <td data-label="Due" className="phs-num phb-due">
                      {inr(r.due_amount)}
                    </td>
                    <td className="phb-line-acts">
                      <button
                        type="button"
                        className="flow-btn flow-btn-primary"
                        aria-label={`Collect pharmacy bill ${r.bill_no}`}
                        onClick={() => setCollecting(r)}
                      >
                        Collect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={query.data?.total ?? 0}
            onChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            disabled={query.isFetching}
            unit="bills"
          />
        </>
      )}
      {collecting ? <CollectDialog bill={collecting} onClose={() => setCollecting(null)} /> : null}
    </section>
  );
}
