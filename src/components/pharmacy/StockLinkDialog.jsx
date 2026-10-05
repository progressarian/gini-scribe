import { useState } from "react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { requestErrorOf } from "../billing/format";
import { toast } from "../../stores/uiStore";
import {
  useAddStockLink,
  useRemoveStockLink,
  useStockLinks,
} from "../../queries/hooks/usePharmacyStock";

const LINK_LABEL = {
  identity: "Same as stock name",
  auto: "Matched automatically",
  confirmed: "Confirmed",
};

export default function StockLinkDialog({ itemKey, onClose }) {
  const ref = useDialog(Boolean(itemKey), onClose);
  const { data, isLoading, isError } = useStockLinks(itemKey);
  const add = useAddStockLink();
  const remove = useRemoveStockLink();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const busy = add.isPending || remove.isPending;

  if (!itemKey) return null;

  const link = async (medicineName) => {
    setError("");
    try {
      await add.mutateAsync({ itemKey, medicineName });
      setTyped("");
      toast(`Linked ${medicineName}`);
    } catch (e) {
      setError(requestErrorOf(e, "Could not link the medicine"));
    }
  };

  const unlink = async (medicineKey) => {
    setError("");
    try {
      await remove.mutateAsync({ itemKey, medicineKey });
      toast(`Removed ${medicineKey}`);
    } catch (e) {
      setError(requestErrorOf(e, "Could not remove the link"));
    }
  };

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <div
          ref={ref}
          className="flow-card bill-dialog phs-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="phs-link-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="phs-link-title" className="bill-dialog__title">
            Prescription names for this stock item
          </h2>
          <p className="phs-dialog__item">{data?.itemName ?? itemKey}</p>
          <p className="flow-muted">
            A prescription shows this item's stock when its medicine name matches one of these.
          </p>

          {isError ? (
            <p className="bill-dialog__error" role="alert">
              Could not load the links. Close and try again.
            </p>
          ) : isLoading ? (
            <p className="flow-muted" role="status">
              Loading…
            </p>
          ) : (
            <>
              <h3 className="phs-dialog__sub">Linked</h3>
              {data.links.length ? (
                <ul className="phs-dialog__list">
                  {data.links.map((l) => (
                    <li key={l.medicineKey}>
                      <span className="phs-dialog__name">{l.medicineKey}</span>
                      <span className="phs-dialog__meta">
                        {LINK_LABEL[l.status] ?? "Confirmed"}
                        {l.status === "confirmed" && l.createdBy ? ` by ${l.createdBy}` : ""}
                      </span>
                      <button
                        type="button"
                        className="flow-btn flow-btn-ghost flow-btn-mini"
                        disabled={busy}
                        onClick={() => unlink(l.medicineKey)}
                        aria-label={`Remove link ${l.medicineKey}`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flow-muted">
                  Not linked — prescriptions will show "Stock —" for this item.
                </p>
              )}

              {data.suggestions.length ? (
                <>
                  <h3 className="phs-dialog__sub">Suggested</h3>
                  <ul className="phs-dialog__list">
                    {data.suggestions.map((s) => (
                      <li key={s.medicineKey}>
                        <span className="phs-dialog__name">{s.name}</span>
                        <span className="phs-dialog__meta">Needs review</span>
                        <button
                          type="button"
                          className="flow-btn flow-btn-primary flow-btn-mini"
                          disabled={busy}
                          onClick={() => link(s.name)}
                          aria-label={`Confirm ${s.name}`}
                        >
                          Confirm
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              <form
                className="phs-dialog__add fset__field"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed.trim().length >= 2) link(typed.trim());
                }}
              >
                <label htmlFor="phs-link-name">Add a prescription name</label>
                <div className="phs-dialog__row">
                  <input
                    id="phs-link-name"
                    className="jb-assign"
                    value={typed}
                    maxLength={200}
                    placeholder="As written on prescriptions, e.g. Atchol 20"
                    onChange={(e) => setTyped(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="flow-btn flow-btn-ghost"
                    disabled={busy || typed.trim().length < 2}
                  >
                    {add.isPending ? "Linking…" : "Link"}
                  </button>
                </div>
              </form>
            </>
          )}

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </BillDialogLayer>
  );
}
