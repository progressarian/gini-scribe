import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ACANTHOSIS_GRADES,
  EXAM_FINDING_STATES,
  EXAM_REGIONS,
  HISTORY_TEXT_FIELDS,
  HISTORY_YES_NO_FIELDS,
  JVP_VALUES,
  WORKUP_NOTE_MAX,
  WORKUP_TEXT_MAX,
  countRegion,
  historyFieldApplies,
  summariseExam,
  withoutHiddenHistory,
  summariseHistory,
} from "../../../shared/newPatientWorkup";
import {
  useNewPatientWorkup,
  useSaveNewPatientWorkup,
} from "../../queries/hooks/useNewPatientWorkup";
import { ALLERGY_OPTIONS } from "../../../shared/giniflowAllergy";
import { fmtDate } from "./helpers";
import "./VisitNewPatientWorkup.css";

const SAVE_DELAY_MS = 700;

const VISIT_UI = {
  field: "mf",
  label: "ml",
  input: "mi",
  text: "nf",
  sub: "subsec",
  btn: "bx bx-p",
  btnWarn: "bx bx-r",
};

const STATION_UI = {
  field: "npw-field",
  label: "cp-lab",
  input: "cp-inp",
  text: "cp-text",
  sub: "npw-sub",
  btn: "btn-sm",
  btnWarn: "btn-sm",
};

const UiContext = createContext(VISIT_UI);
const useUi = () => useContext(UiContext);

const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

const recordedBy = (workup) =>
  [workup.updated_by || workup.prepared_by, workup.visit_date && fmtDate(workup.visit_date)]
    .filter(Boolean)
    .join(" · ");

