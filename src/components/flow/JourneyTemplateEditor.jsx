import { useEffect, useState } from "react";
import { toast } from "../../stores/uiStore";
import ConfirmModal from "../ui/ConfirmModal.jsx";
import { CONDITIONS } from "../../../shared/giniflowConditions.js";
import {
  useFlowTemplate,
  useFlowStepCatalog,
  useFlowSaveTemplate,
} from "../../queries/hooks/useFlow";

// The default journey each visit type starts from — the thing reception is shown
// at check-in before they adjust it for the patient in front of them.
//
// These templates were seeded by 2026-06-15_flow_management.sql and, until now,
// could only be changed with SQL. That is also why a visit type created from the
// panel above has no journey at all: the "build its journey" the hint promises
// had nowhere to happen.
//
// "When" sets condition_key, which reception now answers at check-in: a step
// marked "Only if tests" is added to the journey when the desk ticks "Having
// tests today?" and left out when they do not. The vocabulary is shared with
// that screen so the two cannot drift.
//
// There was an "Optional" checkbox here until 2026-09-12. Its tooltip promised
// reception would add the step by hand, but no screen ever offered one back —
// is_optional only ever removed the step from the seeded journey, the same job
// "When" does with a question attached. It was set on 0 of 70 template rows
// across all six visit types, so nothing was carrying it.
//
// Background rows — the lab pipeline, the report desk, the MO's prescription
// slot — are filtered out here. They are machine-managed and nobody edits them,
// so listing them only padded the table and made the estimate meaningless (the
// lab's own 45- and 80-minute stages ran the total to 285 min against a 120 min
// benchmark). The PUT endpoint reads them before it rewrites and lays them back
// down behind the same step they followed, so leaving them out of this payload
// does not delete them.

const fromApi = (rows) =>
  rows
    .filter((r) => !r.is_background)
    .map((r) => ({
      step_catalog_id: r.step_catalog_id,
      name: r.step_name,
      station: r.station,
      role: r.assigned_role,
      is_default: r.is_default !== false,
      condition_key: r.condition_key || "",
      override_duration_min: r.override_duration_min ?? "",
      planned: r.planned_duration_min,
    }));

const serialize = (steps) =>
  JSON.stringify(
    steps.map((s) => [
      s.step_catalog_id,
      s.is_default,
      s.condition_key,
      String(s.override_duration_min ?? ""),
    ]),
  );

