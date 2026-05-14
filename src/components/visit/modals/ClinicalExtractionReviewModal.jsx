import { memo, useMemo, useState } from "react";
import { normalizeTestName } from "../../../config/labNormalization";
import { fmtDateShort } from "../helpers";
import { formatWhenToTake, toWhenToTakeArray } from "../../../config/medicationTimings";

const canonize = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

// Day-of-week chips for weekly / fortnightly medicines. Mirrors the constants
// used by AddMedicationModal so the saved values line up across entry points.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const INT_TO_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_TO_INT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function isWeeklyFreq(freq) {
  const f = String(freq || "").toLowerCase();
  return (
    /\bonce\s*weekly\b/.test(f) ||
    /\bweekly\b/.test(f) ||
    /\bonce\s+a\s+week\b/.test(f) ||
    /\bonce\s+in\s+14\s+days\b/.test(f) ||
    /\bfortnight/.test(f)
  );
}

function stripDaysSuffix(freq) {
  const m = String(freq || "").match(/^(.+?)\s*·\s*(.+)$/);
  return m ? m[1].trim() : String(freq || "");
}

function parseSuffixDays(freq) {
  const m = String(freq || "").match(/^.+?\s*·\s*(.+)$/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .map((d) => WEEKDAY_TO_INT[d])
    .filter((n) => typeof n === "number");
}

function weekdayOfIsoDate(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

// Lab test names that overlap with vitals — we send these as vitals rows only
const VITAL_NAME_RE =
  /^(height|weight|bmi|body\s*mass\s*index|body\s*fat|waist|waist\s*circumference|bp\s*systolic|bp\s*diastolic|systolic\s*bp|diastolic\s*bp|pulse|heart\s*rate|hr)\b/i;

function Section({ title, count, total, open, onToggle, children }) {
  return (
    <div style={{ border: "1px solid var(--border2)", borderRadius: "var(--rs)", marginBottom: 8 }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          background: "var(--bg2)",
          cursor: "pointer",
          borderBottom: open ? "1px solid var(--border2)" : "none",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--t3)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t3)" }}>
          {count}/{total}
        </span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

function Row({
  checked,
  onToggle,
  disabled,
  left,
  right,
  muted,
  editable,
  editing,
  onToggleEdit,
  editNode,
}) {
  // We can't wrap the row in a <label> when inputs are present inside the
  // edit body — clicking inside the inputs would otherwise re-toggle the
  // outer checkbox. So the row is a <div> with a manual label only around
  // the checkbox + display text.
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid var(--border2)",
        opacity: disabled ? 0.55 : checked ? 1 : 0.5,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: disabled ? "default" : "pointer",
        }}
        onClick={(e) => {
          if (disabled) return;
          // Clicking the pencil button must not toggle the checkbox.
          if (e.target.closest("[data-row-action]")) return;
          onToggle && onToggle();
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          readOnly
          style={{ flexShrink: 0, pointerEvents: "none" }}
        />
        <div style={{ flex: 1, color: muted ? "var(--t3)" : "var(--t1)" }}>{left}</div>
        {right && (
          <div style={{ color: "var(--t3)", fontSize: 11, whiteSpace: "nowrap" }}>{right}</div>
        )}
        {editable && !disabled && (
          <button
            type="button"
            data-row-action="edit"
            onClick={onToggleEdit}
            title={editing ? "Done" : "Edit"}
            style={{
              fontSize: 11,
              padding: "2px 6px",
              border: "1px solid var(--border2)",
              borderRadius: 4,
              background: editing ? "var(--bg2)" : "#fff",
              cursor: "pointer",
            }}
          >
            {editing ? "✓" : "✏️"}
          </button>
        )}
      </div>
      {editing && editNode && (
        <div
          style={{
            padding: "6px 10px 10px 36px",
            background: "var(--bg)",
            borderTop: "1px dashed var(--border2)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {editNode}
        </div>
      )}
    </div>
  );
}

// Small inline-input helper used inside edit panels.
function EditInput({ label, value, onChange, placeholder, width = 120 }) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 2, marginRight: 8 }}>
      {label && (
        <span style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase" }}>
          {label}
        </span>
      )}
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width,
          fontSize: 12,
          padding: "4px 6px",
          border: "1px solid var(--border2)",
          borderRadius: 4,
          background: "#fff",
        }}
      />
    </label>
  );
}

