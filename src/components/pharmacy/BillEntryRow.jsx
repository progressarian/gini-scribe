import { useEffect, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import MedicinePicker from "./MedicinePicker";
import BatchSelect, { batchNearExpiry, batchText } from "./BatchSelect";
import { describeStock, useStockOptions } from "./stockOptions";
import { digitsTyped } from "../billing/format";
import { inr, packUnits, pctTyped, showDate } from "./format";
import { autoFill } from "../../../shared/pharmacyBatchFill";

const packsLabel = (n, medicine) => packUnits(n * medicine.pack_size, medicine);

const firstQty = (entry) =>
  entry?.suggested ? String(Math.ceil(entry.suggested / entry.medicine.pack_size)) : "1";

export function splitAcrossBatches({ medicine, batches, onBill, chosen, packs }) {
  const size = Math.max(Number(medicine.pack_size) || 1, 1);
  const free = (b) => Math.floor(Math.max(b.qty_units - (onBill[b.id] ?? 0), 0) / size);
  const sellable = batches.filter((b) => !b.expired);
  const inStock = sellable.reduce((sum, b) => sum + free(b), 0);
  if (packs > inStock) return { short: true, inStock };
  const fromChosen = Math.min(free(chosen), packs);
  const rest = sellable
    .filter((b) => b.id !== chosen.id)
    .map((b) => ({ ...b, qty_units: free(b) }));
  const { picked } = autoFill(rest, packs - fromChosen);
  const taken = [
    ...(fromChosen ? [{ batch: chosen, packs: fromChosen }] : []),
    ...rest.filter((b) => picked[b.id]).map((b) => ({ batch: b, packs: Number(picked[b.id]) })),
  ];
  return { short: false, inStock, taken, fromChosen };
}

const splitNotice = (medicine, chosen, fromChosen, others) =>
  `Only ${fromChosen ? packsLabel(fromChosen, medicine) : "nothing"} left in batch ${chosen.batch_no} — ${others
    .map(
      ({ batch, packs }) => `${packsLabel(packs, medicine)} taken from batch ${batchText(batch)}`,
    )
    .join(", ")}.`;

export default function BillEntryRow({
  entry,
  onBill,
  showGst,
  locked,
  busy,
  onPickMedicine,
  onClear,
  onAdd,
}) {
  const medicineRef = useRef(null);
  const batchRef = useRef(null);
  const qtyRef = useRef(null);
  const discRef = useRef(null);
  const [chosen, setChosen] = useState(null);
  const [qty, setQty] = useState("1");
  const [disc, setDisc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const line = entry?.editing;
    const same = Boolean(line && line.medicine_id === entry.medicine.id);
    setChosen(same ? (entry.batches.find((b) => b.id === line.batch_id) ?? null) : null);
    setQty(same ? String(Math.round(line.qty_units / entry.medicine.pack_size)) : firstQty(entry));
    setDisc(same && Number(line.discount_pct) ? String(Number(line.discount_pct)) : "");
    setError("");
    if (entry) batchRef.current?.focus();
  }, [entry]);

  const focusSelect = (ref) => {
    ref.current?.focus();
    ref.current?.select?.();
  };

  const clear = () => {
    onClear();
    setError("");
    focusSelect(medicineRef);
  };

  const submit = async () => {
    if (busy || locked || !entry) return;
    if (!chosen) {
      setError("Choose a batch first.");
      batchRef.current?.focus();
      return;
    }
    const packs = Number(qty || 0);
    if (!packs) {
      setError(`Enter how many ${entry.medicine.pack_label}s to give.`);
      focusSelect(qtyRef);
      return;
    }
    const split = splitAcrossBatches({
      medicine: entry.medicine,
      batches: entry.batches,
      onBill,
      chosen,
      packs,
    });
    if (split.short) {
      setError(`Only ${packsLabel(split.inStock, entry.medicine)} in stock.`);
      focusSelect(qtyRef);
      return;
    }
    const discount = disc === "" ? null : Number(disc);
    const lines = split.taken.map(({ batch, packs: n }) => ({
      batch_id: batch.id,
      qty_units: n * entry.medicine.pack_size,
      near_expiry_ok: batchNearExpiry(batch, entry.warnDays),
      discount_pct: discount,
    }));
    const others = split.taken.filter((t) => t.batch.id !== chosen.id);
    const notice = others.length
      ? splitNotice(entry.medicine, chosen, split.fromChosen, others)
      : "";
    setError("");
    if (await onAdd(lines, notice)) focusSelect(medicineRef);
  };

  const onEnter = (next) => (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (next) focusSelect(next);
    else submit();
  };

  const onRowKey = (e) => {
    if (e.key === "Escape" && entry) {
      e.preventDefault();
      clear();
    }
  };

  return (
    <tr className="phb-entry" onKeyDown={onRowKey}>
      <td data-label="Medicine">
        <MedicinePicker
          inputRef={medicineRef}
          label="Add medicine"
          hideLabel
          autoFocus
          disabled={locked}
          placeholder={entry ? entry.medicine.name : "Medicine name or code"}
          useOptions={useStockOptions}
          optionId={(m) => m.medicine_id}
          describeOption={describeStock}
          noMatchText="No medicine in stock matches."
          onSelect={(m) => onPickMedicine(m.medicine_id)}
        />
        {entry ? (
          <span className="phs-meta">
            {entry.editing
              ? `Editing ${entry.editing.medicine_name} · batch ${entry.editing.batch_no} — Esc cancels`
              : entry.medicine.name}
            {entry.prescribed ? ` · Prescribed: ${entry.prescribed}` : ""}
          </span>
        ) : null}
      </td>
      <td data-label="Batch">
        {entry ? (
          <>
            <BatchSelect
              medicine={entry.medicine}
              batches={entry.batches}
              warnDays={entry.warnDays}
              chosen={chosen}
              inputRef={batchRef}
              disabled={locked}
              onChoose={(b) => {
                setChosen(b);
                setError("");
                focusSelect(qtyRef);
              }}
            />
            {chosen ? (
              <span className="phs-meta">
                Exp {showDate(chosen.expiry_date)}
                {chosen.rack_no ? ` · Rack ${chosen.rack_no}` : ""} ·{" "}
                {packUnits(chosen.qty_units, entry.medicine)} in stock
              </span>
            ) : null}
          </>
        ) : (
          <span className="phs-meta">Choose a medicine first</span>
        )}
      </td>
      <td data-label="Quantity" className="phs-num">
        <input
          ref={qtyRef}
          className="jb-assign phb-qty"
          inputMode="numeric"
          maxLength={4}
          aria-label={
            entry
              ? `Quantity in ${entry.medicine.pack_label}s for the new medicine`
              : "Quantity for the new medicine"
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "phb-entry-error" : undefined}
          disabled={!entry || locked}
          value={qty}
          onChange={(e) => setQty(digitsTyped(e.target.value))}
          onKeyDown={onEnter(discRef)}
        />
        {entry && Number(qty) ? (
          <span className="phs-meta">{packsLabel(Number(qty), entry.medicine)}</span>
        ) : null}
      </td>
      <td data-label="Rate / pack" className="phs-num">
        {chosen ? <span className="phs-meta">MRP {inr(chosen.mrp)}</span> : "—"}
      </td>
      <td data-label="Disc %" className="phs-num">
        <input
          ref={discRef}
          className="jb-assign phb-qty"
          inputMode="decimal"
          maxLength={6}
          placeholder="0"
          aria-label="Discount % for the new medicine"
          disabled={!entry || locked}
          value={disc}
          onChange={(e) => setDisc(pctTyped(e.target.value))}
          onKeyDown={onEnter(null)}
        />
      </td>
      {showGst ? (
        <td data-label="GST" className="phs-num">
          {chosen ? `${Number(chosen.gst_rate_pct)}%` : "—"}
        </td>
      ) : null}
      <td data-label="Amount" className="phs-num">
        —
      </td>
      <td className="phb-line-acts">
        <button
          type="button"
          className="flow-btn flow-btn-primary"
          disabled={!entry || locked || busy}
          onClick={submit}
        >
          {entry?.editing ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Plus size={14} aria-hidden="true" />
          )}
          {entry?.editing ? (busy ? "Updating…" : "Update") : busy ? "Adding…" : "Add"}
        </button>
        {error ? (
          <small id="phb-entry-error" className="form-field__error" role="alert">
            {error}
          </small>
        ) : null}
      </td>
    </tr>
  );
}
