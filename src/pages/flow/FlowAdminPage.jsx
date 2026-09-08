import { useMemo, useState } from "react";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";
import {
  useFlowVisitTypes,
  useFlowStepCatalog,
  useFlowEditVisitType,
  useFlowCreateVisitType,
  useFlowDeleteVisitType,
  useFlowEditCatalog,
  useFlowCreateCatalogStep,
  useFlowDeleteCatalogStep,
} from "../../queries/hooks/useFlow";
import JourneyTemplateEditor from "../../components/flow/JourneyTemplateEditor";
import "../../styles/flow.css";
import "./FlowSettings.css";

// Admin settings: edit visit-time benchmarks (max minutes) and fully manage the
// step catalog (create / update / delete). Inline-edit on blur. ADMIN-gated
// (route cap + backend requireCapability).
//
// Renders as the Patient Flow panel of /settings — the shell there prints the
// title and blurb, so this owns only its own controls. .flow-root stays: the
// cards and tables below read their palette off its variables.
export default function FlowAdminPage() {
  const { data: types = [] } = useFlowVisitTypes(true);
  const { data: catalog = [] } = useFlowStepCatalog(true);
  const editType = useFlowEditVisitType();
  const createType = useFlowCreateVisitType();
  const deleteType = useFlowDeleteVisitType();
  const editStep = useFlowEditCatalog();
  const createStep = useFlowCreateCatalogStep();
  const deleteStep = useFlowDeleteCatalogStep();

  // "+ Add visit type" form for the benchmarks table.
  const [newType, setNewType] = useState({ label: "", min: "" });
  // Visit type pending delete-confirmation (drives its ConfirmModal).
  const [deleteTypeTarget, setDeleteTypeTarget] = useState(null);
  // "+ Add step" form for the catalog.
  const [newStep, setNewStep] = useState({ name: "", min: "", station: "", role: "" });
  // Catalog step pending delete-confirmation (drives ConfirmModal).
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Distinct stations / roles already in the catalog — for the add-step dropdowns.
  const stationOptions = useMemo(
    () => [...new Set(catalog.map((c) => c.station).filter(Boolean))].sort(),
    [catalog],
  );
  const roleOptions = useMemo(
    () => [...new Set(catalog.map((c) => c.assigned_role).filter(Boolean))].sort(),
    [catalog],
  );

  const saveType = async (id, patch, okMsg) => {
    try {
      await editType.mutateAsync({ id, ...patch });
      toast(okMsg, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const addType = async () => {
    const label = newType.label.trim();
    const min = parseInt(newType.min);
    if (!label) return toast("Visit type needs a name", "error");
    if (!(min >= 1)) return toast("Enter a max time in minutes", "error");
    try {
      await createType.mutateAsync({ label, max_time_min: min });
      setNewType({ label: "", min: "" });
      toast(`Added “${label}”`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const confirmDeleteType = async () => {
    const t = deleteTypeTarget;
    if (!t) return;
    try {
      await deleteType.mutateAsync(t.id);
      toast(`Deleted “${t.label}”`, "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setDeleteTypeTarget(null);
    }
  };
  const saveStep = async (id, patch, okMsg) => {
    try {
      await editStep.mutateAsync({ id, ...patch });
      toast(okMsg, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const addStep = async () => {
    const name = newStep.name.trim();
    const min = parseInt(newStep.min);
    if (!name) return toast("Step needs a name", "error");
    if (!(min >= 0)) return toast("Enter a default time in minutes", "error");
    try {
      await createStep.mutateAsync({
        name,
        default_duration_min: min,
        station: newStep.station.trim(),
        assigned_role: newStep.role.trim() || "flow_coordinator",
      });
      setNewStep({ name: "", min: "", station: "", role: "" });
      toast(`Added step “${name}”`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const confirmDeleteStep = async () => {
    const c = deleteTarget;
    if (!c) return;
    try {
      await deleteStep.mutateAsync(c.id);
      toast(`Deleted “${c.name}”`, "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flow-root fset">
      <div className="flow-wrap">
        <div className="fset__grid">
          {/* Benchmarks — add / edit / delete */}
          <div className="flow-card">
            <div className="fset__cardhead">
              <div className="flow-sec-title">Visit-time benchmarks</div>
              <span className="fset__count">{types.length}</span>
            </div>
            <div className="fset__cardsub">
              How long each kind of visit should take. The board times a patient against the
              benchmark for their type.
            </div>
            <div className="fset__scroll">
              <table className="flow-table" style={{ border: "none" }}>
                <thead>
                  <tr>
                    <th>Visit type</th>
                    <th style={{ width: 90 }}>Max (min)</th>
                    <th style={{ width: 60 }}>Active</th>
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id} className={t.is_active === false ? "fset__row--off" : undefined}>
                      <td>
                        <input
                          className="jb-assign"
                          style={{ maxWidth: "none", fontWeight: 700 }}
                          defaultValue={t.label}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== t.label) saveType(t.id, { label: v }, "Saved");
                          }}
                        />
                        <div className="flow-muted">{t.id}</div>
                      </td>
                      <td>
                        <input
                          className="jb-dur"
                          type="number"
                          min="1"
                          defaultValue={t.max_time_min}
                          onBlur={(e) => {
                            const v = parseInt(e.target.value);
                            if (v && v !== t.max_time_min)
                              saveType(t.id, { max_time_min: v }, `${t.label} → ${v} min`);
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={t.is_active !== false}
                          title="Offer this visit type at check-in"
                          onChange={(e) =>
                            saveType(
                              t.id,
                              { is_active: e.target.checked },
                              e.target.checked
                                ? `${t.label} is selectable again`
                                : `${t.label} switched off — visits already on it keep running`,
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          className="jb-remove"
                          title="Delete visit type"
                          disabled={deleteType.isPending}
                          onClick={() => setDeleteTypeTarget(t)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add a new visit type */}
            <div className="fset__add">
              <div className="fset__addtitle">Add visit type</div>
              <div className="fset__addrow">
                <input
                  className="jb-assign"
                  style={{ maxWidth: "none", flex: "2 1 150px" }}
                  placeholder="Visit type name"
                  value={newType.label}
                  onChange={(e) => setNewType((n) => ({ ...n, label: e.target.value }))}
                />
                <input
                  className="jb-dur"
                  type="number"
                  min="1"
                  placeholder="max min"
                  value={newType.min}
                  onChange={(e) => setNewType((n) => ({ ...n, min: e.target.value }))}
                />
                <button
                  className="flow-btn flow-btn-primary"
                  disabled={createType.isPending}
                  onClick={addType}
                >
                  + Add
                </button>
              </div>
              <div className="fset__hint">
                New types get a code from the name. Build its journey in the journey builder before
                check-ins can use it. Built-in types can’t be deleted (they’re in use).
              </div>
            </div>
          </div>

          {/* Step catalog — add / edit / delete */}
          <div className="flow-card">
            <div className="fset__cardhead">
              <div className="flow-sec-title">Step catalog</div>
              <span className="fset__count">{catalog.length}</span>
            </div>
            <div className="fset__cardsub">
              Every stop that can appear in a journey. Switching one off keeps it out of new
              journeys without disturbing visits already running.
            </div>
            <div className="fset__scroll">
              <table className="flow-table" style={{ border: "none" }}>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th style={{ width: 80 }}>Default min</th>
                    <th style={{ width: 60 }}>Active</th>
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((c) => (
                    <tr key={c.id} className={c.is_active ? undefined : "fset__row--off"}>
                      <td>
                        <b>{c.name}</b>
                        <div className="flow-muted">
                          {c.station} · {c.assigned_role}
                        </div>
                      </td>
                      <td>
                        <input
                          className="jb-dur"
                          type="number"
                          min="0"
                          defaultValue={c.default_duration_min}
                          onBlur={(e) => {
                            const v = parseInt(e.target.value);
                            if (Number.isInteger(v) && v !== c.default_duration_min)
                              saveStep(c.id, { default_duration_min: v }, `${c.name} → ${v} min`);
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          defaultChecked={c.is_active}
                          onChange={(e) => saveStep(c.id, { is_active: e.target.checked }, "Saved")}
                        />
                      </td>
                      <td>
                        <button
                          className="jb-remove"
                          title="Delete step"
                          disabled={deleteStep.isPending}
                          onClick={() => setDeleteTarget(c)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add a new step */}
            <div className="fset__add">
              <div className="fset__addtitle">Add step</div>
              <div className="fset__addrow">
                <input
                  className="jb-assign"
                  style={{ maxWidth: "none", flex: "2 1 150px" }}
                  placeholder="Step name"
                  value={newStep.name}
                  onChange={(e) => setNewStep((n) => ({ ...n, name: e.target.value }))}
                />
                {/* Combo-box: pick an existing station or type a new one. */}
                <input
                  className="jb-assign"
                  list="flow-station-options"
                  placeholder="Station"
                  value={newStep.station}
                  onChange={(e) => setNewStep((n) => ({ ...n, station: e.target.value }))}
                />
                <datalist id="flow-station-options">
                  {stationOptions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                {/* Combo-box: pick an existing role or type a new one. */}
                <input
                  className="jb-assign"
                  list="flow-role-options"
                  placeholder="Role"
                  value={newStep.role}
                  onChange={(e) => setNewStep((n) => ({ ...n, role: e.target.value }))}
                />
                <datalist id="flow-role-options">
                  {roleOptions.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                <input
                  className="jb-dur"
                  type="number"
                  min="0"
                  placeholder="min"
                  value={newStep.min}
                  onChange={(e) => setNewStep((n) => ({ ...n, min: e.target.value }))}
                />
                <button
                  className="flow-btn flow-btn-primary"
                  disabled={createStep.isPending}
                  onClick={addStep}
                >
                  + Add
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Full width, under the two half-width cards: a journey is a long row. */}
        <JourneyTemplateEditor types={types} />
      </div>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete step?"
        message={
          deleteTarget
            ? `Delete “${deleteTarget.name}” from the step catalog? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={confirmDeleteStep}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmModal
        open={!!deleteTypeTarget}
        title="Delete visit type?"
        message={
          deleteTypeTarget
            ? `Delete “${deleteTypeTarget.label}” benchmark? This cannot be undone. Types in use by a journey or patient visit cannot be deleted.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={confirmDeleteType}
        onCancel={() => setDeleteTypeTarget(null)}
      />
    </div>
  );
}
