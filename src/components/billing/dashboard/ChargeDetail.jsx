import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import Shimmer from "../../Shimmer";
import { useChargeDetail } from "../../../queries/hooks/useBillingDashboard";
import { errorOf } from "../format";
import { bucketLabel, count, money, PERIOD_LABELS } from "./dashboardText";

function Crumbs({ detail, onOpen, onClose }) {
  return (
    <nav className="bdash-crumbs" aria-label="Charges detail">
      <button type="button" className="bdash-link" onClick={onClose}>
        All service groups
      </button>
      <span aria-hidden="true"> › </span>
      {detail.subgroup ? (
        <>
          <button type="button" className="bdash-link" onClick={() => onOpen(detail.group.key)}>
            {detail.group.label}
          </button>
          <span aria-hidden="true"> › </span>
          <span aria-current="page">{detail.subgroup.label}</span>
        </>
      ) : (
        <span aria-current="page">{detail.group.label}</span>
      )}
    </nav>
  );
}

function SubgroupTable({ detail, period, onOpen }) {
  if (!detail.columns.length) {
    return <div className="bill-allclear">No charges in this group for these filters.</div>;
  }
  return (
    <div className="fset__scroll fset__scroll--wide">
      <table
        className="flow-table brep-table bdash-mis"
        aria-label={`${detail.group.label} by subgroup`}
      >
        <thead>
          <tr>
            <th scope="col" className="bdash-sticky">
              {PERIOD_LABELS[period]}
            </th>
            {detail.columns.map((column) => (
              <th key={column.key} scope="col" className="brep-num">
                <button
                  type="button"
                  className="bdash-link"
                  onClick={() => onOpen(detail.group.key, column.key)}
                  aria-label={`Open ${column.label} items`}
                >
                  {column.label} ›
                </button>
              </th>
            ))}
            <th scope="col" className="brep-num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.rows.map((row) => (
            <tr key={row.bucket}>
              <th scope="row" className="bdash-sticky">
                {bucketLabel(row, period)}
                {row.partial ? " (part)" : ""}
              </th>
              {detail.columns.map((column) => (
                <td key={column.key} className="brep-num">
                  {money(row.charges[column.key] ?? 0)}
                </td>
              ))}
              <td className="brep-num bdash-strong">{money(row.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="brep-total">
            <th scope="row" className="bdash-sticky">
              Grand Total
            </th>
            {detail.columns.map((column) => (
              <td key={column.key} className="brep-num">
                {money(detail.total.charges[column.key] ?? 0)}
              </td>
            ))}
            <td className="brep-num">{money(detail.total.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ItemTable({ detail }) {
  if (!detail.items.length) {
    return <div className="bill-allclear">No charges in this subgroup for these filters.</div>;
  }
  return (
    <div className="fset__scroll fset__scroll--tall">
      <table className="flow-table brep-table" aria-label={`${detail.subgroup.label} items`}>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="brep-num">
              Quantity
            </th>
            <th scope="col" className="brep-num">
              Charges
            </th>
            <th scope="col" className="brep-num">
              Discount
            </th>
            <th scope="col" className="brep-num">
              After discount
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.items.map((item) => (
            <tr key={item.key}>
              <th scope="row" className="bdash-wrap">
                {item.name}
                {item.code ? <span className="bdash-muted"> · {item.code}</span> : null}
              </th>
              <td className="brep-num">{count(item.quantity)}</td>
              <td className="brep-num">{money(item.charges)}</td>
              <td className="brep-num">{money(-item.discount)}</td>
              <td className="brep-num">{money(item.net)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="brep-total">
            <th scope="row">Total</th>
            <td className="brep-num">{count(detail.total.quantity)}</td>
            <td className="brep-num">{money(detail.total.charges)}</td>
            <td className="brep-num">{money(-detail.total.discount)}</td>
            <td className="brep-num">{money(detail.total.net)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function ChargeDetail({ filters, period, group, subgroup, onOpen, onClose }) {
  const detail = useChargeDetail({ ...filters, group, subgroup });
  const heading = useRef(null);
  useEffect(() => {
    heading.current?.scrollIntoView?.({ block: "nearest" });
  }, [group, subgroup]);
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-charge-detail">
      <div className="fset__cardhead">
        <h2 id="bdash-charge-detail" className="flow-sec-title" ref={heading}>
          Charges detail
        </h2>
        <button
          type="button"
          className="flow-btn flow-btn-mini flow-btn-ghost bdash-close"
          onClick={onClose}
          aria-label="Close charges detail"
        >
          <X size={14} aria-hidden="true" /> Close
        </button>
      </div>
      {detail.isError ? (
        <div className="brep-error" role="alert">
          {errorOf(detail.error, "Could not load the charges detail")}{" "}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => detail.refetch()}>
            Try again
          </button>
        </div>
      ) : !detail.data ? (
        <Shimmer type="table" count={4} />
      ) : (
        <>
          <Crumbs detail={detail.data} onOpen={onOpen} onClose={onClose} />
          <div className="fset__cardsub">
            {detail.data.level === "subgroup"
              ? "Charges before discount, by subgroup. Open a subgroup to see its items."
              : "Every item billed in this subgroup over the whole date range, largest first."}
          </div>
          {detail.data.level === "subgroup" ? (
            <SubgroupTable detail={detail.data} period={period} onOpen={onOpen} />
          ) : (
            <ItemTable detail={detail.data} />
          )}
        </>
      )}
    </section>
  );
}
