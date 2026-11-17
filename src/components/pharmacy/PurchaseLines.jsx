import { Trash2 } from "lucide-react";
import { digitsTyped, moneyTyped } from "../billing/format";
import { inr, showDate } from "./format";
import { purchaseLineAmounts, receivedUnits, toRupees } from "../../../shared/pharmacyMoney";
import { splitUnits } from "../../../shared/pharmacyVocab";

const batchTyped = (v) => v.toUpperCase().replace(/[^A-Z0-9/._-]/g, "");

const COLUMNS = [
  { field: "batch_no", label: "Batch", width: 110, clean: batchTyped, max: 30 },
  { field: "expiry_date", label: "Expiry", width: 140, type: "date" },
  { field: "qty_packs", label: "Qty", width: 70, clean: digitsTyped, numeric: true, max: 7 },
  { field: "free_packs", label: "Free", width: 64, clean: digitsTyped, numeric: true, max: 7 },
  {
    field: "purchase_rate",
    label: "Purchase rate",
    width: 90,
    clean: moneyTyped,
    numeric: true,
    max: 11,
  },
  { field: "discount_pct", label: "Disc %", width: 70, clean: moneyTyped, numeric: true, max: 6 },
  { field: "gst_rate_pct", label: "GST %", width: 64, clean: moneyTyped, numeric: true, max: 5 },
  { field: "mrp", label: "MRP", width: 90, clean: moneyTyped, numeric: true, max: 11 },
  { field: "sale_rate", label: "Sale rate", width: 90, clean: moneyTyped, numeric: true, max: 11 },
  { field: "rack_no", label: "Rack", width: 80, max: 40 },
];

const unitsText = (line) => {
  const units = receivedUnits(line, line.medicine.pack_size);
  if (!units) return null;
  const { packs, loose } = splitUnits(units, line.medicine.pack_size);
  return line.medicine.pack_size > 1
    ? `${units} ${line.medicine.unit_label} (${packs} ${line.medicine.pack_label}${loose ? ` + ${loose}` : ""})`
    : `${units} ${line.medicine.pack_label}`;
};

export function PurchaseLinesEditor({ lines, errors, onChange, onRemove }) {
  return (
    <div className="fset__scroll">
      <table className="flow-table phs-table pur-lines" aria-label="Medicines received">
        <thead>
          <tr>
            <th>Medicine</th>
            {COLUMNS.map((c) => (
              <th key={c.field} className={c.numeric ? "phs-num" : undefined}>
                {c.label}
              </th>
            ))}
            <th className="phs-num">Total</th>
            <th>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => {
            const amounts = purchaseLineAmounts(line);
            const rowErrors = COLUMNS.map((c) => errors[`${line.key}.${c.field}`]).filter(Boolean);
            return (
              <tr key={line.key} aria-invalid={rowErrors.length ? true : undefined}>
                <td data-label="Medicine" className="pur-lines__medicine">
                  <span className="phs-item">
                    {i + 1}. {line.medicine.name}
                  </span>
                  <span className="phs-meta">
                    {line.medicine.pack_label} of {line.medicine.pack_size}{" "}
                    {line.medicine.unit_label}
                    {unitsText(line) ? ` · receiving ${unitsText(line)}` : ""}
                  </span>
                  {rowErrors.length ? (
                    <span className="lvl-error" role="alert">
                      {rowErrors.join(" ")}
                    </span>
                  ) : null}
                </td>
                {COLUMNS.map((c) => {
                  const id = `pur-${line.key}-${c.field}`;
                  const invalid = Boolean(errors[`${line.key}.${c.field}`]);
                  return (
                    <td key={c.field} data-label={c.label}>
                      <label className="sr-only" htmlFor={id}>
                        {c.label} for line {i + 1}, {line.medicine.name}
                      </label>
                      <input
                        id={id}
                        className="jb-assign pur-input"
                        style={{ width: c.width }}
                        type={c.type ?? "text"}
                        inputMode={c.numeric ? "decimal" : undefined}
                        maxLength={c.max}
                        aria-invalid={invalid || undefined}
                        value={line[c.field]}
                        onChange={(e) =>
                          onChange(
                            line.key,
                            c.field,
                            c.clean ? c.clean(e.target.value) : e.target.value,
                          )
                        }
                      />
                    </td>
                  );
                })}
                <td data-label="Total" className="phs-num">
                  {inr(toRupees(amounts.total))}
                </td>
                <td>
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost flow-btn-mini"
                    onClick={() => onRemove(line.key)}
                    aria-label={`Remove line ${i + 1}, ${line.medicine.name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PurchaseLinesView({ lines }) {
  return (
    <div className="fset__scroll">
      <table className="flow-table phs-table pur-lines" aria-label="Medicines received">
        <thead>
          <tr>
            <th>Medicine</th>
            <th>Batch</th>
            <th>Expiry</th>
            <th className="phs-num">Qty + free</th>
            <th className="phs-num">Purchase rate</th>
            <th className="phs-num">Disc %</th>
            <th className="phs-num">GST</th>
            <th className="phs-num">MRP / sale</th>
            <th>Rack</th>
            <th className="phs-num">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td data-label="Medicine">
                <span className="phs-item">
                  {l.line_no}. {l.medicine_name}
                </span>
                <span className="phs-meta">
                  {l.medicine_code} · {l.pack_label} of {l.pack_size} {l.unit_label}
                </span>
              </td>
              <td data-label="Batch" className="phv-mono">
                {l.batch_no}
              </td>
              <td data-label="Expiry">{showDate(l.expiry_date)}</td>
              <td data-label="Qty + free" className="phs-num">
                {l.qty_packs}
                {l.free_packs ? ` + ${l.free_packs}` : ""}
              </td>
              <td data-label="Purchase rate" className="phs-num">
                {inr(l.purchase_rate)}
              </td>
              <td data-label="Disc %" className="phs-num">
                {Number(l.discount_pct)}%
              </td>
              <td data-label="GST" className="phs-num">
                {inr(l.gst_amount)}
                <span className="phs-meta">{Number(l.gst_rate_pct)}%</span>
              </td>
              <td data-label="MRP / sale" className="phs-num">
                {inr(l.mrp)}
                <span className="phs-meta">Sale {inr(l.sale_rate)}</span>
              </td>
              <td data-label="Rack">{l.rack_no ?? <span className="phs-meta">—</span>}</td>
              <td data-label="Total" className="phs-num">
                {inr(l.line_total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PurchaseTotals({ discount, taxable, gst, total }) {
  return (
    <dl className="pur-totals" aria-label="Receipt totals">
      <div>
        <dt>Discount</dt>
        <dd>−{inr(discount)}</dd>
      </div>
      <div>
        <dt>Taxable value</dt>
        <dd>{inr(taxable)}</dd>
      </div>
      <div>
        <dt>GST</dt>
        <dd>{inr(gst)}</dd>
      </div>
      <div className="pur-totals__net">
        <dt>Net payable to vendor</dt>
        <dd>{inr(total)}</dd>
      </div>
    </dl>
  );
}
