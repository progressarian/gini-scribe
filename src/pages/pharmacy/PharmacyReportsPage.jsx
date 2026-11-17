import { useState } from "react";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import FormField from "../../components/ui/FormField";
import { DateInput, SelectInput } from "../../components/pharmacy/Fields";
import { downloadFile } from "../../lib/downloadBlob";
import { inr, localDate, showDate } from "../../components/pharmacy/format";
import { toast } from "../../stores/uiStore";
import { reportExportUrl, useReport, useReportList } from "../../queries/hooks/usePharmacyReports";
import { SALE_TYPE_LABEL, PAYMENT_MODE_LABEL } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";
import useUrlState from "../../hooks/useUrlState";

const WORDS = { sale_type: SALE_TYPE_LABEL, mode: PAYMENT_MODE_LABEL };

function cell(column, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (column.type === "money") return inr(value);
  if (column.type === "int") return Number(value).toLocaleString("en-IN");
  if (column.type === "date") return showDate(String(value).slice(0, 10));
  return WORDS[column.key]?.[value] ?? String(value);
}

const numeric = (column) => column.type === "money" || column.type === "int";

function ReportTable({ result }) {
  if (!result.rows.length) {
    return <p className="phs-empty">Nothing to show for this period.</p>;
  }
  const hasTotals = Object.keys(result.totals).length > 0;
  return (
    <div className="fset__scroll">
      <table className="flow-table phs-table" aria-label={result.label}>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.key} className={numeric(c) ? "phs-num" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {result.columns.map((c) => (
                <td key={c.key} data-label={c.label} className={numeric(c) ? "phs-num" : undefined}>
                  {cell(c, row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals ? (
          <tfoot>
            <tr className="phr-total">
              {result.columns.map((c, i) => (
                <td key={c.key} className={numeric(c) ? "phs-num" : undefined}>
                  {i === 0 ? "Total" : c.key in result.totals ? cell(c, result.totals[c.key]) : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

export default function PharmacyReportsPage() {
  const list = useReportList();
  const [reportParam, setReport] = useUrlState("report", "");
  const reports = list.data ?? [];
  const key = reports.some((r) => r.key === reportParam) ? reportParam : reports[0]?.key;
  const chosen = reports.find((r) => r.key === key);
  const [from, setFrom] = useUrlState("from", localDate(-6));
  const [to, setTo] = useUrlState("to", localDate());
  const [downloading, setDownloading] = useState(false);
  const badRange = chosen?.dated && from > to;
  const period = chosen?.dated ? { from, to } : {};
  const result = useReport(key, period, { enabled: Boolean(chosen) && !badRange });

  const download = async () => {
    setDownloading(true);
    try {
      await downloadFile(reportExportUrl(key, period), `Pharmacy_${key}.xlsx`);
    } catch (err) {
      toast(err.message || "The download failed. Try again.", "error");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy reports</h1>
          <p className="phs-sub">Sales, GST, collections, purchases, registers and stock.</p>
        </div>
        <div className="phs-head__acts">
          <Link className="flow-btn flow-btn-ghost phs-upload" to="/pharmacy/reports/top-items">
            Top selling items
          </Link>
          <button
            type="button"
            className="flow-btn flow-btn-ghost phs-upload"
            disabled={!result.data || downloading || badRange}
            onClick={download}
          >
            <Download size={15} aria-hidden="true" />
            {downloading ? "Preparing…" : "Download Excel"}
          </button>
        </div>
      </header>

      <section className="flow-card" aria-label="Choose report">
        <div className="bill-form phr-pick">
          <FormField label="Report">
            <SelectInput
              value={key ?? ""}
              onChange={setReport}
              options={reports.map((r) => ({ value: r.key, label: r.label }))}
              placeholder="Loading reports…"
            />
          </FormField>
          {chosen?.dated ? (
            <>
              <FormField label="From" error={badRange ? "From must be on or before To." : null}>
                <DateInput value={from} maxDate={to} onChange={setFrom} />
              </FormField>
              <FormField label="To">
                <DateInput value={to} maxDate={localDate()} onChange={setTo} />
              </FormField>
            </>
          ) : null}
        </div>
        {chosen ? <p className="phs-meta">{chosen.description}</p> : null}
      </section>

      <section className="flow-card" aria-labelledby="phr-result-title">
        <div className="fset__cardhead">
          <h2 id="phr-result-title" className="flow-sec-title">
            {chosen?.label ?? "Report"}
          </h2>
          {result.data ? <span className="fset__count">{result.data.rows.length}</span> : null}
          {result.data?.dated ? (
            <span className="phs-meta">
              {showDate(result.data.from)} to {showDate(result.data.to)}
            </span>
          ) : null}
        </div>
        {list.isError || result.isError ? (
          <div className="phs-empty" role="alert">
            <p>
              {result.error?.response?.data?.error ??
                "Unable to load the report. Please try again."}
            </p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => (list.isError ? list.refetch() : result.refetch())}
            >
              Try again
            </button>
          </div>
        ) : !result.data ? (
          <p className="phs-empty" role="status">
            Loading the report…
          </p>
        ) : (
          <ReportTable result={result.data} />
        )}
      </section>
    </div>
  );
}
