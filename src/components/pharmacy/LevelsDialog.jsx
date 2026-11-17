import { useEffect, useState } from "react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { requestErrorOf } from "../billing/format";
import Pagination from "../ui/Pagination";
import MedicinePicker from "./MedicinePicker";
import { toast } from "../../stores/uiStore";
import {
  useLocationLevels,
  useRemoveLevel,
  useSaveLevel,
} from "../../queries/hooks/usePharmacyLocations";
import { splitUnits } from "../../../shared/pharmacyVocab";

const WHOLE = /^\d{1,9}$/;
const digits = (v) => v.replace(/\D/g, "");

function levelProblem(min, max) {
  if (!WHOLE.test(min)) return "Enter the minimum as a whole number.";
  if (max && (!WHOLE.test(max) || Number(max) < 1))
    return "Enter the maximum as a whole number above 0.";
  if (max && Number(max) < Number(min)) return "The maximum cannot be less than the minimum.";
  return null;
}

const inPacks = (units, m) => {
  if (!WHOLE.test(String(units ?? ""))) return null;
  const { packs, loose } = splitUnits(Number(units), m.pack_size);
  return `${packs} ${m.pack_label}${loose ? ` + ${loose} ${m.unit_label}` : ""}`;
};

function LevelRow({ level, locationId }) {
  const [min, setMin] = useState(String(level.min_units));
  const [max, setMax] = useState(level.max_units === null ? "" : String(level.max_units));
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useSaveLevel();
  const remove = useRemoveLevel();
  const changed = min !== String(level.min_units) || max !== String(level.max_units ?? "");
  const minId = `lvl-min-${level.medicine_id}`;
  const maxId = `lvl-max-${level.medicine_id}`;

  const onSave = async () => {
    const problem = levelProblem(min, max);
    setError(problem ?? "");
    if (problem) return;
    try {
      await save.mutateAsync({
        locationId,
        medicineId: level.medicine_id,
        min_units: Number(min),
        max_units: max ? Number(max) : null,
      });
      toast(`Stock level for ${level.name} saved.`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the stock level"));
    }
  };

  const onRemove = async () => {
    try {
      await remove.mutateAsync({ locationId, medicineId: level.medicine_id });
      toast(`${level.name} removed from this department's stock levels.`);
    } catch (err) {
      setConfirmRemove(false);
      setError(requestErrorOf(err, "Could not remove the stock level"));
    }
  };

  return (
    <tr>
      <td data-label="Medicine">
        <span className="phs-item">{level.name}</span>
        <span className="phs-meta">
          {level.code} · {level.pack_label} of {level.pack_size} {level.unit_label}
        </span>
        {error ? (
          <span className="form-field__error lvl-error" role="alert">
            {error}
          </span>
        ) : null}
      </td>
      <td data-label="Minimum">
        <label className="sr-only" htmlFor={minId}>
          Minimum stock of {level.name} ({level.unit_label})
        </label>
        <input
          id={minId}
          className="jb-assign lvl-input"
          inputMode="numeric"
          maxLength={9}
          value={min}
          onChange={(e) => setMin(digits(e.target.value))}
        />
        <span className="phs-meta">{inPacks(min, level)}</span>
      </td>
      <td data-label="Maximum">
        <label className="sr-only" htmlFor={maxId}>
          Maximum stock of {level.name} ({level.unit_label})
        </label>
        <input
          id={maxId}
          className="jb-assign lvl-input"
          inputMode="numeric"
          maxLength={9}
          placeholder="No limit"
          value={max}
          onChange={(e) => setMax(digits(e.target.value))}
        />
        <span className="phs-meta">{max ? inPacks(max, level) : null}</span>
      </td>
      <td data-label="Actions" className="phv-actions">
        {confirmRemove ? (
          <span role="group" aria-label={`Remove ${level.name}?`} className="lvl-confirm">
            <span>Remove?</span>
            <button
              type="button"
              className="flow-btn flow-btn-red flow-btn-mini"
              disabled={remove.isPending}
              onClick={onRemove}
            >
              {remove.isPending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setConfirmRemove(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-primary flow-btn-mini"
              disabled={!changed || save.isPending}
              onClick={onSave}
              aria-label={`Save stock level for ${level.name}`}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setConfirmRemove(true)}
              aria-label={`Remove ${level.name}`}
            >
              Remove
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function AddLevel({ locationId, existingIds }) {
  const [medicine, setMedicine] = useState(null);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [error, setError] = useState("");
  const save = useSaveLevel();

  const onAdd = async (e) => {
    e.preventDefault();
    if (!medicine) {
      setError("Choose a medicine first.");
      return;
    }
    const problem = levelProblem(min, max);
    setError(problem ?? "");
    if (problem) return;
    try {
      await save.mutateAsync({
        locationId,
        medicineId: medicine.id,
        min_units: Number(min),
        max_units: max ? Number(max) : null,
      });
      toast(`${medicine.name} added to this department's stock levels.`);
      setMedicine(null);
      setMin("");
      setMax("");
    } catch (err) {
      setError(requestErrorOf(err, "Could not add the stock level"));
    }
  };

  return (
    <form className="lvl-add" onSubmit={onAdd} noValidate aria-label="Add a stock level">
      {medicine ? (
        <div className="lvl-chosen">
          <span className="mpick__label">Medicine</span>
          <span className="phs-item">{medicine.name}</span>
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            onClick={() => setMedicine(null)}
          >
            Change
          </button>
        </div>
      ) : (
        <MedicinePicker label="Medicine" onSelect={setMedicine} excludeIds={existingIds} />
      )}
      <div className="fset__field">
        <label htmlFor="lvl-add-min">Minimum ({medicine?.unit_label ?? "units"})</label>
        <input
          id="lvl-add-min"
          className="jb-assign"
          inputMode="numeric"
          maxLength={9}
          value={min}
          onChange={(e) => setMin(digits(e.target.value))}
        />
      </div>
      <div className="fset__field">
        <label htmlFor="lvl-add-max">Maximum ({medicine?.unit_label ?? "units"})</label>
        <input
          id="lvl-add-max"
          className="jb-assign"
          inputMode="numeric"
          maxLength={9}
          placeholder="No limit"
          value={max}
          onChange={(e) => setMax(digits(e.target.value))}
        />
      </div>
      <button type="submit" className="flow-btn flow-btn-primary" disabled={save.isPending}>
        {save.isPending ? "Adding…" : "Add level"}
      </button>
      {error ? (
        <p className="bill-dialog__error lvl-add__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export default function LevelsDialog({ location, onClose }) {
  const ref = useDialog(true, onClose);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const levels = useLocationLevels(location.id, {
    ...(q ? { q } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = levels.data?.rows ?? [];

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <div
          ref={ref}
          className="flow-card bill-dialog bill-dialog--wide phv-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lvl-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="lvl-title" className="bill-dialog__title">
            Stock levels · {location.name}
          </h2>
          <p className="flow-muted">
            Set the minimum and maximum stock {location.name} should hold. When stock drops below
            the minimum, the pharmacy admin is alerted to restock it from the main pharmacy.
          </p>

          <AddLevel locationId={location.id} existingIds={rows.map((r) => r.medicine_id)} />

          <div className="phs-filters lvl-search">
            <label className="sr-only" htmlFor="lvl-search">
              Search stock levels
            </label>
            <input
              id="lvl-search"
              type="search"
              className="jb-assign phs-search"
              placeholder="Search this department's medicines by name or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {levels.isError ? (
            <div className="phs-empty" role="alert">
              <p>Unable to load the stock levels.</p>
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                onClick={() => levels.refetch()}
              >
                Try again
              </button>
            </div>
          ) : levels.isLoading ? (
            <p className="phs-empty" role="status">
              Loading stock levels…
            </p>
          ) : !rows.length ? (
            <p className="phs-empty">
              {q
                ? "No medicines in this department match your search."
                : "No stock levels set yet. Add the medicines this department keeps."}
            </p>
          ) : (
            <>
              <div className="fset__scroll">
                <table
                  className="flow-table phs-table"
                  aria-label={`Stock levels for ${location.name}`}
                >
                  <thead>
                    <tr>
                      <th>Medicine</th>
                      <th>Minimum</th>
                      <th>Maximum</th>
                      <th className="phv-actions-head">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((level) => (
                      <LevelRow
                        key={`${level.medicine_id}:${level.updated_at}`}
                        level={level}
                        locationId={location.id}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={levels.data?.total ?? 0}
                onChange={setPage}
                disabled={levels.isFetching}
                unit="medicines"
              />
            </>
          )}

          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </BillDialogLayer>
  );
}
