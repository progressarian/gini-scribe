import { useState } from "react";
import { toast } from "../../stores/uiStore";
import { useFlowMachineOptions, useFlowSaveMachine } from "../../queries/hooks/useFlow";

const listText = (list) => (list || []).join(", ");
const toList = (text) =>
  String(text || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

const formFor = (step) => ({
  shortName: step.machine_short_name || step.name,
  fullName: step.machine_full_name || "",
  icon: step.machine_icon || "",
  orderTestName: step.order_test_name || "",
  billNames: listText(step.bill_names),
  valueFields: listText(step.value_fields),
  reportTypes: step.report_doc_types || [],
  handsOver: !!step.hands_over,
  order: step.machine_order ?? "",
});

export default function MachineSettings({ step, onClose }) {
  const { data: options, isLoading } = useFlowMachineOptions();
  const save = useFlowSaveMachine();
  const [form, setForm] = useState(() => formFor(step));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (machine) => {
    try {
      await save.mutateAsync({
        id: step.id,
        machine,
        machine_short_name: form.shortName,
        machine_full_name: form.fullName,
        machine_icon: form.icon,
        order_test_name: form.orderTestName,
        bill_names: toList(form.billNames),
        value_fields: toList(form.valueFields),
        report_doc_types: form.reportTypes,
        hands_over: form.handsOver,
        machine_order: form.order === "" ? null : Number(form.order),
      });
      toast(
        machine
          ? `${form.shortName || step.name} saved as a machine test`
          : `${step.name} is no longer a machine test`,
        "success",
      );
      onClose();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  if (isLoading) return <div className="fset__hint">Loading machine options…</div>;

  return (
    <form
      className="fset__machine"
      onSubmit={(e) => {
        e.preventDefault();
        submit(true);
      }}
    >
      <div className="fset__machine-grid">
        <label className="fset__field">
          <span>Short name</span>
          <input
            className="jb-assign"
            value={form.shortName}
            onChange={(e) => set({ shortName: e.target.value })}
          />
        </label>
        <label className="fset__field">
          <span>Full name</span>
          <input
            className="jb-assign"
            placeholder="e.g. Treadmill test"
            value={form.fullName}
            onChange={(e) => set({ fullName: e.target.value })}
          />
        </label>
        <label className="fset__field fset__field--narrow">
          <span>Icon</span>
          <input
            className="jb-assign"
            placeholder="🩺"
            value={form.icon}
            onChange={(e) => set({ icon: e.target.value })}
          />
        </label>
        <label className="fset__field fset__field--narrow">
          <span>Tab order</span>
          <input
            className="jb-dur"
            type="number"
            min="1"
            value={form.order}
            onChange={(e) => set({ order: e.target.value })}
          />
        </label>
      </div>

      <label className="fset__field">
        <span>Bills against (price)</span>
        <select
          className="jb-assign"
          value={form.orderTestName}
          onChange={(e) => set({ orderTestName: e.target.value })}
        >
          <option value="">Pick a machine test from the test catalogue</option>
          {(options?.tests || []).map((t) => (
            <option key={t.testName} value={t.testName}>
              {t.testName} · ₹{t.price}
            </option>
          ))}
        </select>
      </label>

      <label className="fset__field">
        <span>Names on the HealthRay bill</span>
        <input
          className="jb-assign"
          placeholder="e.g. 2D Echo, Echo, Echocardiography"
          value={form.billNames}
          onChange={(e) => set({ billNames: e.target.value })}
        />
        <small>Comma-separated. A bill line with any of these names raises this test.</small>
      </label>

      <label className="fset__field">
        <span>Value fields</span>
        <input
          className="jb-assign"
          placeholder="e.g. Ejection Fraction, Echo Finding"
          value={form.valueFields}
          onChange={(e) => set({ valueFields: e.target.value })}
        />
        <small>Comma-separated. The rows the technician fills in on the Machine Room screen.</small>
      </label>

      <fieldset className="fset__field">
        <span>Report types</span>
        <div className="fset__checks">
          {(options?.reportTypes || []).map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={form.reportTypes.includes(type)}
                onChange={(e) =>
                  set({
                    reportTypes: e.target.checked
                      ? [...form.reportTypes, type]
                      : form.reportTypes.filter((t) => t !== type),
                  })
                }
              />
              {type}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="fset__check">
        <input
          type="checkbox"
          checked={form.handsOver}
          onChange={(e) => set({ handsOver: e.target.checked })}
        />
        No report needed — the result goes home with the patient (like ECG)
      </label>

      <div className="fset__addrow">
        <button className="flow-btn flow-btn-primary" type="submit" disabled={save.isPending}>
          {step.machine ? "Save machine" : "Make this a machine test"}
        </button>
        {step.machine && (
          <button
            className="flow-btn"
            type="button"
            disabled={save.isPending}
            onClick={() => submit(false)}
          >
            Stop being a machine test
          </button>
        )}
        <button className="flow-btn" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
