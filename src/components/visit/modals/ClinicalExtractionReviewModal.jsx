import { memo, useMemo, useState } from "react";
import { normalizeTestName } from "../../../config/labNormalization";
import { fmtDateShort } from "../helpers";

const canonize = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

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

function Row({ checked, onToggle, disabled, left, right, muted }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid var(--border2)",
        opacity: disabled ? 0.55 : checked ? 1 : 0.5,
        cursor: disabled ? "default" : "pointer",
        fontSize: 12,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        style={{ flexShrink: 0 }}
      />
      <div style={{ flex: 1, color: muted ? "var(--t3)" : "var(--t1)" }}>{left}</div>
      {right && (
        <div style={{ color: "var(--t3)", fontSize: 11, whiteSpace: "nowrap" }}>{right}</div>
      )}
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
        .map((m) => ({ ...m, existing: medByName.has(canonize(m.name)) })),
    [extracted, medByName],
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
      symptoms: symptomRows.filter((_, i) => sel.symptoms.has(i)),
      diagnoses: diagnosisRows.filter((_, i) => sel.diagnoses.has(i)),
      medications: medicationRows.filter((_, i) => sel.medications.has(i)),
      stopMeds: prevMedRows
        .filter((pm, i) => pm.matchedId && sel.stopMeds.has(i))
        .map((pm) => ({
          id: pm.matchedId,
          name: pm.matchedName,
          reason: pm.reason || `AI: ${pm.status || "previous_medication"}`,
        })),
      labs: labRows.filter((_, i) => sel.labs.has(i)),
      vitals: vitalRows.filter((_, i) => sel.vitals.has(i)),
      investigations: investigationRows.filter((_, i) => sel.investigations.has(i)),
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

  const nothingExtracted =
    symptomRows.length === 0 &&
    diagnosisRows.length === 0 &&
    medicationRows.length === 0 &&
    prevMedRows.length === 0 &&
    labRows.length === 0 &&
    vitalRows.length === 0 &&
    investigationRows.length === 0;

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
                {symptomRows.map((r, i) => (
                  <Row
                    key={i}
                    checked={sel.symptoms.has(i)}
                    disabled={r.existing}
                    muted={r.existing}
                    onToggle={() => !r.existing && toggleItem("symptoms", i)}
                    left={
                      <>
                        <strong>{r.name}</strong>
                        {r.severity ? ` · ${r.severity}` : ""}
                        {r.duration ? ` · ${r.duration}` : ""}
                        {r.related_to ? ` · ${r.related_to}` : ""}
                        {r.existing && (
                          <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                            (already in record)
                          </span>
                        )}
                      </>
                    }
                  />
                ))}
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
                {diagnosisRows.map((r, i) => (
                  <Row
                    key={i}
                    checked={sel.diagnoses.has(i)}
                    disabled={r.existing}
                    muted={r.existing}
                    onToggle={() => !r.existing && toggleItem("diagnoses", i)}
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
                        {r.existing && (
                          <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                            (already in record)
                          </span>
                        )}
                      </>
                    }
                  />
                ))}
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
                {medicationRows.map((r, i) => (
                  <Row
                    key={i}
                    checked={sel.medications.has(i)}
                    disabled={r.existing}
                    muted={r.existing}
                    onToggle={() => !r.existing && toggleItem("medications", i)}
                    left={
                      <>
                        <strong>{r.name}</strong>
                        {r.dose ? ` · ${r.dose}` : ""}
                        {r.frequency ? ` · ${r.frequency}` : ""}
                        {r.timing ? ` · ${r.timing}` : ""}
                        {r.route && r.route !== "Oral" ? ` · ${r.route}` : ""}
                        {r.existing && (
                          <span style={{ marginLeft: 8, color: "var(--t4)" }}>
                            (already active)
                          </span>
                        )}
                      </>
                    }
                  />
                ))}
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
                {prevMedRows.map((pm, i) =>
                  pm.matchedId ? (
                    <Row
                      key={i}
                      checked={sel.stopMeds.has(i)}
                      onToggle={() => toggleItem("stopMeds", i)}
                      left={
                        <>
                          <strong>Stop: {pm.matchedName}</strong>
                          {pm.dose ? ` · was ${pm.dose}` : ""}
                          {pm.reason ? ` · ${pm.reason}` : pm.status ? ` · ${pm.status}` : ""}
                        </>
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
                  ),
                )}
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
                {labRows.map((r, i) => (
                  <Row
                    key={i}
                    checked={sel.labs.has(i)}
                    onToggle={() => toggleItem("labs", i)}
                    left={
                      <>
                        <strong>{r.normalized}</strong>
                        {r.normalized !== r.test_name && (
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
                  />
                ))}
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
                {vitalRows.map((v, i) => {
                  const parts = [];
                  if (v.bpSys && v.bpDia) parts.push(`BP ${v.bpSys}/${v.bpDia}`);
                  if (v.weight != null) parts.push(`Wt ${v.weight}`);
                  if (v.height != null) parts.push(`Ht ${v.height}`);
                  if (v.bmi != null) parts.push(`BMI ${v.bmi}`);
                  if (v.waist != null) parts.push(`WC ${v.waist}`);
                  if (v.bodyFat != null) parts.push(`BF ${v.bodyFat}`);
                  return (
                    <Row
                      key={i}
                      checked={sel.vitals.has(i)}
                      onToggle={() => toggleItem("vitals", i)}
                      left={<strong>{parts.join(" · ")}</strong>}
                      right={v.date ? fmtDateShort(v.date) : "—"}
                    />
                  );
                })}
              </Section>
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
                {investigationRows.map((r, i) => (
                  <Row
                    key={i}
                    checked={sel.investigations.has(i)}
                    onToggle={() => toggleItem("investigations", i)}
                    left={<strong>{r.name}</strong>}
                    right={r.urgency || "routine"}
                  />
                ))}
              </Section>
            )}
          </div>
        )}

        <div className="macts" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose} disabled={saving}>
            Discard
          </button>
          <button className="btn-p" disabled={totalSelected === 0 || saving} onClick={handleSave}>
            {saving ? "Saving…" : `Save ${totalSelected} item${totalSelected !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
});

export default ClinicalExtractionReviewModal;
