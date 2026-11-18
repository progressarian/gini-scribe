import { useState } from "react";
import { Download } from "lucide-react";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { NEEDED_REASON_LABEL } from "../../../shared/pharmacyVocab";
import Pagination from "../../components/ui/Pagination";
import PillGroup from "../../components/pharmacy/Pills";
import SheetImportButton from "../../components/pharmacy/SheetImportButton";
import { requestErrorOf } from "../../components/billing/format";
import { when } from "../../components/billing/importText";
import { showDate } from "../../components/pharmacy/format";
import { downloadFile } from "../../lib/downloadBlob";
import { toast } from "../../stores/uiStore";
import useUrlState, { useUrlSearch, asNumber } from "../../hooks/useUrlState";
import {
  NEEDED_URL,
  stockKeys,
  useClearNeededOrdered,
  useMarkNeededOrdered,
  useNeededStock,
} from "../../queries/hooks/usePharmacyStock";
import { fileSheetSource } from "../../queries/hooks/usePharmacySheets";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";
import "./pharmacyNeeded.css";

const PERIODS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "1 year" },
];

const STOCK = {
  not_stocked: { text: "Not stocked", tone: "out" },
  out_of_stock: { text: "Out of stock", tone: "review" },
  in_stock: { text: "In stock", tone: "ok" },
};

const sheetSource = fileSheetSource(NEEDED_URL);

