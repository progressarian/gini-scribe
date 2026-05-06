import { memo, useState } from "react";
import { MED_GROUPS, DIABETES_CLASSES } from "../../../config/drugDatabase";

const TIMINGS = [
  "Fasting",
  "Before breakfast",
  "After breakfast",
  "Before lunch",
  "After lunch",
  "Before dinner",
  "After dinner",
  "At bedtime",
  "With milk",
  "SOS only",
];

// Day-of-week tokens for weekly / fortnightly medicines. AddMedicationModal
// stores the selected days as a suffix on `frequency` (e.g.
// "Once weekly · Mon, Wed"); this list lets us parse them back out and
// render the picker pre-selected.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_TO_INT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function weekdaysToInts(arr) {
  return arr
    .map((d) => WEEKDAY_TO_INT[d])
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
}

// Split a possibly-suffixed frequency string into { base, days }.
//   "Once weekly · Mon, Wed"  → { base: "Once weekly", days: ["Mon","Wed"] }
//   "Once weekly"             → { base: "Once weekly", days: [] }
//   "OD"                      → { base: "OD",          days: [] }
function parseFrequency(raw) {
  const m = String(raw || "").match(/^(.+?)\s*·\s*(.+)$/);
  if (!m) return { base: raw || "OD", days: [] };
  const base = m[1].trim();
  const days = m[2]
    .split(",")
    .map((s) => s.trim())
    .filter((d) => WEEKDAYS.includes(d));
  return { base, days };
}