function SectionHeaderControls({ onSelectAll, allSelected, someSelected }) {
  return (
    <div
      style={{
        padding: "4px 10px",
        background: "var(--bg)",
        fontSize: 10,
        color: "var(--t3)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        borderBottom: "1px solid var(--border2)",
      }}
    >
      <input
        type="checkbox"
        checked={allSelected}
        ref={(el) => el && (el.indeterminate = !allSelected && someSelected)}
        onChange={onSelectAll}
      />
      <span>Select all</span>
    </div>
  );
}

const ClinicalExtractionReviewModal = memo(function ClinicalExtractionReviewModal({
  extracted,
  doc_date,
  currentSymptoms = [],
  currentDiagnoses = [],
  currentMedications = [],
  onClose,
  onSave,
  saving,
}) {
  const existingSx = useMemo(
    () => new Set(currentSymptoms.map((s) => canonize(s.label || s.name))),
    [currentSymptoms],
  );
  const existingDx = useMemo(
    () => new Set(currentDiagnoses.map((d) => canonize(d.label || d.name))),
    [currentDiagnoses],
  );
  const medByName = useMemo(() => {
    const m = new Map();
    currentMedications.forEach((med) => m.set(canonize(med.name), med));
    return m;
  }, [currentMedications]);

  const symptomRows = useMemo(
    () =>
      (extracted?.symptoms || [])
        .filter((s) => s && s.name)
        .map((s) => ({ ...s, existing: existingSx.has(canonize(s.name)) })),
    [extracted, existingSx],
  );

  const diagnosisRows = useMemo(
    () =>
      (extracted?.diagnoses || [])
        .filter((d) => d && d.name)
        .map((d) => ({
          ...d,
          existing: existingDx.has(canonize(d.name)),
          absent: d.status === "Absent",
        })),
    [extracted, existingDx],
  );

  const medicationRows = useMemo(
    () =>
      (extracted?.medications || [])
        .filter((m) => m && m.name)
        .map((m) => {
          // For weekly/fortnightly meds, hydrate days_of_week so the doctor
          // sees a pre-selected weekday in the review modal. Preference order:
          //   1. AI-emitted m.days_of_week (when source text named a day)
          //   2. "· Mon, Wed" suffix already on frequency
          //   3. Weekday of doc_date (the prescription date itself)
          const weekly = isWeeklyFreq(m.frequency);
          const explicit = Array.isArray(m.days_of_week)
            ? m.days_of_week.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
            : [];
          const fromSuffix = parseSuffixDays(m.frequency);
          let days = explicit.length ? explicit : fromSuffix;
          if (!days.length && weekly) {
            const fortnight = /fortnight|14\s*days/i.test(m.frequency || "");
            if (!fortnight) {
              const w = weekdayOfIsoDate(doc_date);
              if (w != null) days = [w];
            }
          }
          return {
            ...m,
            frequency: stripDaysSuffix(m.frequency),
            days_of_week: days.length ? [...new Set(days)].sort((a, b) => a - b) : null,
            existing: medByName.has(canonize(m.name)),
          };
        }),
    [extracted, medByName, doc_date],
  );

  const prevMedRows = useMemo(
    () =>
      (extracted?.previous_medications || [])
        .filter((pm) => pm && pm.name)
        .map((pm) => {
          const match = medByName.get(canonize(pm.name));
          return {
            ...pm,
            matchedId: match?.id || null,
            matchedName: match?.name || null,
          };
        }),
    [extracted, medByName],
  );

  const labRows = useMemo(
    () =>
      (extracted?.labs || [])
        .filter((l) => l && l.test && l.value != null && String(l.value).trim() !== "")
        .filter((l) => !VITAL_NAME_RE.test(l.test))
        .map((l) => {
          const raw = String(l.value).trim();
          const isNumeric = /^-?\d+(\.\d+)?$/.test(raw);
          return {
            test_name: l.test,
            normalized: normalizeTestName(l.test),
            result: isNumeric ? parseFloat(raw) : null,
            result_text: raw,
            unit: l.unit || "",
            flag: null,
            ref_range: null,
            test_date: l.date || doc_date || null,
          };
        }),
    [extracted, doc_date],
  );

  const vitalRows = useMemo(
    () =>
      (extracted?.vitals || [])
        .map((v) => ({
          date: v.date || doc_date || null,
          bpSys: v.bpSys ?? null,
          bpDia: v.bpDia ?? null,
          weight: v.weight ?? null,
          height: v.height ?? null,
          bmi: v.bmi ?? null,
          waist: v.waist ?? null,
          bodyFat: v.bodyFat ?? null,
        }))
        .filter(
          (v) =>
            v.bpSys != null ||
            v.bpDia != null ||
            v.weight != null ||
            v.height != null ||
            v.bmi != null ||
            v.waist != null ||
            v.bodyFat != null,
        ),
    [extracted, doc_date],
  );

  const investigationRows = useMemo(
    () => (extracted?.investigations_to_order || []).filter((t) => t && t.name),
    [extracted],
  );

  // FOLLOW UP WITH — free-text prep instructions for the next visit (e.g.
  // "FASTING SAMPLE AT 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR
  // 24 HRS — FBG, HBA1C, LIPIDS"). Editable so doctor can tweak before save.
  const initialFollowUpWith =
    typeof extracted?.follow_up_with === "string" ? extracted.follow_up_with.trim() : "";
  const [followUpWithText, setFollowUpWithText] = useState(initialFollowUpWith);
  const [followUpWithChecked, setFollowUpWithChecked] = useState(initialFollowUpWith.length > 0);
  const hasFollowUpWith = initialFollowUpWith.length > 0;

  // Default selection: symptoms/dx/meds — everything not already in record; "Absent" dx off.
  // Prev-med stops: all off. Labs/vitals/investigations: all on.
  const [sel, setSel] = useState(() => ({
    symptoms: new Set(symptomRows.map((r, i) => (!r.existing ? i : -1)).filter((i) => i >= 0)),
    diagnoses: new Set(
      diagnosisRows.map((r, i) => (!r.existing && !r.absent ? i : -1)).filter((i) => i >= 0),
    ),
    medications: new Set(
      medicationRows.map((r, i) => (!r.existing ? i : -1)).filter((i) => i >= 0),
    ),
    stopMeds: new Set(),
    labs: new Set(labRows.map((_, i) => i)),
    vitals: new Set(vitalRows.map((_, i) => i)),
    investigations: new Set(investigationRows.map((_, i) => i)),
  }));

  // Per-row inline-edit overrides. Shape: overrides[section] = { [idx]: {...partial} }
  // The display merges row + overrides[section][idx], and Save also merges so
  // the edited values are what gets sent to the bulk endpoint.
  const [overrides, setOverrides] = useState({
    symptoms: {},
    diagnoses: {},
    medications: {},
    stopMeds: {},
    labs: {},
    vitals: {},
    investigations: {},
  });
  // Which row in each section is currently open in edit mode (-1 = none).
  const [editingIdx, setEditingIdx] = useState({
    symptoms: -1,
    diagnoses: -1,
    medications: -1,
    stopMeds: -1,
    labs: -1,
    vitals: -1,
    investigations: -1,
  });

  const merge = (section, i, row) => ({ ...row, ...(overrides[section]?.[i] || {}) });
  const setField = (section, i, field, value) =>
    setOverrides((o) => ({
      ...o,
      [section]: { ...o[section], [i]: { ...(o[section][i] || {}), [field]: value } },
    }));
  const toggleEdit = (section, i) =>
    setEditingIdx((s) => ({ ...s, [section]: s[section] === i ? -1 : i }));

  const [open, setOpen] = useState({
    symptoms: true,
    diagnoses: true,
    medications: true,
    prevMeds: prevMedRows.length > 0,
    labs: true,
    vitals: true,
    investigations: true,
  });

  const toggleItem = (section, i) =>
    setSel((s) => {
      const next = new Set(s[section]);
      next.has(i) ? next.delete(i) : next.add(i);
      return { ...s, [section]: next };
    });

  const toggleAll = (section, rows, selectable) => {
    setSel((s) => {
      const eligible = rows.map((_, i) => i).filter((i) => selectable(rows[i]));
      const allSelected = eligible.every((i) => s[section].has(i));
      return { ...s, [section]: allSelected ? new Set() : new Set(eligible) };
    });
  };

  const toggleOpen = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const handleSave = () => {
    onSave({
      symptoms: symptomRows
        .map((r, i) => merge("symptoms", i, r))
        .filter((_, i) => sel.symptoms.has(i)),
      diagnoses: diagnosisRows
        .map((r, i) => merge("diagnoses", i, r))
        .filter((_, i) => sel.diagnoses.has(i)),
      medications: medicationRows
        .map((r, i) => merge("medications", i, r))
        .filter((_, i) => sel.medications.has(i)),
      stopMeds: prevMedRows
        .map((r, i) => merge("stopMeds", i, r))
        .filter((pm, i) => pm.matchedId && sel.stopMeds.has(i))
        .map((pm) => ({
          id: pm.matchedId,
          name: pm.matchedName,
          reason: pm.reason || `AI: ${pm.status || "previous_medication"}`,
        })),
      labs: labRows.map((r, i) => merge("labs", i, r)).filter((_, i) => sel.labs.has(i)),
      vitals: vitalRows.map((r, i) => merge("vitals", i, r)).filter((_, i) => sel.vitals.has(i)),
      investigations: investigationRows
        .map((r, i) => merge("investigations", i, r))
        .filter((_, i) => sel.investigations.has(i)),
      // Empty string ⇒ doctor unchecked it / cleared the textarea → skip the
      // PATCH on save. Non-empty trimmed string ⇒ write through to the
      // consultation's con_data.follow_up_with via PATCH /follow-up-with.
      follow_up_with: followUpWithChecked && followUpWithText.trim() ? followUpWithText.trim() : "",
    });
  };

  const totals = {
    sx: { count: sel.symptoms.size, total: symptomRows.length },
    dx: { count: sel.diagnoses.size, total: diagnosisRows.length },
    meds: { count: sel.medications.size, total: medicationRows.length },
    prev: { count: sel.stopMeds.size, total: prevMedRows.filter((pm) => pm.matchedId).length },
    labs: { count: sel.labs.size, total: labRows.length },
    vit: { count: sel.vitals.size, total: vitalRows.length },
    inv: { count: sel.investigations.size, total: investigationRows.length },
  };

  const totalSelected =
    totals.sx.count +
    totals.dx.count +
    totals.meds.count +
    totals.prev.count +
    totals.labs.count +
    totals.vit.count +
    totals.inv.count;

  const followUpWithSelected = followUpWithChecked && followUpWithText.trim().length > 0 ? 1 : 0;

  const nothingExtracted =
    symptomRows.length === 0 &&
    diagnosisRows.length === 0 &&
    medicationRows.length === 0 &&
    prevMedRows.length === 0 &&
    labRows.length === 0 &&
    vitalRows.length === 0 &&
    investigationRows.length === 0 &&
    !hasFollowUpWith;

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 780, maxWidth: "95vw" }}>
        <div className="mttl">🧾 Review Extracted Clinical Notes</div>

        <div
          style={{
            display: "flex",
            gap: 12,
            marginBottom: 10,
            fontSize: 11,
            color: "var(--t3)",
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong style={{ color: "var(--t2)" }}>{totals.sx.count}</strong> symptoms
          </span>
          <span>
            <strong style={{ color: "var(--t2)" }}>{totals.dx.count}</strong> diagnoses
          </span>
          <span>
            <strong style={{ color: "var(--t2)" }}>{totals.meds.count}</strong> meds
          </span>
          {totals.prev.total > 0 && (
            <span>
              <strong style={{ color: "var(--t2)" }}>{totals.prev.count}</strong> stops
            </span>
          )}
          <span>
            <strong style={{ color: "var(--t2)" }}>{totals.labs.count}</strong> labs
          </span>
          <span>
            <strong style={{ color: "var(--t2)" }}>{totals.vit.count}</strong> vitals
          </span>
          <span>
            <strong style={{ color: "var(--t2)" }}>{totals.inv.count}</strong> tests
          </span>
        </div>

        {nothingExtracted ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: "var(--t3)", fontSize: 13 }}>
            No clinical data could be extracted from this note.
          </div>
        ) : (
          <div style={{ maxHeight: "60vh", overflowY: "auto", paddingRight: 4 }}>
            {symptomRows.length > 0 && (
              <Section
                title="🩹 Symptoms"
                count={totals.sx.count}
                total={totals.sx.total}
                open={open.symptoms}
                onToggle={() => toggleOpen("symptoms")}
              >
                <SectionHeaderControls
                  allSelected={sel.symptoms.size === symptomRows.filter((r) => !r.existing).length}
                  someSelected={sel.symptoms.size > 0}
                  onSelectAll={() => toggleAll("symptoms", symptomRows, (r) => !r.existing)}
                />
                {symptomRows.map((row, i) => {
                  const r = merge("symptoms", i, row);
                  return (
                    <Row
                      key={i}
                      checked={sel.symptoms.has(i)}
                      disabled={row.existing}
                      muted={row.existing}
                      onToggle={() => !row.existing && toggleItem("symptoms", i)}
                      editable={!row.existing}
                      editing={editingIdx.symptoms === i}
                      onToggleEdit={() => toggleEdit("symptoms", i)}
                      left={
                        <>
                          <strong>{r.name}</strong>
                          {r.severity ? ` · ${r.severity}` : ""}
                          {r.duration ? ` · ${r.duration}` : ""}
                          {r.related_to ? ` · ${r.related_to}` : ""}
                          {row.existing && (
                            <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                              (already in record)
                            </span>
                          )}
                        </>
                      }
                      editNode={
                        <>
                          <EditInput
                            label="Name"
                            value={r.name}
                            onChange={(v) => setField("symptoms", i, "name", v)}
                            width={180}
                          />
                          <EditInput
                            label="Severity"
                            value={r.severity}
                            onChange={(v) => setField("symptoms", i, "severity", v)}
                          />
                          <EditInput
                            label="Related to"
                            value={r.related_to}
                            onChange={(v) => setField("symptoms", i, "related_to", v)}
                            width={160}
                          />
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {diagnosisRows.length > 0 && (
              <Section
                title="🏷 Diagnoses"
                count={totals.dx.count}
                total={totals.dx.total}
                open={open.diagnoses}
                onToggle={() => toggleOpen("diagnoses")}
              >
                <SectionHeaderControls
                  allSelected={
                    sel.diagnoses.size ===
                    diagnosisRows.filter((r) => !r.existing && !r.absent).length
                  }
                  someSelected={sel.diagnoses.size > 0}
                  onSelectAll={() =>
                    toggleAll("diagnoses", diagnosisRows, (r) => !r.existing && !r.absent)
                  }
                />
                {diagnosisRows.map((row, i) => {
                  const r = merge("diagnoses", i, row);
                  return (
                    <Row
                      key={i}
                      checked={sel.diagnoses.has(i)}
                      disabled={row.existing}
                      muted={row.existing}
                      onToggle={() => !row.existing && toggleItem("diagnoses", i)}
                      editable={!row.existing}
                      editing={editingIdx.diagnoses === i}
                      onToggleEdit={() => toggleEdit("diagnoses", i)}
                      left={
                        <>
                          <strong>{r.name}</strong>
                          {r.details ? ` · ${r.details}` : ""}
                          {r.since ? ` · Since ${r.since}` : ""}
                          {r.absent && (
                            <span
                              style={{
                                marginLeft: 8,
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: "var(--bg2)",
                                color: "var(--t3)",
                                fontSize: 10,
                                fontWeight: 600,
                              }}
                            >
                              ABSENT
                            </span>
                          )}
                          {row.existing && (
                            <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                              (already in record)
                            </span>
                          )}
                        </>
                      }
                      editNode={
                        <>
                          <EditInput
                            label="Name"
                            value={r.name}
                            onChange={(v) => setField("diagnoses", i, "name", v)}
                            width={200}
                          />
                          <EditInput
                            label="Details"
                            value={r.details}
                            onChange={(v) => setField("diagnoses", i, "details", v)}
                            width={200}
                          />
                          <EditInput
                            label="Since"
                            value={r.since}
                            onChange={(v) => setField("diagnoses", i, "since", v)}
                          />
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {medicationRows.length > 0 && (
              <Section
                title="💊 Medications"
                count={totals.meds.count}
                total={totals.meds.total}
                open={open.medications}
                onToggle={() => toggleOpen("medications")}
              >
                <SectionHeaderControls
                  allSelected={
                    sel.medications.size === medicationRows.filter((r) => !r.existing).length
                  }
                  someSelected={sel.medications.size > 0}
                  onSelectAll={() => toggleAll("medications", medicationRows, (r) => !r.existing)}
                />
                {medicationRows.map((row, i) => {
                  const r = merge("medications", i, row);
                  const showDays = isWeeklyFreq(r.frequency);
                  const selectedDays = Array.isArray(r.days_of_week) ? r.days_of_week : [];
                  const daysLabel = selectedDays
                    .slice()
                    .sort((a, b) => a - b)
                    .map((n) => INT_TO_WEEKDAY[n])
                    .filter(Boolean)
                    .join(", ");
                  const toggleDay = (token) => {
                    const n = WEEKDAY_TO_INT[token];
                    if (typeof n !== "number") return;
                    const set = new Set(selectedDays);
                    set.has(n) ? set.delete(n) : set.add(n);
                    setField(
                      "medications",
                      i,
                      "days_of_week",
                      [...set].sort((a, b) => a - b),
                    );
                  };
                  return (
                    <Row
                      key={i}
                      checked={sel.medications.has(i)}
                      disabled={row.existing}
                      muted={row.existing}
                      onToggle={() => !row.existing && toggleItem("medications", i)}
                      editable={!row.existing}
                      editing={editingIdx.medications === i}
                      onToggleEdit={() => toggleEdit("medications", i)}
                      editNode={
                        <>
                          <EditInput
                            label="Name"
                            value={r.name}
                            onChange={(v) => setField("medications", i, "name", v)}
                            width={160}
                          />
                          <EditInput
                            label="Dose"
                            value={r.dose}
                            onChange={(v) => setField("medications", i, "dose", v)}
                            width={120}
                          />
                          <EditInput
                            label="Freq"
                            value={r.frequency}
                            onChange={(v) => setField("medications", i, "frequency", v)}
                            width={80}
                          />
                          <EditInput
                            label="When to take"
                            value={formatWhenToTake(r.when_to_take)}
                            onChange={(v) =>
                              setField("medications", i, "when_to_take", toWhenToTakeArray(v))
                            }
                            placeholder="After breakfast, After dinner"
                            width={220}
                          />
                          <EditInput
                            label="Note"
                            value={r.timing}
                            onChange={(v) => setField("medications", i, "timing", v)}
                            width={140}
                          />
                          <EditInput
                            label="Route"
                            value={r.route}
                            onChange={(v) => setField("medications", i, "route", v)}
                            width={80}
                          />
                          {showDays && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                marginTop: 6,
                                width: "100%",
                              }}
                            >
                              <div style={{ fontSize: 11, color: "var(--t3)" }}>
                                On which day{selectedDays.length > 1 ? "s" : ""}
                              </div>
                              <div className="time-pills">
                                {WEEKDAYS.map((d) => {
                                  const n = WEEKDAY_TO_INT[d];
                                  return (
                                    <label key={d}>
                                      <input
                                        type="checkbox"
                                        checked={selectedDays.includes(n)}
                                        onChange={() => toggleDay(d)}
                                      />
                                      <span>{d}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </>
                      }
                      left={
                        <>
                          <strong>{r.name}</strong>
                          {r.dose ? ` · ${r.dose}` : ""}
                          {r.frequency ? ` · ${r.frequency}` : ""}
                          {showDays && daysLabel ? ` · ${daysLabel}` : ""}
                          {formatWhenToTake(r.when_to_take)
                            ? ` · ${formatWhenToTake(r.when_to_take)}`
                            : ""}
                          {r.timing && r.timing !== formatWhenToTake(r.when_to_take)
                            ? ` (${r.timing})`
                            : ""}
                          {r.route && r.route !== "Oral" ? ` · ${r.route}` : ""}
                          {row.existing && (
                            <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                              (already active)
                            </span>
                          )}
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {prevMedRows.length > 0 && (
              <Section
                title="🛑 Previous Medications (stop?)"
                count={totals.prev.count}
                total={totals.prev.total}
                open={open.prevMeds}
                onToggle={() => toggleOpen("prevMeds")}
              >
                {prevMedRows.map((row, i) => {
                  const pm = merge("stopMeds", i, row);
                  return pm.matchedId ? (
                    <Row
                      key={i}
                      checked={sel.stopMeds.has(i)}
                      onToggle={() => toggleItem("stopMeds", i)}
                      editable
                      editing={editingIdx.stopMeds === i}
                      onToggleEdit={() => toggleEdit("stopMeds", i)}
                      left={
                        <>
                          <strong>Stop: {pm.matchedName}</strong>
                          {pm.dose ? ` · was ${pm.dose}` : ""}
                          {pm.reason ? ` · ${pm.reason}` : pm.status ? ` · ${pm.status}` : ""}
                        </>
                      }
                      editNode={
                        <EditInput
                          label="Reason"
                          value={pm.reason}
                          onChange={(v) => setField("stopMeds", i, "reason", v)}
                          width={260}
                        />
                      }
                    />
                  ) : (
                    <Row
                      key={i}
                      checked={false}
                      disabled
                      muted
                      onToggle={() => {}}
                      left={
                        <>
                          <strong>{pm.name}</strong>
                          {pm.dose ? ` · ${pm.dose}` : ""}
                          <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                            (not in current meds — no action)
                          </span>
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {labRows.length > 0 && (
              <Section
                title="🧪 Lab Values"
                count={totals.labs.count}
                total={totals.labs.total}
                open={open.labs}
                onToggle={() => toggleOpen("labs")}
              >
                <SectionHeaderControls
                  allSelected={sel.labs.size === labRows.length}
                  someSelected={sel.labs.size > 0}
                  onSelectAll={() => toggleAll("labs", labRows, () => true)}
                />
                {labRows.map((row, i) => {
                  const r = merge("labs", i, row);
                  return (
                    <Row
                      key={i}
                      checked={sel.labs.has(i)}
                      onToggle={() => toggleItem("labs", i)}
                      editable
                      editing={editingIdx.labs === i}
                      onToggleEdit={() => toggleEdit("labs", i)}
                      left={
                        <>
                          <strong>{r.normalized || r.test_name}</strong>
                          {r.normalized && r.normalized !== r.test_name && (
                            <span style={{ color: "var(--t4)", marginLeft: 6, fontSize: 11 }}>
                              ({r.test_name})
                            </span>
                          )}
                        </>
                      }
                      right={
                        <>
                          <strong style={{ color: "var(--t1)" }}>{r.result_text}</strong>
                          {r.unit ? ` ${r.unit}` : ""}
                          {r.test_date ? ` · ${fmtDateShort(r.test_date)}` : ""}
                        </>
                      }
                      editNode={
                        <>
                          <EditInput
                            label="Test"
                            value={r.test_name}
                            onChange={(v) => setField("labs", i, "test_name", v)}
                            width={160}
                          />
                          <EditInput
                            label="Value"
                            value={r.result_text}
                            onChange={(v) => setField("labs", i, "result_text", v)}
                            width={100}
                          />
                          <EditInput
                            label="Unit"
                            value={r.unit}
                            onChange={(v) => setField("labs", i, "unit", v)}
                            width={80}
                          />
                          <EditInput
                            label="Date (YYYY-MM-DD)"
                            value={r.test_date}
                            onChange={(v) => setField("labs", i, "test_date", v)}
                            width={140}
                          />
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {vitalRows.length > 0 && (
              <Section
                title="📈 Dated Vitals"
                count={totals.vit.count}
                total={totals.vit.total}
                open={open.vitals}
                onToggle={() => toggleOpen("vitals")}
              >
                <SectionHeaderControls
                  allSelected={sel.vitals.size === vitalRows.length}
                  someSelected={sel.vitals.size > 0}
                  onSelectAll={() => toggleAll("vitals", vitalRows, () => true)}
                />
                {vitalRows.map((row, i) => {
                  const v = merge("vitals", i, row);
                  const parts = [];
                  if (v.bpSys && v.bpDia) parts.push(`BP ${v.bpSys}/${v.bpDia}`);
                  if (v.weight != null && v.weight !== "") parts.push(`Wt ${v.weight}`);
                  if (v.height != null && v.height !== "") parts.push(`Ht ${v.height}`);
                  if (v.bmi != null && v.bmi !== "") parts.push(`BMI ${v.bmi}`);
                  if (v.waist != null && v.waist !== "") parts.push(`WC ${v.waist}`);
                  if (v.bodyFat != null && v.bodyFat !== "") parts.push(`BF ${v.bodyFat}`);
                  const numOrNull = (s) => {
                    if (s === "" || s == null) return null;
                    const n = Number(s);
                    return Number.isFinite(n) ? n : s;
                  };
                  return (
                    <Row
                      key={i}
                      checked={sel.vitals.has(i)}
                      onToggle={() => toggleItem("vitals", i)}
                      editable
                      editing={editingIdx.vitals === i}
                      onToggleEdit={() => toggleEdit("vitals", i)}
                      left={<strong>{parts.join(" · ")}</strong>}
                      right={v.date ? fmtDateShort(v.date) : "—"}
                      editNode={
                        <>
                          <EditInput
                            label="BP Sys"
                            value={v.bpSys}
                            onChange={(x) => setField("vitals", i, "bpSys", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="BP Dia"
                            value={v.bpDia}
                            onChange={(x) => setField("vitals", i, "bpDia", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="Wt"
                            value={v.weight}
                            onChange={(x) => setField("vitals", i, "weight", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="Ht"
                            value={v.height}
                            onChange={(x) => setField("vitals", i, "height", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="BMI"
                            value={v.bmi}
                            onChange={(x) => setField("vitals", i, "bmi", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="WC"
                            value={v.waist}
                            onChange={(x) => setField("vitals", i, "waist", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="BF"
                            value={v.bodyFat}
                            onChange={(x) => setField("vitals", i, "bodyFat", numOrNull(x))}
                            width={70}
                          />
                          <EditInput
                            label="Date"
                            value={v.date}
                            onChange={(x) => setField("vitals", i, "date", x)}
                            width={120}
                          />
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}

            {hasFollowUpWith && (
              <div
                style={{
                  border: "1px solid var(--border2)",
                  borderRadius: "var(--rs)",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    background: "var(--bg2)",
                    borderBottom: "1px solid var(--border2)",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={followUpWithChecked}
                    onChange={() => setFollowUpWithChecked((v) => !v)}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)" }}>
                    📝 Follow Up With (prep for next visit)
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t3)" }}>
                    {followUpWithSelected}/1
                  </span>
                </div>
                <div style={{ padding: "8px 10px" }}>
                  <textarea
                    value={followUpWithText}
                    onChange={(e) => setFollowUpWithText(e.target.value)}
                    disabled={!followUpWithChecked}
                    style={{
                      width: "100%",
                      minHeight: 70,
                      resize: "vertical",
                      fontFamily: "monospace",
                      fontSize: 12,
                      padding: 8,
                      border: "1px solid var(--border2)",
                      borderRadius: "var(--rs)",
                      background: followUpWithChecked ? "#fff" : "var(--bg2)",
                      color: followUpWithChecked ? "var(--t1)" : "var(--t3)",
                    }}
                  />
                </div>
              </div>
            )}

            {investigationRows.length > 0 && (
              <Section
                title="🔬 Tests / Investigations Ordered"
                count={totals.inv.count}
                total={totals.inv.total}
                open={open.investigations}
                onToggle={() => toggleOpen("investigations")}
              >
                <SectionHeaderControls
                  allSelected={sel.investigations.size === investigationRows.length}
                  someSelected={sel.investigations.size > 0}
                  onSelectAll={() => toggleAll("investigations", investigationRows, () => true)}
                />
                {investigationRows.map((row, i) => {
                  const r = merge("investigations", i, row);
                  return (
                    <Row
                      key={i}
                      checked={sel.investigations.has(i)}
                      onToggle={() => toggleItem("investigations", i)}
                      editable
                      editing={editingIdx.investigations === i}
                      onToggleEdit={() => toggleEdit("investigations", i)}
                      left={<strong>{r.name}</strong>}
                      right={r.urgency || "routine"}
                      editNode={
                        <>
                          <EditInput
                            label="Name"
                            value={r.name}
                            onChange={(v) => setField("investigations", i, "name", v)}
                            width={200}
                          />
                          <EditInput
                            label="Urgency"
                            value={r.urgency}
                            onChange={(v) => setField("investigations", i, "urgency", v)}
                            width={100}
                          />
                        </>
                      }
                    />
                  );
                })}
              </Section>
            )}
          </div>
        )}

        <div className="macts" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose} disabled={saving}>
            Discard
          </button>
          <button
            className="btn-p"
            disabled={totalSelected === 0 && followUpWithSelected === 0}
            onClick={handleSave}
          >
            {`Save ${totalSelected + followUpWithSelected} item${
              totalSelected + followUpWithSelected !== 1 ? "s" : ""
            }`}
          </button>
        </div>
      </div>
    </div>
  );
});

export default ClinicalExtractionReviewModal;