function Summary({ summary }) {
  const top = Object.entries(summary.byReason).sort((a, b) => b[1] - a[1])[0];
  const tiles = [
    { label: "Medicines", value: summary.medicines },
    { label: "Times not given", value: summary.times },
    { label: "Patients", value: summary.patients },
    {
      label: "Most common reason",
      value: top ? `${NEEDED_REASON_LABEL[top[0]] ?? top[0]} (${top[1]})` : "—",
    },
  ];
  return (
    <dl className="phs-tiles pnd-tiles">
      {tiles.map((t) => (
        <div className="phs-tile" key={t.label}>
          <dt>{t.label}</dt>
          <dd>{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Reasons({ reasons }) {
  return (
    <ul className="pnd-reasons" aria-label="Reasons">
      {Object.entries(reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => (
          <li key={code} className={`pnd-reason pnd-reason--${code}`}>
            {NEEDED_REASON_LABEL[code] ?? code}
            <strong>{n}</strong>
          </li>
        ))}
    </ul>
  );
}

function Notes({ notes }) {
  if (!notes.length) return <span className="phs-meta">—</span>;
  const [first, ...rest] = notes;
  return (
    <div className="pnd-notes">
      <p>
        <span className="phs-meta">{showDate(first.date)}</span> {first.text}
      </p>
      {rest.length ? (
        <details>
          <summary>{rest.length} more</summary>
          {rest.map((n, i) => (
            <p key={i}>
              <span className="phs-meta">{showDate(n.date)}</span> {n.text}
            </p>
          ))}
        </details>
      ) : null}
    </div>
  );
}

export default function PharmacyNeededPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canManage = hasCapability(role, CAPABILITIES.PHARMACY_STOCK_UPLOAD);
  const [days, setDays] = useUrlState("days", "30");
  const [reason, setReason] = useUrlState("reason", "");
  const [page, setPage] = useUrlState("page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("size", 25, asNumber);
  const { search, setSearch, q, clear: clearSearch } = useUrlSearch("q", () => setPage(1));
  const [error, setError] = useState("");
  const period = PERIODS.some((p) => p.key === days) ? days : "30";
  const params = { days: Number(period), ...(reason ? { reason } : {}), ...(q ? { q } : {}) };
  const query = useNeededStock(params);
  const all = useNeededStock({ days: Number(period), ...(q ? { q } : {}) });
  const mark = useMarkNeededOrdered();
  const clear = useClearNeededOrdered();
  const busy = mark.isPending || clear.isPending;

  const data = query.data;
  const items = data?.items ?? [];
  const lastPage = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, lastPage);
  const shown = items.slice((current - 1) * pageSize, current * pageSize);
  const counts = all.data?.summary.byReason ?? {};
  const reasonOptions = [
    { key: "", label: `All (${all.data?.summary.times ?? 0})` },
    ...Object.keys(NEEDED_REASON_LABEL)
      .filter((code) => counts[code] || code === reason)
      .map((code) => ({ key: code, label: `${NEEDED_REASON_LABEL[code]} (${counts[code] ?? 0})` })),
  ];

  const run = async (action, body, fallback, done) => {
    setError("");
    try {
      await action.mutateAsync(body);
      toast(done);
    } catch (e) {
      setError(requestErrorOf(e, fallback));
    }
  };

  const exportFile = async () => {
    setError("");
    try {
      const search = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ).toString();
      await downloadFile(`${NEEDED_URL}/export.xlsx?${search}`, "needed-in-stock.xlsx");
    } catch (e) {
      setError(e.message || "Could not download the list");
    }
  };

  const clearFilters = () => {
    clearSearch();
    setReason("");
    setPage(1);
  };

  return (
    <div className="flow-root fset bill-ui phs pnd">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Needed in stock</h1>
          <p className="phs-sub">
            Medicines doctors prescribed that patients did not take from our pharmacy, and why. Use
            it to decide what to stock.
          </p>
        </div>
        <div className="phs-head__acts">
          <button type="button" className="flow-btn flow-btn-ghost phs-upload" onClick={exportFile}>
            <Download size={15} aria-hidden="true" />
            Download list
          </button>
          {canManage ? (
            <SheetImportButton
              label="Import from Excel"
              title="Import needed medicines from Excel"
              intro="Add medicines that were needed but not given, for example from a paper register. Download the sample to see the format."
              noun="entry"
              source={sheetSource}
              sample={{ url: `${NEEDED_URL}/sample.xlsx`, name: "needed-in-stock-sample.xlsx" }}
              problemsName="needed-in-stock-to-fix.xlsx"
              invalidate={[stockKeys.needed]}
            />
          ) : null}
        </div>
      </header>

      {data ? <Summary summary={data.summary} /> : null}

      <section className="flow-card" aria-labelledby="pnd-title">
        <div className="fset__cardhead">
          <h2 id="pnd-title" className="flow-sec-title">
            Medicines
          </h2>
          <span className="fset__count">{items.length}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="pnd-search">
            Search medicines
          </label>
          <input
            id="pnd-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by medicine name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <PillGroup
            label="Period"
            value={period}
            options={PERIODS}
            onChange={(key) => {
              setDays(key);
              setPage(1);
            }}
          />
        </div>
        <div className="pnd-reasonbar">
          <PillGroup
            label="Filter by reason"
            value={reason}
            options={reasonOptions}
            onChange={(key) => {
              setReason(key);
              setPage(1);
            }}
          />
        </div>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        {query.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load the list.</p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => query.refetch()}
            >
              Try again
            </button>
          </div>
        ) : query.isLoading ? (
          <p className="phs-empty" role="status">
            Loading…
          </p>
        ) : !items.length ? (
          <div className="phs-empty">
            {q || reason ? (
              <>
                <p>No medicines match the current filters.</p>
                <button type="button" className="flow-btn flow-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <p>Every prescribed medicine was given in the last {period} days.</p>
            )}
          </div>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table phs-table" aria-label="Medicines needed in stock">
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Stock now</th>
                  <th className="phs-count">Times</th>
                  <th className="phs-count">Patients</th>
                  <th>Why not given</th>
                  <th>Notes</th>
                  <th>Last</th>
                  <th>Order</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.medicineKey}>
                    <td data-label="Medicine">
                      <span className="phs-item">{item.medicineName}</span>
                      {item.doctors.length ? (
                        <span className="phs-meta">{item.doctors.join(", ")}</span>
                      ) : null}
                      {item.qtyUnits ? (
                        <span className="phs-meta">{item.qtyUnits} units asked</span>
                      ) : null}
                    </td>
                    <td data-label="Stock now">
                      <span
                        className={`bill-status phs-badge phs-badge--${STOCK[item.status].tone}`}
                      >
                        {STOCK[item.status].text}
                      </span>
                    </td>
                    <td data-label="Times" className="phs-count">
                      {item.times}
                    </td>
                    <td data-label="Patients" className="phs-count">
                      {item.patients}
                    </td>
                    <td data-label="Why not given">
                      <Reasons reasons={item.reasons} />
                    </td>
                    <td data-label="Notes">
                      <Notes notes={item.notes} />
                    </td>
                    <td data-label="Last">{showDate(item.lastPrescribed)}</td>
                    <td data-label="Order">
                      {item.ordered ? (
                        <div className="pnd-order">
                          <span className="bill-status phs-badge phs-badge--ok">Ordered</span>
                          <span className="phs-meta">
                            {item.ordered.by ? `${item.ordered.by} · ` : ""}
                            {when(item.ordered.at)}
                          </span>
                          {canManage ? (
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
                                  `${item.medicineName} is no longer marked ordered.`,
                                )
                              }
                            >
                              Undo
                            </button>
                          ) : null}
                        </div>
                      ) : canManage ? (
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
                              `${item.medicineName} marked as ordered.`,
                            )
                          }
                        >
                          Mark ordered
                        </button>
                      ) : (
                        <span className="phs-meta">—</span>
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
          disabled={query.isFetching}
          unit="medicines"
        />
      </section>
    </div>
  );
}