const EditMedicationModal = memo(function EditMedicationModal({
  medication,
  diagnoses,
  activeMeds,
  onClose,
  onSubmit,
}) {
  const initialDose = medication.dose || "";
  const initialFrequencyRaw = medication.frequency || "OD";
  const { base: initialFrequency, days: initialWeekdays } = parseFrequency(initialFrequencyRaw);
  const initialTimingRaw = medication.timing || "";
  const initialTimingTokens = initialTimingRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Preserve any legacy/freeform tokens (e.g. "Before meals") that aren't in
  // the canonical TIMINGS list so editing other fields doesn't silently drop
  // them.
  const extraTimings = initialTimingTokens.filter(
    (e) => !TIMINGS.some((t) => t.toLowerCase() === e.toLowerCase()),
  );
  const initialMedGroup = medication.med_group || "";
  const initialDrugClass = medication.drug_class || "";
  const initialExternalDoctor = medication.external_doctor || "";
  const initialRoute = medication.route || "Oral";
  const initialClinicalNote = medication.clinical_note || "";
  const initialNotes = medication.notes || "";
  // for_diagnosis is text[] in the DB; the form picker is single-select so
  // we surface the first entry. Other entries are preserved on submit.
  const initialForDxArray = Array.isArray(medication.for_diagnosis)
    ? medication.for_diagnosis
    : Array.isArray(medication.for_conditions)
      ? medication.for_conditions
      : [];
  const initialForDx = initialForDxArray[0] || "";
  const extraForDx = initialForDxArray.slice(1);
  const initialStartedDate = medication.started_date
    ? String(medication.started_date).slice(0, 10)
    : "";
  const initialSideEffects = medication.side_effects || "";

  const [dose, setDose] = useState(initialDose);
  const [frequency, setFrequency] = useState(initialFrequency);
  const [weekdays, setWeekdays] = useState(initialWeekdays);
  const [timings, setTimings] = useState(() =>
    TIMINGS.filter((t) => initialTimingTokens.some((e) => e.toLowerCase() === t.toLowerCase())),
  );
  const [medGroup, setMedGroup] = useState(initialMedGroup);
  const [drugClass, setDrugClass] = useState(initialDrugClass);
  const [externalDoctor, setExternalDoctor] = useState(initialExternalDoctor);
  const [route, setRoute] = useState(initialRoute);
  const [clinicalNote, setClinicalNote] = useState(initialClinicalNote);
  const [notes, setNotes] = useState(initialNotes);
  const [forDx, setForDx] = useState(initialForDx);
  const [startedDate, setStartedDate] = useState(initialStartedDate);
  const [sideEffects, setSideEffects] = useState(initialSideEffects);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  // Parent selection. Empty string = standalone (clear the link). Eligible
  // parents: any other top-level active med for this patient.
  const parentCandidates = (activeMeds || []).filter(
    (m) => m && m.id !== medication.id && !m.parent_medication_id && Number.isFinite(Number(m.id)),
  );
  const [parentId, setParentId] = useState(
    medication.parent_medication_id ? String(medication.parent_medication_id) : "",
  );
  const [supportCondition, setSupportCondition] = useState(medication.support_condition || "");
  const isSubMed = !!parentId;

  const toggleTiming = (t) =>
    setTimings((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));
  const toggleWeekday = (d) =>
    setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));

  const supportsWeekday = frequency === "Once weekly" || frequency === "Once in 14 days";
  const showDrugClass = medGroup === "diabetes";
  const showExternalDoctor = medGroup === "external";

  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const nextTiming = [...timings, ...extraTimings].join(", ");
      // Recombine the weekday selection into the frequency string. Applies
      // to weekly / fortnightly schedules; other frequencies clear any
      // stale day suffix.
      const nextFrequency =
        supportsWeekday && weekdays.length ? `${frequency} · ${weekdays.join(", ")}` : frequency;

      const payload = { reason };
      // Only attach changed fields so the server can keep "untouched" columns
      // exactly as they were (the PATCH endpoint distinguishes undefined from
      // null).
      if (dose !== initialDose) payload.dose = dose;
      if (nextFrequency !== initialFrequencyRaw) payload.frequency = nextFrequency;
      if (nextTiming !== initialTimingRaw) payload.timing = nextTiming;

      // Mirror the weekday selection into the structured `days_of_week`
      // column so the patient app can filter "Things to do today" without
      // re-parsing the frequency suffix. Cleared whenever the frequency no
      // longer supports weekdays.
      const initialDaysInts = weekdaysToInts(initialWeekdays);
      const nextDaysInts = supportsWeekday ? weekdaysToInts(weekdays) : [];
      const sameDays =
        initialDaysInts.length === nextDaysInts.length &&
        initialDaysInts.every((d, i) => d === nextDaysInts[i]);
      if (!sameDays) {
        payload.days_of_week = nextDaysInts.length ? nextDaysInts : null;
      }

      if (medGroup !== initialMedGroup) payload.med_group = medGroup || null;
      // drug_class only persists when the group is diabetes; switching away
      // from diabetes clears it.
      const effectiveDrugClass = showDrugClass ? drugClass : null;
      if (effectiveDrugClass !== (initialMedGroup === "diabetes" ? initialDrugClass : null)) {
        payload.drug_class = effectiveDrugClass || null;
      }
      const effectiveExternalDoctor = showExternalDoctor ? externalDoctor : null;
      if (
        effectiveExternalDoctor !== (initialMedGroup === "external" ? initialExternalDoctor : null)
      ) {
        payload.external_doctor = effectiveExternalDoctor || null;
      }
      if (route !== initialRoute) payload.route = route || null;
      if (clinicalNote !== initialClinicalNote) payload.clinical_note = clinicalNote || null;
      if (notes !== initialNotes) payload.notes = notes || null;
      if (forDx !== initialForDx) {
        payload.for_diagnosis = forDx
          ? [forDx, ...extraForDx]
          : extraForDx.length
            ? extraForDx
            : null;
      }
      if (startedDate !== initialStartedDate) {
        payload.started_date = startedDate || null;
      }
      if (sideEffects !== initialSideEffects) payload.side_effects = sideEffects || null;

      const initialParent = medication.parent_medication_id
        ? String(medication.parent_medication_id)
        : "";
      if (parentId !== initialParent) {
        payload.parent_medication_id = parentId ? Number(parentId) : null;
      }
      const initialSupport = medication.support_condition || "";
      if ((parentId ? supportCondition : "") !== initialSupport) {
        payload.support_condition = parentId ? supportCondition || null : null;
      }
      await onSubmit(payload);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="mo open"
      onClick={(e) => {
        if (loading) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mbox" style={{ width: 500 }}>
        <div className="mttl">✏️ Edit Medication</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
          Editing: <strong>{medication.name}</strong>
          {medication.visit_status && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                padding: "1px 7px",
                borderRadius: 10,
                background: medication.visit_status === "current" ? "#e6f6f4" : "#f0f4f7",
                color: medication.visit_status === "current" ? "#009e8c" : "#6b7d90",
                fontWeight: 600,
              }}
            >
              {medication.visit_status === "current" ? "This visit" : "Previous"}
            </span>
          )}
        </div>
        {parentCandidates.length > 0 && (
          <div className="mf">
            <label className="ml">Type</label>
            <select
              className="ms"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={loading}
            >
              <option value="">Standalone medicine</option>
              {parentCandidates.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  Support medicine for {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {isSubMed && (
          <div className="mf">
            <label className="ml">Support for what</label>
            <input
              className="mi"
              placeholder="e.g. SOS for nausea/vomiting"
              value={supportCondition}
              onChange={(e) => setSupportCondition(e.target.value)}
              disabled={loading}
            />
          </div>
        )}

        {/* Group */}
        <div className="mf">
          <label className="ml">Group</label>
          <select
            className="ms"
            value={medGroup}
            onChange={(e) => setMedGroup(e.target.value)}
            disabled={loading}
          >
            <option value="">— None —</option>
            {MED_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.icon} {g.label}
              </option>
            ))}
          </select>
        </div>

        {showDrugClass && (
          <div className="mf">
            <label className="ml">Drug Class</label>
            <select
              className="ms"
              value={drugClass}
              onChange={(e) => setDrugClass(e.target.value)}
              disabled={loading}
            >
              <option value="">Select…</option>
              {DIABETES_CLASSES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {showExternalDoctor && (
          <div className="mf">
            <label className="ml">Prescribing Doctor *</label>
            <input
              className="mi"
              placeholder="e.g. Dr. Sharma, Cardiologist"
              value={externalDoctor}
              onChange={(e) => setExternalDoctor(e.target.value)}
              disabled={loading}
            />
            <div style={{ fontSize: 10, color: "var(--red)", marginTop: 4 }}>
              Never modify without their consent
            </div>
          </div>
        )}

        <div className="g2">
          <div className="mf">
            <label className="ml">Dosage</label>
            <input
              className="mi"
              placeholder="e.g. 24 Units"
              value={dose}
              onChange={(e) => setDose(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="mf">
            <label className="ml">Frequency</label>
            <select
              className="ms"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              disabled={loading}
            >
              <option value="OD">Once daily (OD)</option>
              <option value="BD">Twice daily (BD)</option>
              <option value="TDS">Three times (TDS)</option>
              <option value="QID">Four times (QID)</option>
              <option value="Once weekly">Once weekly</option>
              <option value="Once in 14 days">Once in 14 days</option>
              <option value="SOS">As needed (SOS)</option>
            </select>
          </div>
        </div>

        {supportsWeekday && (
          <div className="mf">
            <label className="ml">
              On which day{weekdays.length > 1 ? "s" : ""}{" "}
              <span style={{ color: "var(--t3)", fontWeight: 400, fontSize: 11 }}>(optional)</span>
            </label>
            <div className="time-pills">
              {WEEKDAYS.map((d) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(d)}
                    onChange={() => toggleWeekday(d)}
                    disabled={loading}
                  />
                  <span>{d}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mf">
          <label className="ml">When to take</label>
          <div className="time-pills">
            {TIMINGS.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={timings.includes(t)}
                  onChange={() => toggleTiming(t)}
                  disabled={loading}
                />
                <span>{t}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="g2">
          <div className="mf">
            <label className="ml">Route</label>
            <select
              className="ms"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              disabled={loading}
            >
              <option value="Oral">Oral</option>
              <option value="Subcutaneous">Subcutaneous</option>
              <option value="Intramuscular">Intramuscular</option>
              <option value="Intravenous">Intravenous</option>
              <option value="Topical">Topical</option>
              <option value="Inhaled">Inhaled</option>
              <option value="Sublingual">Sublingual</option>
            </select>
          </div>
          <div className="mf">
            <label className="ml">Started on</label>
            <input
              type="date"
              className="mi"
              value={startedDate}
              onChange={(e) => setStartedDate(e.target.value)}
              disabled={loading}
            />
          </div>
        </div>

        <div className="mf">
          <label className="ml">Clinical note</label>
          <input
            className="mi"
            placeholder="e.g. Renal protection — UACR 88"
            value={clinicalNote}
            onChange={(e) => setClinicalNote(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="mf">
          <label className="ml">Additional instruction</label>
          <input
            className="mi"
            placeholder="e.g. 30 min before breakfast, with food"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="mf">
          <label className="ml">Prescribed for</label>
          <select
            className="ms"
            value={forDx}
            onChange={(e) => setForDx(e.target.value)}
            disabled={loading}
          >
            <option value="">Select…</option>
            {(diagnoses || []).map((d) => (
              <option key={d.id} value={d.label || d.diagnosis_id}>
                {d.label || d.diagnosis_id}
              </option>
            ))}
            {/* Preserve current value if it's not in the diagnoses list. */}
            {initialForDx &&
              !(diagnoses || []).some((d) => (d.label || d.diagnosis_id) === initialForDx) && (
                <option value={initialForDx}>{initialForDx}</option>
              )}
          </select>
        </div>

        <div className="mf">
          <label className="ml">Side effects observed (optional)</label>
          <input
            className="mi"
            placeholder="e.g. Mild nausea, dizziness"
            value={sideEffects}
            onChange={(e) => setSideEffects(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="mf">
          <label className="ml">Reason for change</label>
          <textarea
            className="mta"
            style={{ minHeight: 50 }}
            placeholder="Why is this being changed?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="macts">
          <button className="btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-p"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: loading ? 0.75 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}
            disabled={loading}
            onClick={handleSubmit}
          >
            {loading && (
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  display: "inline-block",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            )}
            {loading ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default EditMedicationModal;
