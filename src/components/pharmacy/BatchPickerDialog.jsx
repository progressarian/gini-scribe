import { useState } from "react";
import { WandSparkles } from "lucide-react";
import MasterFormDialog from "./MasterFormDialog";
import FormField from "../ui/FormField";
import { digitsTyped } from "../billing/format";
import { inr, localDate, packUnits, showDate } from "./format";

const daysLeft = (iso) =>
  Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${localDate()}T00:00:00`)) / 86400000);

export function autoFill(batches, needed) {
  let left = needed;
  const picked = {};
  for (const b of batches) {
    if (b.expired || left <= 0) continue;
    const take = Math.min(b.qty_units, left);
    if (take > 0) picked[b.id] = String(take);
    left -= take;
  }
  return { picked, short: Math.max(left, 0) };
}

export default function BatchPickerDialog({
  medicine,
  current,
  warnDays,
  suggested = null,
  prescribed = null,
  onApply,
  onClose,
  applyLabel = "Add to bill",
  removeLabel = "Remove from bill",
}) {
  const sellable = medicine.batches.filter((b) => !b.expired);
  const inStock = sellable.reduce((sum, b) => sum + b.qty_units, 0);
  const prefill = suggested && !Object.keys(current).length ? suggested : null;
  const [qty, setQty] = useState(() => {
    if (prefill) {
      const { picked } = autoFill(medicine.batches, prefill);
      return Object.fromEntries(medicine.batches.map((b) => [b.id, picked[b.id] ?? ""]));
    }
    return Object.fromEntries(
      medicine.batches.map((b) => [b.id, current[b.id] ? String(current[b.id].qty_units) : ""]),
    );
  });
  const [checked, setChecked] = useState(() =>
    Object.fromEntries(medicine.batches.map((b) => [b.id, Boolean(current[b.id]?.near_expiry_ok)])),
  );
  const [needed, setNeeded] = useState(prefill ? String(prefill) : "");
  const [fillNote, setFillNote] = useState(
    prefill ? "Filled from the prescription, earliest expiry first. Check the quantity." : "",
  );
  const [touched, setTouched] = useState(false);

  const units = (id) => Number(qty[id] || 0);
  const total = medicine.batches.reduce((sum, b) => sum + units(b.id), 0);
  const nearExpiry = (b) => !b.expired && daysLeft(b.expiry_date) <= warnDays;

  const problems = {};
  for (const b of medicine.batches) {
    const n = units(b.id);
    if (!n) continue;
    if (n > b.qty_units)
      problems[b.id] = `Only ${b.qty_units} ${medicine.unit_label} in this batch.`;
    else if (!medicine.allow_loose_sale && n % medicine.pack_size)
      problems[b.id] =
        `Whole ${medicine.pack_label}s only (${medicine.pack_size} ${medicine.unit_label} each).`;
    else if (nearExpiry(b) && !checked[b.id])
      problems[b.id] = "Tick to confirm you are giving this near-expiry batch.";
  }
  const hasCurrent = Object.keys(current).length > 0;
  if (!total && !hasCurrent) problems.total = "Enter the quantity to give from at least one batch.";
  const errors = touched ? problems : {};

  const fill = () => {
    const n = Number(needed || 0);
    if (!n) {
      setFillNote("Enter the quantity needed first.");
      return;
    }
    const { picked, short } = autoFill(medicine.batches, n);
    setQty(Object.fromEntries(medicine.batches.map((b) => [b.id, picked[b.id] ?? ""])));
    setFillNote(
      short
        ? `Only ${inStock} ${medicine.unit_label} are in stock, ${short} short.`
        : `Filled from the earliest expiry first.`,
    );
  };

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(problems).length) return;
    onApply(
      medicine.batches
        .filter((b) => units(b.id) > 0)
        .map((b) => ({ batch_id: b.id, qty_units: units(b.id), near_expiry_ok: nearExpiry(b) })),
    );
  };

  return (
    <MasterFormDialog
      title={`Choose batches · ${medicine.name}`}
      intro={
        <>
          {prescribed ? <p className="phb-prescribed">Prescribed: {prescribed}</p> : null}
          <p className="phs-meta">
            {medicine.pack_label} of {medicine.pack_size} {medicine.unit_label} ·{" "}
            {packUnits(inStock, medicine)} in stock. Soonest expiry is at the top.
          </p>
        </>
      }
      dirty={total > 0}
      busy={false}
      error={errors.total}
      submitLabel={hasCurrent && !total ? removeLabel : applyLabel}
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="phb-fill">
        <FormField
          label={`Quantity needed (${medicine.unit_label})`}
          hint={needed ? packUnits(Number(needed), medicine) : "Then auto-fill the batches"}
        >
          <input
            className="jb-assign"
            inputMode="numeric"
            maxLength={6}
            autoFocus
            value={needed}
            onChange={(e) => {
              setNeeded(digitsTyped(e.target.value));
              setFillNote("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                fill();
              }
            }}
          />
        </FormField>
        <button type="button" className="flow-btn flow-btn-ghost" onClick={fill}>
          <WandSparkles size={14} aria-hidden="true" />
          Auto-fill (earliest expiry first)
        </button>
        <p className="phs-meta" role="status" aria-live="polite">
          {fillNote}
        </p>
      </div>

      <div className="fset__scroll">
        <table className="flow-table phs-table phb-batches" aria-label="Batches in stock">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Expiry</th>
              <th>Rack</th>
              <th className="phs-num">In stock</th>
              <th className="phs-num">MRP / {medicine.pack_label}</th>
              <th className="phs-num">Give ({medicine.unit_label})</th>
            </tr>
          </thead>
          <tbody>
            {medicine.batches.map((b) => {
              const left = daysLeft(b.expiry_date);
              const near = nearExpiry(b);
              return (
                <tr key={b.id} className={b.expired ? "phs-row--out" : ""}>
                  <td data-label="Batch" className="phv-mono">
                    {b.batch_no}
                  </td>
                  <td data-label="Expiry">
                    {showDate(b.expiry_date)}
                    {b.expired ? (
                      <span className="bill-status phs-badge phs-badge--out">Expired</span>
                    ) : near ? (
                      <span className="bill-status phs-badge phs-badge--review">
                        {left} day{left === 1 ? "" : "s"} left
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Rack">{b.rack_no ?? <span className="phs-meta">—</span>}</td>
                  <td data-label="In stock" className="phs-num">
                    {packUnits(b.qty_units, medicine)}
                  </td>
                  <td data-label="MRP" className="phs-num">
                    {inr(b.mrp)}
                  </td>
                  <td data-label="Give" className="phs-num">
                    {b.expired ? (
                      <span className="phs-meta">Cannot be sold</span>
                    ) : (
                      <div className="phb-give">
                        <input
                          className="jb-assign phb-qty"
                          inputMode="numeric"
                          maxLength={6}
                          aria-label={`Quantity from batch ${b.batch_no}`}
                          aria-invalid={errors[b.id] ? true : undefined}
                          value={qty[b.id]}
                          onChange={(e) => setQty({ ...qty, [b.id]: digitsTyped(e.target.value) })}
                        />
                        {near && units(b.id) > 0 ? (
                          <label className="phb-confirm">
                            <input
                              type="checkbox"
                              checked={checked[b.id]}
                              onChange={(e) => setChecked({ ...checked, [b.id]: e.target.checked })}
                            />
                            Near expiry checked
                          </label>
                        ) : null}
                        {errors[b.id] ? (
                          <small className="form-field__error" role="alert">
                            {errors[b.id]}
                          </small>
                        ) : null}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="phb-picked" role="status">
        Giving {total ? packUnits(total, medicine) : "nothing yet"}
      </p>
    </MasterFormDialog>
  );
}
