import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import api from "../../services/api";
import MedicinePicker from "./MedicinePicker";
import BatchPickerDialog from "./BatchPickerDialog";
import { packUnits, showDate } from "./format";
import { requestErrorOf } from "../billing/format";
import { batchKeys, useBatchStock } from "../../queries/hooks/usePharmacyBatches";

const describeStock = (m) =>
  [
    m.code,
    `${packUnits(m.sellable_units, m)} in stock`,
    m.batches[0]?.rack_no && `Rack ${m.batches[0].rack_no}`,
  ]
    .filter(Boolean)
    .join(" · ");

export const linesForApi = (lines, { withNearExpiry = false } = {}) =>
  lines.map((l) => ({
    batch_id: l.batch_id,
    qty_units: l.qty_units,
    ...(withNearExpiry ? { near_expiry_ok: l.near_expiry_ok } : {}),
  }));

export default function StockLinesEditor({ locationId, locationName, lines, onChange, disabled }) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const useOptions = useCallback(
    (q) => {
      const search = useBatchStock(
        { q, filter: "in_stock", limit: 10, location_id: locationId },
        { enabled: Boolean(q && locationId) },
      );
      return { ...search, options: search.data?.rows ?? [] };
    },
    [locationId],
  );

  const open = async (medicineId) => {
    setError("");
    setLoading(true);
    try {
      const params = { medicine_id: medicineId, location_id: locationId };
      const found = await queryClient.fetchQuery({
        queryKey: batchKeys.medicine(params),
        queryFn: async () => (await api.get("/api/pharmacy/batches", { params })).data,
        staleTime: 0,
      });
      setPicking({
        medicine: { ...found.medicine, batches: found.batches },
        warnDays: found.near_expiry_warn_days,
      });
    } catch (err) {
      setError(requestErrorOf(err, "Could not load the batches"));
    } finally {
      setLoading(false);
    }
  };

  const current = picking
    ? Object.fromEntries(
        lines
          .filter((l) => l.medicine_id === picking.medicine.id)
          .map((l) => [l.batch_id, { qty_units: l.qty_units, near_expiry_ok: l.near_expiry_ok }]),
      )
    : {};

  const apply = (chosen) => {
    const medicine = picking.medicine;
    const byBatch = new Map(medicine.batches.map((b) => [b.id, b]));
    const others = lines.filter((l) => l.medicine_id !== medicine.id);
    onChange([
      ...others,
      ...chosen.map((c) => {
        const b = byBatch.get(c.batch_id);
        return {
          ...c,
          medicine_id: medicine.id,
          medicine_name: medicine.name,
          pack_size: medicine.pack_size,
          pack_label: medicine.pack_label,
          unit_label: medicine.unit_label,
          batch_no: b.batch_no,
          expiry_date: b.expiry_date,
          rack_no: b.rack_no,
        };
      }),
    ]);
    setPicking(null);
  };

  return (
    <>
      <div className="phb-add">
        <MedicinePicker
          key={locationId ?? "none"}
          disabled={disabled || !locationId || loading}
          label="Add medicine"
          placeholder={
            locationId
              ? `Search medicines in stock at ${locationName}`
              : "Choose the location first"
          }
          useOptions={useOptions}
          optionId={(m) => m.medicine_id}
          describeOption={describeStock}
          noMatchText={`No medicine in stock at ${locationName ?? "this location"} matches.`}
          onSelect={(m) => open(m.medicine_id)}
        />
      </div>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      {lines.length ? (
        <div className="fset__scroll">
          <table className="flow-table phs-table" aria-label="Medicines to move">
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Batch · expiry · rack</th>
                <th className="phs-num">Quantity</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.batch_id}>
                  <td data-label="Medicine">{l.medicine_name}</td>
                  <td data-label="Batch">
                    <span className="phv-mono">{l.batch_no}</span>
                    <span className="phs-meta">
                      Exp {showDate(l.expiry_date)}
                      {l.rack_no ? ` · Rack ${l.rack_no}` : ""}
                    </span>
                  </td>
                  <td data-label="Quantity" className="phs-num">
                    {packUnits(l.qty_units, l)}
                    <span className="phs-meta">
                      {l.qty_units} {l.unit_label}
                    </span>
                  </td>
                  <td className="phb-line-acts">
                    <button
                      type="button"
                      className="flow-btn flow-btn-ghost"
                      disabled={disabled}
                      onClick={() => open(l.medicine_id)}
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      className="flow-btn flow-btn-ghost"
                      aria-label={`Remove ${l.medicine_name} batch ${l.batch_no}`}
                      disabled={disabled}
                      onClick={() => onChange(lines.filter((x) => x.batch_id !== l.batch_id))}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="phs-empty">No medicines yet. Search above to add the first one.</p>
      )}
      {picking ? (
        <BatchPickerDialog
          medicine={picking.medicine}
          current={current}
          warnDays={picking.warnDays}
          applyLabel="Add"
          removeLabel="Remove"
          onApply={apply}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
