import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../../queries/keys";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";
import {
  useFlowVisitTypes,
  useFlowStepCatalog,
  useFlowEditVisitType,
  useFlowEditCatalog,
  useFlowCreateCatalogStep,
  useFlowDeleteCatalogStep,
} from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// Admin settings: edit visit-time benchmarks (max minutes) and fully manage the
// step catalog (create / update / delete). Inline-edit on blur. ADMIN-gated
// (route cap + backend requireCapability).
export default function FlowAdminPage() {
  const { data: types = [] } = useFlowVisitTypes();
  const { data: catalog = [] } = useFlowStepCatalog(true);
  const editType = useFlowEditVisitType();
  const editStep = useFlowEditCatalog();
  const createStep = useFlowCreateCatalogStep();
  const deleteStep = useFlowDeleteCatalogStep();

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

  const qc = useQueryClient();
  const [demoBusy, setDemoBusy] = useState(false);
  const runDemo = async (action) => {
    setDemoBusy(true);
    try {
      const { data } = await api.post(`/api/flow/demo/${action}`);
      qc.invalidateQueries({ queryKey: qk.flow.all });
      toast(
        action === "seed"
          ? `Seeded ${data.count} demo patients — open Flow Coordinator`
          : `Cleared ${data.removed} demo patients`,
        "success",
      );
    } catch (e) {
      toast(e?.response?.data?.error || "Demo action failed", "error");
    } finally {
      setDemoBusy(false);
    }
  };

  const saveType = async (id, patch, okMsg) => {
    try {
      await editType.mutateAsync({ id, ...patch });
      toast(okMsg, "success");
    } catch (e) {
      toast(e.message, "error");
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
    <div className="flow-root">
      <div className="flow-wrap">
        <div className="flow-header">
          <div>
            <div className="flow-title">⚙️ Flow Settings</div>
            <div className="flow-sub">
              Edit visit-time benchmarks and manage journey steps · changes apply to new check-ins
            </div>
          </div>
        </div>

        {/* Demo data — for testing the dashboard/queues without real check-ins */}
        <div
          className="flow-card"
          style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>🌱 Demo data (testing)</div>
            <div className="flow-muted">
              Seeds ~8 sample patients across stations (VIP, breach, with-SD, with-Chief, live lab
              queue, completed) so you can try the Coordinator, stations and lab queue. All are
              labelled DEMO and removed by “Clear demo”.
            </div>
          </div>
          <button
            className="flow-btn flow-btn-primary"
            disabled={demoBusy}
            onClick={() => runDemo("seed")}
          >
            🌱 Seed demo
          </button>
          <button
            className="flow-btn flow-btn-ghost"
            disabled={demoBusy}
            onClick={() => runDemo("clean")}
          >
            🧹 Clear demo
          </button>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}
        >
          {/* Benchmarks */}
          <div className="flow-card">
            <div className="flow-sec-title">Visit-time benchmarks</div>
            <table className="flow-table" style={{ border: "none" }}>
              <thead>
                <tr>
                  <th>Visit type</th>
                  <th style={{ width: 90 }}>Max (min)</th>
                  <th style={{ width: 70 }}>Flexible</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.label}</b>
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
                        defaultChecked={t.is_flexible}
                        onChange={(e) => saveType(t.id, { is_flexible: e.target.checked }, "Saved")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Step catalog — add / edit / delete */}
          <div className="flow-card">
            <div className="flow-sec-title">Step catalog</div>
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
                  <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.5 }}>
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

            {/* Add a new step */}
            <div style={{ marginTop: 10 }}>
              <div className="flow-sec-title" style={{ fontSize: 10 }}>
                Add step
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
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
    </div>
  );
}