function Choice({ name, options, value, onChange, labelledBy }) {
  return (
    <div className="npw-seg" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => (
        <label key={o.id} className={value === o.id ? "on" : ""}>
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={value === o.id}
            onChange={() => onChange(o.id)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

const ALLERGY_CHOICES = ALLERGY_OPTIONS.map((o) => ({ id: o.value, label: o.label }));
const NOT_EXAMINED = { id: "", label: "—" };
const FINDING_OPTIONS = [NOT_EXAMINED, ...EXAM_FINDING_STATES];
const JVP_OPTIONS = [NOT_EXAMINED, ...JVP_VALUES];
const YES_NO_OPTIONS = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

function NoteInput({ value, onChange, label }) {
  const ui = useUi();
  return (
    <input
      className={`${ui.input} npw-note`}
      aria-label={`${label} note`}
      placeholder="Note (optional)"
      maxLength={WORKUP_NOTE_MAX}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ExamItem({ region, item, entry = {}, onChange }) {
  const labelId = useId();
  const name = `${region.id}-${item.id}-${labelId}`;
  const set = (patch) => onChange({ ...entry, ...patch });
  const chosen = item.kind === "finding" ? entry.state : entry.value;
  const showNote = item.kind === "finding" ? entry.state === "present" : !!chosen;
  return (
    <div className="npw-item">
      <span id={labelId} className="npw-item-label">
        {item.label}
      </span>
      {item.kind === "grade" ? (
        <select
          className="npw-select"
          aria-labelledby={labelId}
          value={entry.value ?? ""}
          onChange={(e) => set({ value: e.target.value || null })}
        >
          <option value="">— not examined</option>
          {ACANTHOSIS_GRADES.map((g) => (
            <option key={g} value={g}>
              Grade {g}
            </option>
          ))}
        </select>
      ) : (
        <Choice
          name={name}
          labelledBy={labelId}
          options={item.kind === "jvp" ? JVP_OPTIONS : FINDING_OPTIONS}
          value={chosen ?? ""}
          onChange={(v) => set(item.kind === "jvp" ? { value: v || null } : { state: v || null })}
        />
      )}
      {showNote && (
        <NoteInput label={item.label} value={entry.note} onChange={(note) => set({ note })} />
      )}
    </div>
  );
}

const bulkSet = (region, regionExam, state, { onlyEmpty = false } = {}) => {
  const next = { ...regionExam };
  for (const item of region.items) {
    if (item.kind !== "finding") {
      if (state === null) delete next[item.id];
      continue;
    }
    if (onlyEmpty && next[item.id]?.state) continue;
    if (state === null) delete next[item.id];
    else next[item.id] = { ...next[item.id], state };
  }
  return next;
};

const examTotals = (exam = {}) => {
  let abnormal = 0;
  let normal = 0;
  for (const region of EXAM_REGIONS) {
    const c = countRegion(region, exam[region.id]);
    abnormal += c.abnormal;
    normal += c.normal;
  }
  return `${abnormal} abnormal · ${normal} normal`;
};

function ExamRegion({ region, regionExam = {}, onChange }) {
  const ui = useUi();
  const { abnormal, normal } = countRegion(region, regionExam);
  const started = abnormal + normal > 0;
  const actions = started
    ? [
        ["Rest normal", () => bulkSet(region, regionExam, "normal", { onlyEmpty: true })],
        ["All normal", () => bulkSet(region, regionExam, "normal")],
        ["All present", () => bulkSet(region, regionExam, "present")],
        ["Clear", () => bulkSet(region, regionExam, null)],
      ]
    : [["Mark rest normal", () => bulkSet(region, regionExam, "normal", { onlyEmpty: true })]];
  return (
    <fieldset className="npw-region">
      <legend>
        {region.label}
        <span className="npw-count">
          {abnormal} abnormal · {normal} normal
        </span>
      </legend>
      <div className="npw-bulk" role="group" aria-label={`${region.label} — set several at once`}>
        {actions.map(([label, run]) => (
          <button
            key={label}
            type="button"
            className={`${ui.btn} npw-rest`}
            onClick={() => onChange(run())}
          >
            {label}
          </button>
        ))}
      </div>
      {region.items.map((item) => (
        <ExamItem
          key={item.id}
          region={region}
          item={item}
          entry={regionExam[item.id]}
          onChange={(entry) => onChange({ ...regionExam, [item.id]: entry })}
        />
      ))}
    </fieldset>
  );
}

function HistoryFields({ history, onChange, allergy, onAllergyChange }) {
  const ui = useUi();
  const baseId = useId();
  const set = (id, value) => onChange(withoutHiddenHistory({ ...history, [id]: value }));
  return (
    <div className="npw-history">
      {HISTORY_TEXT_FIELDS.map((f) => (
        <div className={ui.field} key={f.id}>
          <label className={ui.label} htmlFor={`${baseId}-${f.id}`}>
            {f.label}
          </label>
          <textarea
            id={`${baseId}-${f.id}`}
            className={`${ui.text} npw-text`}
            rows={2}
            maxLength={WORKUP_TEXT_MAX}
            value={history[f.id] || ""}
            onChange={(e) => set(f.id, e.target.value)}
          />
        </div>
      ))}
      {HISTORY_YES_NO_FIELDS.filter((f) => historyFieldApplies(f, history)).map((f) => {
        const entry = history[f.id] || {};
        return (
          <div className={ui.field} key={f.id}>
            <span className={ui.label} id={`${baseId}-${f.id}`}>
              {f.label}
            </span>
            <div className="npw-inline">
              <Choice
                name={`${baseId}-${f.id}`}
                labelledBy={`${baseId}-${f.id}`}
                options={YES_NO_OPTIONS}
                value={entry.answer || ""}
                onChange={(answer) => set(f.id, { ...entry, answer })}
              />
              <input
                className={`${ui.input} npw-note`}
                aria-label={`${f.label} details`}
                placeholder="Additional info"
                maxLength={WORKUP_NOTE_MAX}
                value={entry.note || ""}
                onChange={(e) => set(f.id, { ...entry, note: e.target.value })}
              />
            </div>
          </div>
        );
      })}
      <div className={ui.field}>
        <span className={ui.label} id={`${baseId}-allergies`}>
          Allergies
        </span>
        <div className="npw-inline">
          <Choice
            name={`${baseId}-allergies`}
            labelledBy={`${baseId}-allergies`}
            options={ALLERGY_CHOICES}
            value={allergy.status || ""}
            onChange={(status) => onAllergyChange({ ...allergy, status })}
          />
          {allergy.status === "known" && (
            <input
              className={`${ui.input} npw-note`}
              aria-label="Known allergies"
              placeholder="Drug / food — reaction"
              maxLength={WORKUP_NOTE_MAX}
              value={allergy.note || ""}
              onChange={(e) => onAllergyChange({ ...allergy, note: e.target.value })}
            />
          )}
        </div>
        <div className="npw-hint">
          {allergy.status === "known" && !allergy.note?.trim()
            ? "Name the allergy to save it."
            : "Saved on the patient's record — the same answer the Vitals station and referral letters use."}
        </div>
      </div>
    </div>
  );
}

function LabelledLines({ lines }) {
  return (
    <dl className="npw-lines">
      {lines.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function WorkupExamSummary({ exam }) {
  const summary = summariseExam(exam || {});
  const lines = summary.lines.map(({ region, findings }) => ({
    label: region,
    value: findings.join(", "),
  }));
  if (summary.restNormal)
    lines.push({ label: lines.length ? "Rest of the examination" : "Examination", value: "NAD" });
  if (!lines.length) return <div className="npw-hint">No examination recorded.</div>;
  return <LabelledLines lines={lines} />;
}

function WorkupSummary({ workup, allergy }) {
  const ui = useUi();
  return (
    <>
      <div className={ui.sub}>History</div>
      <LabelledLines lines={summariseHistory(workup.history || {}, allergy)} />
      <div className={ui.sub}>Examination</div>
      <WorkupExamSummary exam={workup.exam} />
    </>
  );
}

function SaveStatus({ status, onRetry, onReload }) {
  const ui = useUi();
  if (status.kind === "saving") return <span className="npw-status">Saving…</span>;
  if (status.kind === "saved")
    return <span className="npw-status ok">Saved {timeOf(status.at)}</span>;
  if (status.kind === "error")
    return (
      <span className="npw-status bad">
        Not saved — {status.message}{" "}
        <button type="button" className={ui.btnWarn} onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  if (status.kind === "stale")
    return (
      <span className="npw-status bad">
        {status.message}{" "}
        <button type="button" className={ui.btnWarn} onClick={onReload}>
          Reload
        </button>
      </span>
    );
  if (status.kind === "locked") return <span className="npw-status bad">{status.message}</span>;
  return null;
}

const errorOf = (e) => ({
  code: e?.response?.data?.code,
  message: e?.response?.data?.error || "check your connection and try again",
});

const allergyReady = (a) => !!a?.status && (a.status !== "known" || !!a.note?.trim());

function WorkupForm({ patientId, appointmentId, initial, initialAllergy, rxDone, onReload }) {
  const ui = useUi();
  const [draft, setDraft] = useState(() => ({
    history: initial?.history || {},
    exam: initial?.exam || {},
    allergy: {
      status: initialAllergy?.allergy_status || "",
      note: initialAllergy?.allergy_note || "",
    },
    allergyChanged: false,
  }));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState({ kind: "idle" });
  const [examOpen, setExamOpen] = useState(true);
  const examId = useId();
  const [savedSinceRx, setSavedSinceRx] = useState(false);
  const version = useRef(initial?.version ?? null);
  const draftRef = useRef(draft);
  const inFlight = useRef(false);
  const again = useRef(false);
  const save = useSaveNewPatientWorkup(patientId, appointmentId);
  const locked = status.kind === "locked" || status.kind === "stale";

  const flush = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    setStatus({ kind: "saving" });
    try {
      const current = draftRef.current;
      const sendAllergy = current.allergyChanged && allergyReady(current.allergy);
      const { workup } = await save.mutateAsync({
        expected_updated_at: version.current,
        history: current.history,
        exam: current.exam,
        ...(sendAllergy && { allergy: current.allergy }),
      });
      version.current = workup.version;
      setStatus({ kind: "saved", at: new Date().toISOString() });
      if (rxDone) setSavedSinceRx(true);
    } catch (e) {
      const err = errorOf(e);
      if (err.code === "workup_stale") setStatus({ kind: "stale", message: err.message });
      else if (err.code === "workup_locked") setStatus({ kind: "locked", message: err.message });
      else setStatus({ kind: "error", message: err.message });
      again.current = false;
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        flushRef.current();
      }
    }
  }, [save, rxDone]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!dirty || locked) return undefined;
    const timer = setTimeout(() => flushRef.current(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, locked]);

  const update = (part, value) => {
    setDraft((d) => {
      const next = { ...d, [part]: value, ...(part === "allergy" && { allergyChanged: true }) };
      draftRef.current = next;
      return next;
    });
    setDirty(true);
  };

  return (
    <>
      <div className="npw-statusbar" aria-live="polite">
        <SaveStatus status={status} onRetry={flush} onReload={onReload} />
        {savedSinceRx && (
          <span className="npw-status warn">
            The prescription was already made — regenerate it in Docs to include these changes.
          </span>
        )}
      </div>
      <fieldset className="npw-body" disabled={locked}>
        <div className={ui.sub}>History — general</div>
        <HistoryFields
          history={draft.history}
          onChange={(h) => update("history", h)}
          allergy={draft.allergy}
          onAllergyChange={(a) => update("allergy", a)}
        />
        <button
          type="button"
          className={`${ui.sub} npw-toggle`}
          aria-expanded={examOpen}
          aria-controls={examId}
          onClick={() => setExamOpen((open) => !open)}
        >
          <span aria-hidden="true">{examOpen ? "▾" : "▸"}</span> Examination
          <span className="npw-count">{examTotals(draft.exam)}</span>
        </button>
        {examOpen && (
          <div className="npw-regions" id={examId}>
            {EXAM_REGIONS.map((region) => (
              <ExamRegion
                key={region.id}
                region={region}
                regionExam={draft.exam[region.id]}
                onChange={(r) => update("exam", { ...draft.exam, [region.id]: r })}
              />
            ))}
          </div>
        )}
      </fieldset>
    </>
  );
}

function Shell({ station, id, title, meta, children }) {
  if (station)
    return (
      <section className="csec npw-station" id={id}>
        <div className="cs-head">
          <h2>{title}</h2>
          {meta && <span className="cs-sub">{meta}</span>}
        </div>
        {children}
      </section>
    );
  return (
    <div className="sc" id={id}>
      <div className="sch">
        <div className="sct">
          <div className="sci ic-t">🩺</div>
          {title}
        </div>
        {meta && <span className="npw-meta">{meta}</span>}
      </div>
      <div className="scb">{children}</div>
    </div>
  );
}

const VisitNewPatientWorkup = memo(function VisitNewPatientWorkup({
  patientId,
  appointmentId,
  mode = "visit",
  rxDone = false,
  variant = "visit",
}) {
  const station = variant === "station";
  const query = useNewPatientWorkup(patientId, appointmentId);
  const [formKey, setFormKey] = useState(0);
  const data = query.data;

  const reload = async () => {
    await query.refetch();
    setFormKey((k) => k + 1);
  };

  const ui = station ? STATION_UI : VISIT_UI;
  const shell = (props, children) => (
    <UiContext.Provider value={ui}>
      <Shell station={station} {...props}>
        {children}
      </Shell>
    </UiContext.Provider>
  );

  if (query.isError && mode !== "earlier")
    return shell(
      { id: "workup", title: "New patient History & Examination" },
      <div className="npw-status bad">
        Couldn't load the History & Examination form.{" "}
        <button type="button" className={ui.btnWarn} onClick={() => query.refetch()}>
          Try again
        </button>
      </div>,
    );
  if (!data) return null;

  const showEarlier = mode === "earlier" || (mode === "auto" && !data.applies);
  if (showEarlier) {
    if (!data.earlier) return null;
    return shell(
      {
        id: "workup-earlier",
        title: "First-visit History & Examination",
        meta: recordedBy(data.earlier),
      },
      <WorkupSummary workup={data.earlier} allergy={data.allergy} />,
    );
  }

  if (!data.applies) return null;
  return shell(
    {
      id: "workup",
      title: "New patient History & Examination",
      meta: data.workup ? recordedBy(data.workup) : null,
    },
    data.editable ? (
      <WorkupForm
        key={`${appointmentId}-${formKey}`}
        patientId={patientId}
        appointmentId={appointmentId}
        initial={data.workup}
        initialAllergy={data.allergy}
        rxDone={rxDone}
        onReload={reload}
      />
    ) : data.workup ? (
      <>
        <div className="npw-hint">Read-only — this visit's day has passed.</div>
        <WorkupSummary workup={data.workup} allergy={data.allergy} />
      </>
    ) : (
      <div className="npw-hint">No History & Examination was recorded on this visit.</div>
    ),
  );
});

export default VisitNewPatientWorkup;
