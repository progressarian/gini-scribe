import { Fragment, useId, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import {
  ALL_AGES,
  MAX_RANGES,
  RANGE_GENDERS,
  daysFrom,
  rangeProblems,
  splitDays,
} from "../../../shared/labCatalogRules.js";
import ConfirmModal from "../../components/ui/ConfirmModal";
import FormulaBuilder from "./FormulaBuilder";
import { formulaSyntaxError } from "../../../shared/labFormula.js";
import useDebounced from "../../hooks/useDebounced";
import { requestErrorOf } from "../../components/billing/format";
import { toast } from "../../stores/uiStore";
import {
  useAddField,
  useCreateReport,
  useLabReportSearch,
  useLinkReport,
  useMoveField,
  useResultsAsFile,
  useSaveRanges,
  useRemoveField,
  useUnlinkReport,
  useUpdateField,
} from "../../queries/hooks/useLabCatalog";

export const EDIT_TYPES = [
  { value: "numeric", label: "Number" },
  { value: "text", label: "Text" },
  { value: "select", label: "Pick list" },
  { value: "group", label: "Heading" },
];

const ALL_TYPES = [
  ...EDIT_TYPES.slice(0, 1),
  { value: "calculated", label: "Calculated" },
  ...EDIT_TYPES.slice(1),
];

function ReportPicker({ test }) {
  const id = useId();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const search = useLabReportSearch(term, term.length >= 2);
  const link = useLinkReport();
  const choose = (report) =>
    link.mutate(
      { catalogId: test.id, reportId: report.id, expectedUpdatedAt: test.updatedAt },
      {
        onSuccess: () => toast(`${test.name} now uses ${report.name}`, "success"),
        onError: (e) => toast(requestErrorOf(e, "Could not link that report"), "error"),
      },
    );
  return (
    <section className="tdet__option" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="tdet__optitle">
        Link an existing report
      </h3>
      <p className="tdet__muted">
        Use one the lab already reports, e.g. one imported from HealthRay.
      </p>
      <label htmlFor={`${id}-q`} className="tdet__label">
        Search reports by name
      </label>
      <input
        id={`${id}-q`}
        type="search"
        className="jb-assign tdet__input"
        value={q}
        placeholder="e.g. Lipid, Thyroid, CBC"
        onChange={(e) => setQ(e.target.value)}
      />
      {term.length < 2 ? null : search.isLoading ? (
        <p className="tdet__muted">Searching…</p>
      ) : search.isError ? (
        <p className="tdet__issue" role="alert">
          Search failed — try again.
        </p>
      ) : !search.data.length ? (
        <p className="tdet__muted">No report matches “{term}”. Create a new one instead.</p>
      ) : (
        <ul className="tdet__picklist">
          {search.data.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.name}</strong>{" "}
                <span className="tdet__muted">
                  · {r.fields} field{r.fields === 1 ? "" : "s"}
                  {r.linkedTests.length ? ` · used by ${r.linkedTests.join(", ")}` : ""}
                </span>
              </div>
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                disabled={link.isPending}
                onClick={() => choose(r)}
                aria-label={`Link ${r.name} to ${test.name}`}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateReport({ test }) {
  const id = useId();
  const [name, setName] = useState(test.name);
  const create = useCreateReport();
  const [error, setError] = useState("");
  const submit = (e) => {
    e.preventDefault();
    setError("");
    create.mutate(
      { catalogId: test.id, name: name.trim(), expectedUpdatedAt: test.updatedAt },
      {
        onSuccess: () => toast(`Report ${name.trim()} created — add its fields below`, "success"),
        onError: (err) => setError(requestErrorOf(err, "Could not create the report")),
      },
    );
  };
  return (
    <form className="tdet__option" aria-labelledby={`${id}-title`} onSubmit={submit}>
      <h3 id={`${id}-title`} className="tdet__optitle">
        Create a new report
      </h3>
      <p className="tdet__muted">Start empty and add the fields this test reports.</p>
      <label htmlFor={`${id}-name`} className="tdet__label">
        Report name
      </label>
      <input
        id={`${id}-name`}
        className="jb-assign tdet__input"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-err` : undefined}
      />
      {error ? (
        <p id={`${id}-err`} className="tdet__issue" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className="flow-btn flow-btn-primary flow-btn-mini"
        disabled={name.trim().length < 2 || create.isPending}
      >
        {create.isPending ? "Creating…" : "Create report"}
      </button>
    </form>
  );
}

export function SetUpResults({ test, canEdit }) {
  const asFile = useResultsAsFile();
  const toggle = (value) =>
    asFile.mutate(
      { catalogId: test.id, value, expectedUpdatedAt: test.updatedAt },
      { onError: (e) => toast(requestErrorOf(e, "Could not save that"), "error") },
    );
  if (test.resultsAsFile) {
    return (
      <div className="tcat__empty">
        Results for this test arrive as a file (e.g. a printed report), so it has no result fields.
        {canEdit ? (
          <div className="tdet__actions">
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              disabled={asFile.isPending}
              onClick={() => toggle(false)}
            >
              Set up result fields instead
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <div className="tcat__empty">
        <strong>No result fields yet.</strong> This test is not linked to a result report, so the
        lab can only upload a file for it — values cannot be typed, flagged or trended.
      </div>
      {canEdit ? (
        <div className="tdet__setup">
          <ReportPicker test={test} />
          <CreateReport test={test} />
          <section className="tdet__option">
            <h3 className="tdet__optitle">Results come as a file</h3>
            <p className="tdet__muted">
              For ECG, X-ray, Echo and other reports that are only ever uploaded. The test stops
              counting as not set up.
            </p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              disabled={asFile.isPending}
              onClick={() => toggle(true)}
            >
              Mark as file only
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function ReportBar({ test, canEdit }) {
  const [confirming, setConfirming] = useState(false);
  const unlink = useUnlinkReport();
  const doUnlink = () =>
    unlink.mutate(
      { catalogId: test.id, expectedUpdatedAt: test.updatedAt },
      {
        onSuccess: () => {
          setConfirming(false);
          toast(`${test.report.name} unlinked from ${test.name}`, "success");
        },
      },
    );
  return (
    <div className="tdet__reportbar">
      <span>
        Result report: <strong>{test.report.name}</strong>
      </span>
      {canEdit ? (
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          onClick={() => setConfirming(true)}
        >
          Unlink…
        </button>
      ) : null}
      <ConfirmModal
        open={confirming}
        title={`Unlink ${test.report.name} from ${test.name}?`}
        message={
          <>
            The lab form for <strong>{test.name}</strong> will stop showing these{" "}
            {test.report.fields.length} fields, so the lab can only upload a file until another
            report is linked. The report and its fields are kept, and saved results do not change.
          </>
        }
        confirmLabel="Unlink report"
        busy={unlink.isPending}
        error={unlink.isError ? requestErrorOf(unlink.error, "Could not unlink") : null}
        onConfirm={doUnlink}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

export function RemoveFieldButton({ report, field }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useRemoveField();
  const shared = field.alsoIn?.length > 0;
  const doRemove = () =>
    remove.mutate(
      { reportId: report.id, fieldId: field.id, expectedUpdatedAt: field.updatedAt },
      {
        onSuccess: () => {
          setConfirming(false);
          toast(`${field.name} removed from ${report.name}`, "success");
        },
      },
    );
  return (
    <>
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        aria-label={`Remove ${field.name}`}
        onClick={() => {
          remove.reset();
          setConfirming(true);
        }}
      >
        Remove
      </button>
      <ConfirmModal
        open={confirming}
        title={`Remove ${field.name} from ${report.name}?`}
        message={
          <>
            The lab will no longer see <strong>{field.name}</strong> when entering {report.name}{" "}
            results.{" "}
            {shared
              ? `It stays in ${field.alsoIn.join(", ")}.`
              : "It is switched off, and the History tab keeps a record."}{" "}
            Results already saved do not change.
          </>
        }
        confirmLabel="Remove field"
        busy={remove.isPending}
        error={remove.isError ? requestErrorOf(remove.error, "Could not remove the field") : null}
        onConfirm={doRemove}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

export function MoveButtons({ report, field, first, last }) {
  const move = useMoveField();
  const go = (direction) =>
    move.mutate(
      { reportId: report.id, fieldId: field.id, direction },
      { onError: (e) => toast(requestErrorOf(e, "Could not move the field"), "error") },
    );
  return (
    <>
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini tdet__icon"
        disabled={first || move.isPending}
        aria-label={`Move ${field.name} up`}
        onClick={() => go("up")}
      >
        <ArrowUp size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini tdet__icon"
        disabled={last || move.isPending}
        aria-label={`Move ${field.name} down`}
        onClick={() => go("down")}
      >
        <ArrowDown size={13} aria-hidden="true" />
      </button>
    </>
  );
}

function optionsProblem(type, options) {
  if (type !== "select") return null;
  const list = options.map((o) => o.trim()).filter(Boolean);
  if (list.length < 2) return "Add at least 2 choices.";
  if (new Set(list.map((o) => o.toLowerCase())).size !== list.length) {
    return "Each choice must be different.";
  }
  return null;
}

function OptionsEditor({ options, onChange, problem, fieldName }) {
  const id = useId();
  const set = (i, value) => onChange(options.map((o, at) => (at === i ? value : o)));
  return (
    <fieldset className="tdet__options">
      <legend className="tdet__label">Choices the lab picks from</legend>
      {options.map((o, i) => (
        <div key={i} className="tdet__optionrow">
          <input
            id={`${id}-${i}`}
            className="jb-assign tdet__cellinput"
            value={o}
            maxLength={40}
            aria-label={`${fieldName || "Field"} choice ${i + 1}`}
            placeholder={["e.g. Negative", "e.g. Positive", "e.g. Trace"][i] || ""}
            onChange={(e) => set(i, e.target.value)}
          />
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini tdet__icon"
            aria-label={`Remove choice ${i + 1}`}
            disabled={options.length <= 2}
            onClick={() => onChange(options.filter((_, at) => at !== i))}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        disabled={options.length >= 20}
        onClick={() => onChange([...options, ""])}
      >
        + Add choice
      </button>
      {problem ? <p className="tdet__issue">{problem}</p> : null}
    </fieldset>
  );
}

const cleanList = (options) => options.map((o) => o.trim()).filter(Boolean);

const draftOf = (field) => ({
  name: field.name,
  unit: field.unit || "",
  noUnit: field.noUnit,
  type: field.type,
  decimals: field.decimals ?? 2,
  active: field.active,
  required: field.required,
  formula: field.formula?.raw || "",
  options: field.options?.length ? field.options : ["", ""],
});

function needsUnit(draft) {
  return (
    (draft.type === "numeric" || draft.type === "calculated") &&
    draft.active &&
    !draft.unit.trim() &&
    !draft.noUnit
  );
}

export function FieldEditor({ report, field, onDone }) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(field));
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const update = useUpdateField();
  const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const calculated = draft.type === "calculated";
  const numeric = draft.type === "numeric" || calculated;
  const nameMissing = !draft.name.trim();
  const unitMissing = needsUnit(draft);
  const formulaProblem = calculated ? formulaSyntaxError(draft.formula) : null;
  const choicesProblem = optionsProblem(draft.type, draft.options);

  const save = () => {
    setError("");
    update.mutate(
      {
        fieldId: field.id,
        reportId: report.id,
        expectedUpdatedAt: field.updatedAt,
        name: draft.name.trim(),
        unit: numeric && !draft.noUnit ? draft.unit.trim() || null : null,
        noUnit: numeric ? draft.noUnit : false,
        ...(calculated
          ? { formula: draft.formula.trim() }
          : {
              type: draft.type,
              ...(field.formula ? { formula: null } : {}),
              ...(draft.type === "select" ? { options: cleanList(draft.options) } : {}),
            }),
        decimals: numeric ? Number(draft.decimals) : null,
        active: draft.active,
        ...(field.required === null || calculated || draft.type === "group"
          ? {}
          : { required: draft.required }),
      },
      {
        onSuccess: () => {
          setConfirming(false);
          toast(`${draft.name.trim()} saved`, "success");
          onDone();
        },
        onError: (e) => {
          setConfirming(false);
          setError(requestErrorOf(e, "Could not save the field"));
        },
      },
    );
  };

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (nameMissing || unitMissing || formulaProblem || choicesProblem || update.isPending) return;
    if (field.alsoIn.length) setConfirming(true);
    else save();
  };

  return (
    <form className="tdet__editor" onSubmit={submit} aria-label={`Edit ${field.name}`} noValidate>
      <div className="tdet__grid">
        <div className="fset__field">
          <label htmlFor={`${id}-name`}>Name (required)</label>
          <input
            id={`${id}-name`}
            className="jb-assign"
            value={draft.name}
            maxLength={120}
            onChange={(e) => set("name")(e.target.value)}
            aria-invalid={touched && nameMissing}
            aria-describedby={touched && nameMissing ? `${id}-name-err` : undefined}
          />
          {touched && nameMissing ? (
            <p id={`${id}-name-err`} className="tdet__issue">
              Give the field a name.
            </p>
          ) : null}
        </div>
        <div className="fset__field">
          <label htmlFor={`${id}-type`}>Type</label>
          <select
            id={`${id}-type`}
            className="jb-assign"
            value={draft.type}
            onChange={(e) => set("type")(e.target.value)}
          >
            {ALL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {numeric ? (
          <>
            <div className="fset__field">
              <label htmlFor={`${id}-unit`}>Unit</label>
              <input
                id={`${id}-unit`}
                className="jb-assign"
                value={draft.noUnit ? "" : draft.unit}
                maxLength={40}
                disabled={draft.noUnit}
                placeholder="e.g. mg/dl"
                onChange={(e) => set("unit")(e.target.value)}
                aria-invalid={touched && unitMissing}
                aria-describedby={touched && unitMissing ? `${id}-unit-err` : undefined}
              />
              <label className="tdet__check">
                <input
                  type="checkbox"
                  checked={draft.noUnit}
                  onChange={(e) => set("noUnit")(e.target.checked)}
                />
                No unit (a plain number, e.g. a ratio)
              </label>
              {touched && unitMissing ? (
                <p id={`${id}-unit-err`} className="tdet__issue">
                  Enter a unit, or tick “No unit”.
                </p>
              ) : null}
            </div>
            <div className="fset__field">
              <label htmlFor={`${id}-dec`}>Decimals</label>
              <select
                id={`${id}-dec`}
                className="jb-assign"
                value={draft.decimals}
                onChange={(e) => set("decimals")(Number(e.target.value))}
              >
                {[0, 1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
      </div>
      <div className="tdet__checks">
        {field.required !== null && !calculated && draft.type !== "group" ? (
          <label className="tdet__check">
            <input
              type="checkbox"
              checked={!!draft.required}
              onChange={(e) => set("required")(e.target.checked)}
            />
            Required — the lab must fill it before saving
          </label>
        ) : null}
        <label className="tdet__check">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => set("active")(e.target.checked)}
          />
          Active — shown on new lab forms (saved results keep it either way)
        </label>
      </div>
      {calculated ? (
        <FormulaBuilder
          report={report}
          selfId={field.id}
          value={draft.formula}
          onChange={set("formula")}
          decimals={Number(draft.decimals)}
          unit={draft.noUnit ? "" : draft.unit}
          extraInputs={field.formula?.inputs || []}
          touched={touched}
        />
      ) : null}
      {draft.type === "select" ? (
        <OptionsEditor
          options={draft.options}
          onChange={set("options")}
          problem={touched ? choicesProblem : null}
          fieldName={draft.name}
        />
      ) : null}
      {field.formula && !calculated ? (
        <p className="tdet__note">
          Saving removes the formula: the lab will type this value in instead of it being
          calculated.
        </p>
      ) : null}
      {field.alsoIn.length ? (
        <p className="tdet__note">
          This field also prints in {field.alsoIn.join(", ")}. Changes apply there too.
        </p>
      ) : null}
      {error ? (
        <p className="tdet__issue" role="alert">
          {error}
        </p>
      ) : null}
      <div className="tdet__actions">
        <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onDone}>
          Cancel
        </button>
        <button
          type="submit"
          className="flow-btn flow-btn-primary flow-btn-mini"
          disabled={update.isPending}
        >
          {update.isPending ? "Saving…" : "Save field"}
        </button>
      </div>
      <ConfirmModal
        open={confirming}
        title={`Change ${field.name} in every report?`}
        message={
          <>
            <strong>{field.name}</strong> also prints in {field.alsoIn.join(", ")}. Saving changes
            it in {report.name} and there.
          </>
        }
        confirmLabel="Save in all reports"
        variant="primary"
        busy={update.isPending}
        onConfirm={save}
        onCancel={() => setConfirming(false)}
      />
    </form>
  );
}

export function AddField({ report }) {
  const id = useId();
  const blank = {
    name: "",
    unit: "",
    noUnit: false,
    type: "numeric",
    formula: "",
    options: ["", ""],
    decimals: 2,
  };
  const [draft, setDraft] = useState(blank);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const add = useAddField();
  const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const calculated = draft.type === "calculated";
  const numeric = draft.type === "numeric" || calculated;
  const nameMissing = !draft.name.trim();
  const unitMissing = numeric && !draft.unit.trim() && !draft.noUnit;
  const formulaProblem = calculated ? formulaSyntaxError(draft.formula) : null;
  const choicesProblem = optionsProblem(draft.type, draft.options);

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (nameMissing || unitMissing || formulaProblem || choicesProblem || add.isPending) return;
    add.mutate(
      {
        reportId: report.id,
        name: draft.name.trim(),
        unit: numeric && !draft.noUnit ? draft.unit.trim() : null,
        noUnit: numeric ? draft.noUnit : false,
        type: calculated ? "numeric" : draft.type,
        ...(numeric ? { decimals: Number(draft.decimals) } : {}),
        ...(calculated ? { formula: draft.formula.trim() } : {}),
        ...(draft.type === "select" ? { options: cleanList(draft.options) } : {}),
      },
      {
        onSuccess: () => {
          toast(`${draft.name.trim()} added to ${report.name}`, "success");
          setDraft(blank);
          setTouched(false);
        },
        onError: (err) => setError(requestErrorOf(err, "Could not add the field")),
      },
    );
  };

  return (
    <form className="tdet__add" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <h3 id={`${id}-title`} className="tdet__optitle">
        Add a field to {report.name}
      </h3>
      <div className="tdet__grid">
        <div className="fset__field">
          <label htmlFor={`${id}-name`}>Name (required)</label>
          <input
            id={`${id}-name`}
            className="jb-assign"
            value={draft.name}
            maxLength={120}
            placeholder="e.g. Vitamin D (25-OH)"
            onChange={(e) => set("name")(e.target.value)}
            aria-invalid={touched && nameMissing}
            aria-describedby={touched && nameMissing ? `${id}-name-err` : undefined}
          />
          {touched && nameMissing ? (
            <p id={`${id}-name-err`} className="tdet__issue">
              Give the field a name.
            </p>
          ) : null}
        </div>
        <div className="fset__field">
          <label htmlFor={`${id}-type`}>Type</label>
          <select
            id={`${id}-type`}
            className="jb-assign"
            value={draft.type}
            onChange={(e) => set("type")(e.target.value)}
          >
            {ALL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {numeric ? (
          <div className="fset__field">
            <label htmlFor={`${id}-unit`}>Unit</label>
            <input
              id={`${id}-unit`}
              className="jb-assign"
              value={draft.noUnit ? "" : draft.unit}
              maxLength={40}
              disabled={draft.noUnit}
              placeholder="e.g. ng/ml"
              onChange={(e) => set("unit")(e.target.value)}
              aria-invalid={touched && unitMissing}
              aria-describedby={touched && unitMissing ? `${id}-unit-err` : undefined}
            />
            <label className="tdet__check">
              <input
                type="checkbox"
                checked={draft.noUnit}
                onChange={(e) => set("noUnit")(e.target.checked)}
              />
              No unit
            </label>
            {touched && unitMissing ? (
              <p id={`${id}-unit-err`} className="tdet__issue">
                Enter a unit, or tick “No unit”.
              </p>
            ) : null}
          </div>
        ) : null}
        {numeric ? (
          <div className="fset__field">
            <label htmlFor={`${id}-dec`}>Decimals</label>
            <select
              id={`${id}-dec`}
              className="jb-assign"
              value={draft.decimals}
              onChange={(e) => set("decimals")(Number(e.target.value))}
            >
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {draft.type === "select" ? (
        <OptionsEditor
          options={draft.options}
          onChange={set("options")}
          problem={touched ? choicesProblem : null}
          fieldName={draft.name}
        />
      ) : null}
      {calculated ? (
        <FormulaBuilder
          report={report}
          value={draft.formula}
          onChange={set("formula")}
          decimals={Number(draft.decimals)}
          unit={draft.noUnit ? "" : draft.unit}
          touched={touched}
        />
      ) : (
        <p className="tdet__muted">Set reference ranges with the Ranges button once it is added.</p>
      )}
      {error ? (
        <p className="tdet__issue" role="alert">
          {error}
        </p>
      ) : null}
      <div className="tdet__actions">
        <button
          type="submit"
          className="flow-btn flow-btn-primary flow-btn-mini"
          disabled={add.isPending}
        >
          {add.isPending ? "Adding…" : "Add field"}
        </button>
      </div>
    </form>
  );
}

const AGE_UNITS = [
  { value: "y", label: "years" },
  { value: "mo", label: "months" },
  { value: "d", label: "days" },
];

let draftKey = 0;
const nextKey = () => `new-${(draftKey += 1)}`;

const limitText = (v) => (v === null || v === undefined ? "" : String(v));

function rangeDraft(r) {
  const from =
    r && r.minAgeDays > ALL_AGES.min ? splitDays(r.minAgeDays) : { amount: "", unit: "y" };
  const to = r && r.maxAgeDays < ALL_AGES.max ? splitDays(r.maxAgeDays) : { amount: "", unit: "y" };
  return {
    key: r?.id || nextKey(),
    id: r?.id || null,
    gender: r?.gender || "Both",
    fromAmount: from.amount,
    fromUnit: from.unit,
    toAmount: to.amount,
    toUnit: to.unit,
    min: limitText(r?.min),
    max: limitText(r?.max),
    minCritical: limitText(r?.minCritical),
    maxCritical: limitText(r?.maxCritical),
    text: r?.text || "",
  };
}

function toPayload(d) {
  const from = daysFrom(d.fromAmount, d.fromUnit);
  const to = daysFrom(d.toAmount, d.toUnit);
  const limit = (v) => (String(v).trim() === "" ? null : String(v).trim());
  return {
    id: d.id,
    gender: d.gender,
    minAgeDays: from === null ? ALL_AGES.min : Number.isNaN(from) ? -1 : from,
    maxAgeDays: to === null ? ALL_AGES.max : Number.isNaN(to) ? -1 : to,
    min: limit(d.min),
    max: limit(d.max),
    minCritical: limit(d.minCritical),
    maxCritical: limit(d.maxCritical),
    text: d.text.trim() || null,
  };
}

export function RangesEditor({ field, onDone }) {
  const [rows, setRows] = useState(() => field.ranges.filter((r) => !r.pregnant).map(rangeDraft));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const save = useSaveRanges();
  const payload = rows.map(toPayload);
  const problems = rangeProblems(payload);
  const problemsFor = (i) => problems.filter((p) => p.index === i).map((p) => p.message);
  const pregnant = field.ranges.filter((r) => r.pregnant).length;
  const patch = (key, change) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (problems.length || save.isPending) return;
    save.mutate(
      { fieldId: field.id, expectedUpdatedAt: field.updatedAt, ranges: payload },
      {
        onSuccess: () => {
          toast(`Ranges for ${field.name} saved`, "success");
          onDone();
        },
        onError: (err) => setError(requestErrorOf(err, "Could not save the ranges")),
      },
    );
  };

  const cell = (r, i, key, label, props = {}) => (
    <input
      className="jb-assign tdet__cellinput"
      value={r[key]}
      aria-label={`Range ${i + 1} ${label}`}
      onChange={(e) => patch(r.key, { [key]: e.target.value })}
      {...props}
    />
  );

  return (
    <form
      className="tdet__editor"
      onSubmit={submit}
      aria-label={`Ranges for ${field.name}`}
      noValidate
    >
      <h3 className="tdet__optitle">Reference ranges — {field.name}</h3>
      <p className="tdet__muted">
        The lab form picks the patient's sex first, then Both, and the narrowest age band. If the
        patient's sex or age is unknown, only Both / all-ages ranges apply. No match means no range
        and no flag. Ages: leave “from” empty for birth and “to” empty for no upper limit. Bands may
        meet at a boundary (e.g. 0–18 years and 18 years and over).
      </p>
      {rows.length ? (
        <div className="fset__scroll">
          <table className="flow-table tdet__rangetable">
            <thead>
              <tr>
                <th scope="col">Sex</th>
                <th scope="col">Age from</th>
                <th scope="col">Age to</th>
                <th scope="col">Low</th>
                <th scope="col">High</th>
                <th scope="col">Critical low</th>
                <th scope="col">Critical high</th>
                <th scope="col">Prints as</th>
                <th scope="col">
                  <span className="tdet__sronly">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const issues = touched ? problemsFor(i) : [];
                return (
                  <Fragment key={r.key}>
                    <tr className={issues.length ? "tdet__badrow" : ""}>
                      <td data-label="Sex">
                        <select
                          className="jb-assign tdet__cellinput"
                          value={r.gender}
                          aria-label={`Range ${i + 1} sex`}
                          onChange={(e) => patch(r.key, { gender: e.target.value })}
                        >
                          {RANGE_GENDERS.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                      </td>
                      {[
                        ["from", "age from"],
                        ["to", "age to"],
                      ].map(([part, label]) => (
                        <td
                          key={part}
                          className="tdet__age"
                          data-label={part === "from" ? "Age from" : "Age to"}
                        >
                          <div className="tdet__agepair">
                            {cell(r, i, `${part}Amount`, label, {
                              inputMode: "decimal",
                              placeholder: part === "from" ? "0" : "any",
                            })}
                            <select
                              className="jb-assign tdet__cellinput"
                              value={r[`${part}Unit`]}
                              aria-label={`Range ${i + 1} ${label} unit`}
                              onChange={(e) => patch(r.key, { [`${part}Unit`]: e.target.value })}
                            >
                              {AGE_UNITS.map((u) => (
                                <option key={u.value} value={u.value}>
                                  {u.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                      ))}
                      <td data-label="Low">{cell(r, i, "min", "low", { inputMode: "decimal" })}</td>
                      <td data-label="High">
                        {cell(r, i, "max", "high", { inputMode: "decimal" })}
                      </td>
                      <td data-label="Critical low">
                        {cell(r, i, "minCritical", "critical low", { inputMode: "decimal" })}
                      </td>
                      <td data-label="Critical high">
                        {cell(r, i, "maxCritical", "critical high", { inputMode: "decimal" })}
                      </td>
                      <td data-label="Prints as">
                        {cell(r, i, "text", "prints as", { maxLength: 120, placeholder: "auto" })}
                      </td>
                      <td data-label="">
                        <button
                          type="button"
                          className="flow-btn flow-btn-ghost flow-btn-mini tdet__icon"
                          aria-label={`Remove range ${i + 1}`}
                          onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                    {issues.length ? (
                      <tr className="tdet__badrow">
                        <td colSpan={9}>
                          {issues.map((m) => (
                            <p key={m} className="tdet__issue">
                              Range {i + 1}: {m}
                            </p>
                          ))}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="tdet__muted">
          No ranges — results for this field will show no range and no H/L flag.
        </p>
      )}
      {pregnant ? (
        <p className="tdet__note">
          {pregnant} pregnancy range{pregnant === 1 ? " is" : "s are"} kept as imported and not
          shown here.
        </p>
      ) : null}
      {error ? (
        <p className="tdet__issue" role="alert">
          {error}
        </p>
      ) : null}
      <div className="tdet__actions tdet__actions--split">
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          disabled={rows.length >= MAX_RANGES}
          onClick={() => setRows((list) => [...list, rangeDraft(null)])}
        >
          + Add range
        </button>
        <span className="tdet__actions">
          <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onDone}>
            Cancel
          </button>
          <button
            type="submit"
            className="flow-btn flow-btn-primary flow-btn-mini"
            disabled={save.isPending}
          >
            {save.isPending ? "Saving…" : "Save ranges"}
          </button>
        </span>
      </div>
    </form>
  );
}