export default function JourneyTemplateEditor({ types }) {
  const [visitTypeId, setVisitTypeId] = useState(null);
  const active = visitTypeId || types[0]?.id || null;

  const { data: rows, isLoading } = useFlowTemplate(active);
  const { data: catalog = [] } = useFlowStepCatalog();
  const saveTemplate = useFlowSaveTemplate();

  const [steps, setSteps] = useState([]);
  const [baseline, setBaseline] = useState("[]");
  // The visit type a click asked for while the current one had unsaved edits.
  // window.confirm() put a "localhost:3000 says" chrome dialog on screen, which
  // is both out of place and unstyleable; ConfirmModal is what the rest of the
  // page already uses for the same question.
  const [pendingType, setPendingType] = useState(null);

  useEffect(() => {
    if (!rows) return;
    const next = fromApi(rows);
    setSteps(next);
    setBaseline(serialize(next));
  }, [rows, active]);

  const dirty = serialize(steps) !== baseline;

  // The Min box shows the time the step is actually planned for, never an empty
  // field: an admin reading the journey wants the number the floor is measured
  // against, and a blank box with a grey placeholder read as "no time set".
  //
  // Blank still MEANS "inherit from the catalogue", so a value equal to the
  // catalogue default is stored as blank rather than frozen as an override.
  // Without that, opening this screen and saving would stamp a private copy of
  // every duration onto the journey, and a later edit to the Step catalog would
  // stop reaching it.
  const catalogDefault = (step) => {
    const c = catalog.find((x) => x.id === step.step_catalog_id);
    return c?.default_duration_min ?? step.planned ?? "";
  };

  const setDuration = (i, step, raw) =>
    replace(i, {
      override_duration_min: raw !== "" && Number(raw) === Number(catalogDefault(step)) ? "" : raw,
    });

  const replace = (i, patch) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const move = (i, by) => {
    const to = i + by;
    if (to < 0 || to >= steps.length) return;
    setSteps((prev) => {
      const next = [...prev];
      [next[i], next[to]] = [next[to], next[i]];
      return next;
    });
  };

  const add = (catalogId) => {
    const c = catalog.find((x) => x.id === catalogId);
    if (!c) return;
    if (steps.some((s) => s.step_catalog_id === c.id)) {
      return toast(`${c.name} is already in this journey`, "warn");
    }
    setSteps((prev) => [
      ...prev,
      {
        step_catalog_id: c.id,
        name: c.name,
        station: c.station,
        role: c.assigned_role,
        is_default: true,
        condition_key: "",
        override_duration_min: "",
        planned: c.default_duration_min,
      },
    ]);
  };

  const save = async () => {
    try {
      await saveTemplate.mutateAsync({
        visitTypeId: active,
        steps: steps.map((s) => ({
          step_catalog_id: s.step_catalog_id,
          is_default: s.is_default,
          condition_key: s.condition_key || null,
          override_duration_min:
            s.override_duration_min === "" ? null : Number(s.override_duration_min),
        })),
      });
      setBaseline(serialize(steps));
      toast(`Journey saved — applies to the next check-in`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const total = steps.reduce(
    (sum, s) => sum + (Number(s.override_duration_min) || Number(s.planned) || 0),
    0,
  );
  const activeType = types.find((t) => t.id === active);

  return (
    <div className="flow-card fset__journey">
      <div className="fset__cardhead">
        <div className="flow-sec-title">Default journey per visit type</div>
        {activeType && <span className="fset__count">{activeType.label}</span>}
      </div>
      <div className="fset__cardsub">
        What reception is offered at check-in for this visit type. They can still add or drop steps
        for an individual patient — this is only the starting point.
      </div>

      <div className="fset__types">
        {types.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`fset__type${t.id === active ? " on" : ""}${
              t.is_active === false ? " fset__type--off" : ""
            }`}
            title={t.is_active === false ? `${t.label} is switched off` : t.label}
            onClick={() => (dirty ? setPendingType(t) : setVisitTypeId(t.id))}
          >
            {t.label}
            <span className="fset__typemin">{t.max_time_min}m</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : (
        <>
          {steps.length === 0 && (
            <div className="empty-note">
              {activeType?.label} has no journey yet, so a check-in on it starts from an empty plan.
              Add the stops a patient makes, in order.
            </div>
          )}

          <div className="fset__scroll fset__scroll--wide">
            <table className="flow-table" style={{ border: "none" }}>
              <thead>
                <tr>
                  <th style={{ width: 52 }} />
                  <th>Step</th>
                  <th style={{ width: 80 }}>Min</th>
                  <th style={{ width: 150 }}>When</th>
                  <th style={{ width: 36 }} />
                </tr>
              </thead>
              <tbody>
                {steps.map((s, i) => (
                  <tr key={s.step_catalog_id}>
                    <td>
                      <span className="jb-move">
                        <button
                          type="button"
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          title="Move up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          disabled={i === steps.length - 1}
                          onClick={() => move(i, 1)}
                          title="Move down"
                        >
                          ▼
                        </button>
                      </span>
                    </td>
                    <td>
                      <div className="fset__stepname">
                        <span className="fset__ord">{i + 1}.</span> {s.name}
                      </div>
                      <div className="fset__stepmeta">
                        {s.station}
                        {s.role ? ` · ${s.role}` : ""}
                      </div>
                    </td>
                    <td>
                      <input
                        className="jb-dur"
                        type="number"
                        min="0"
                        value={
                          s.override_duration_min === ""
                            ? String(catalogDefault(s))
                            : s.override_duration_min
                        }
                        title={
                          s.override_duration_min === ""
                            ? `Catalogue default for this step (${catalogDefault(s)} min). Type a different number to override it here.`
                            : `Overridden for this visit type — the Step catalog says ${catalogDefault(s)} min`
                        }
                        onChange={(e) => setDuration(i, s, e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="jb-assign"
                        value={s.condition_key}
                        title="Add this step only when reception answers yes at check-in"
                        onChange={(e) => replace(i, { condition_key: e.target.value })}
                      >
                        <option value="">Always</option>
                        {CONDITIONS.map((c) => (
                          <option key={c.key} value={c.key}>
                            Only if {c.label.toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="jb-remove"
                        title="Remove from this journey"
                        onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fset__actions">
            <select className="jb-add" value="" onChange={(e) => add(e.target.value)}>
              <option value="">+ Add step</option>
              {catalog
                .filter((c) => !steps.some((s) => s.step_catalog_id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.default_duration_min}m)
                  </option>
                ))}
            </select>
            <button
              className="flow-btn flow-btn-primary"
              disabled={!dirty || saveTemplate.isPending}
              onClick={save}
            >
              {saveTemplate.isPending ? "Saving…" : "Save journey"}
            </button>
            {dirty && <span className="fset__dirty">Unsaved changes</span>}
            <span className="fset__total">
              {steps.length} step{steps.length === 1 ? "" : "s"} · Est. {total} min
              {activeType?.max_time_min ? ` · benchmark ${activeType.max_time_min} min` : ""}
            </span>
          </div>
        </>
      )}

      <ConfirmModal
        open={!!pendingType}
        variant="primary"
        title="Discard unsaved changes?"
        message={
          pendingType
            ? `Your edits to the ${activeType?.label || "current"} journey have not been saved. Switching to ${pendingType.label} will lose them.`
            : ""
        }
        confirmLabel="Discard and switch"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setVisitTypeId(pendingType.id);
          setPendingType(null);
        }}
        onCancel={() => setPendingType(null)}
      />
    </div>
  );
}
