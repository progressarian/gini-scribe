import { memo, useState, useMemo } from "react";
import { fmtDate } from "./helpers";
import { cleanNote } from "../../utils/cleanNote";

/* ── tiny helpers ── */
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
const avg = (arr, key) => {
  const nums = arr.map((r) => parseFloat(r[key])).filter((v) => !isNaN(v));
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
};
const bpColor = (s, d) => {
  if (s >= 180 || d >= 120) return "var(--red)";
  if (s >= 140 || d >= 90) return "var(--amber)";
  return "var(--text)";
};
const rbsColor = (v) => (v > 180 ? "var(--red)" : v > 140 ? "var(--amber)" : "var(--text)");
const sevColor = (s) => (s > 6 ? "var(--red)" : s > 3 ? "var(--amber)" : "var(--green)");
const sevLabel = (s) => (s > 6 ? "Severe" : s > 3 ? "Moderate" : "Mild");

/* ── Section sub-components ── */

function SummaryCards({ vitals, activity, meds, meals, symptoms }) {
  // Med adherence: unique days with at least one dose logged / 30
  const medDays = new Set((meds || []).map((m) => m.log_date)).size;
  const adherence = pct(medDays, 30);

  // Exercise stats
  const exercises = (activity || []).filter((a) => a.activity_type === "Exercise");
  const exDays = new Set(exercises.map((e) => e.log_date)).size;
  const totalExMin = exercises.reduce((s, a) => s + (parseFloat(a.duration_minutes) || 0), 0);

  // Sleep average
  const sleepLogs = (activity || []).filter((a) => a.activity_type === "Sleep");
  const avgSleep =
    sleepLogs.length > 0
      ? (sleepLogs.reduce((s, a) => s + (parseFloat(a.value) || 0), 0) / sleepLogs.length).toFixed(
          1,
        )
      : null;

  // Mood average
  const moodLogs = (activity || []).filter((a) => a.activity_type === "Mood");
  const avgMood = moodLogs.length > 0 ? avg(moodLogs, "mood_score") : null;

  // Vitals count
  const vitalsCount = vitals?.length || 0;

  // Symptom count
  const symptomCount = symptoms?.length || 0;

  return (
    <div className="ld-summary">
      <div className="log-card">
        <div
          className="log-val"
          style={{ color: adherence >= 80 ? "var(--green)" : "var(--amber)" }}
        >
          {adherence}%
        </div>
        <div className="log-lbl">Med Adherence</div>
        <div className="log-sub">{medDays}/30 days logged</div>
      </div>
      <div className="log-card">
        <div className="log-val" style={{ color: "var(--blue)" }}>
          {vitalsCount}
        </div>
        <div className="log-lbl">Vitals Logged</div>
        <div className="log-sub">BP, Sugar, Weight etc.</div>
      </div>
      <div className="log-card">
        <div className="log-val" style={{ color: exDays >= 5 ? "var(--green)" : "var(--amber)" }}>
          {exDays}
        </div>
        <div className="log-lbl">Exercise Days</div>
        <div className="log-sub">{Math.round(totalExMin)} min total</div>
      </div>
      <div className="log-card">
        <div className="log-val" style={{ color: "var(--green)" }}>
          {meals?.length || 0}
        </div>
        <div className="log-lbl">Meals Logged</div>
        <div className="log-sub">Self-reported</div>
      </div>
      {avgSleep && (
        <div className="log-card">
          <div
            className="log-val"
            style={{ color: parseFloat(avgSleep) >= 7 ? "var(--green)" : "var(--amber)" }}
          >
            {avgSleep}h
          </div>
          <div className="log-lbl">Avg Sleep</div>
          <div className="log-sub">{sleepLogs.length} nights logged</div>
        </div>
      )}
      {avgMood !== null && (
        <div className="log-card">
          <div
            className="log-val"
            style={{
              color: avgMood >= 7 ? "var(--green)" : avgMood >= 4 ? "var(--amber)" : "var(--red)",
            }}
          >
            {avgMood}/10
          </div>
          <div className="log-lbl">Avg Mood</div>
          <div className="log-sub">{moodLogs.length} entries</div>
        </div>
      )}
    </div>
  );
}

function VitalsTable({ vitals, limit }) {
  const rows = limit ? vitals.slice(0, limit) : vitals;
  // Grid template for 9 columns — keeps the header and body aligned even
  // though ld-vital-cols (a 7-col helper) isn't wide enough anymore.
  const cols = "0.8fr 0.9fr 0.7fr 0.7fr 0.7fr 0.7fr 0.5fr 0.6fr 0.8fr";
  return (
    <div className="ld-table-wrap">
      <div className="ld-tbl-head" style={{ gridTemplateColumns: cols }}>
        <span>Date</span>
        <span>BP</span>
        <span>Sugar (RBS)</span>
        <span>Weight</span>
        <span>Body Fat</span>
        <span>Muscle</span>
        <span>Pulse</span>
        <span>SpO2</span>
        <span>Type</span>
      </div>
      {rows.map((v, i) => (
        <div key={v.id || i} className="ld-tbl-row" style={{ gridTemplateColumns: cols }}>
          <span>{fmtDate(v.recorded_date)}</span>
          <span
            style={{
              color: v.bp_systolic ? bpColor(v.bp_systolic, v.bp_diastolic) : "var(--t3)",
              fontWeight: v.bp_systolic ? 600 : 400,
            }}
          >
            {v.bp_systolic && v.bp_diastolic ? `${v.bp_systolic}/${v.bp_diastolic}` : "—"}
          </span>
          <span style={{ fontWeight: 700, color: v.rbs ? rbsColor(v.rbs) : "var(--t3)" }}>
            {v.rbs || "—"}
          </span>
          <span>{v.weight_kg ? `${v.weight_kg} kg` : "—"}</span>
          <span>{v.body_fat != null ? `${v.body_fat}%` : "—"}</span>
          <span>{v.muscle_mass != null ? `${v.muscle_mass} kg` : "—"}</span>
          <span>{v.pulse || "—"}</span>
          <span>{v.spo2 ? `${v.spo2}%` : "—"}</span>
          <span style={{ color: "var(--t3)" }}>{v.meal_type || ""}</span>
        </div>
      ))}
    </div>
  );
}

function MedAdherenceTable({ meds, limit }) {
  const rows = limit ? meds.slice(0, limit) : meds;
  return (
    <div className="ld-table-wrap">
      <div className="ld-tbl-head ld-med-cols">
        <span>Date</span>
        <span>Medication</span>
        <span>Dose</span>
        <span>Time</span>
        <span>Status</span>
      </div>
      {rows.map((m, i) => (
        <div key={m.id || i} className="ld-tbl-row ld-med-cols">
          <span>{fmtDate(m.log_date)}</span>
          <span style={{ fontWeight: 600 }}>{m.medication_name || "—"}</span>
          <span style={{ color: "var(--t2)" }}>{m.medication_dose || "—"}</span>
          <span style={{ color: "var(--t3)" }}>{m.dose_time || "—"}</span>
          <span style={{ color: "var(--green)", fontWeight: 600 }}>
            {m.status === "taken" ? "Taken" : m.status || "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivitySection({ activity, limit }) {
  const exercises = (activity || []).filter((a) => a.activity_type === "Exercise");
  const sleepLogs = (activity || []).filter((a) => a.activity_type === "Sleep");
  const moodLogs = (activity || []).filter((a) => a.activity_type === "Mood");

  const exRows = limit ? exercises.slice(0, limit) : exercises;
  const sleepRows = limit ? sleepLogs.slice(0, limit) : sleepLogs;
  const moodRows = limit ? moodLogs.slice(0, limit) : moodLogs;

  return (
    <>
      {exRows.length > 0 && (
        <>
          <div className="ld-sub-label">Exercise</div>
          <div className="ld-table-wrap">
            <div className="ld-tbl-head ld-act-cols">
              <span>Date</span>
              <span>Activity</span>
              <span>Duration</span>
              <span>Details</span>
            </div>
            {exRows.map((a, i) => (
              <div key={a.id || i} className="ld-tbl-row ld-act-cols">
                <span>{fmtDate(a.log_date)}</span>
                <span style={{ fontWeight: 600 }}>{a.value || a.context || "Exercise"}</span>
                <span>{a.duration_minutes ? `${Math.round(a.duration_minutes)} min` : "—"}</span>
                <span style={{ color: "var(--t3)" }}>{a.value2 || a.context || ""}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {sleepRows.length > 0 && (
        <>
          <div className="ld-sub-label">Sleep</div>
          <div className="ld-act-grid">
            {sleepRows.map((s, i) => (
              <div key={s.id || i} className="ld-act-chip">
                <span className="ld-act-dt">{fmtDate(s.log_date)}</span>
                <span
                  className="ld-act-val"
                  style={{
                    color: parseFloat(s.value) >= 7 ? "var(--green)" : "var(--amber)",
                  }}
                >
                  {s.value}h
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {moodRows.length > 0 && (
        <>
          <div className="ld-sub-label">Mood</div>
          <div className="ld-act-grid">
            {moodRows.map((m, i) => {
              const score = parseFloat(m.mood_score || m.value) || 0;
              return (
                <div key={m.id || i} className="ld-act-chip">
                  <span className="ld-act-dt">{fmtDate(m.log_date)}</span>
                  <span
                    className="ld-act-val"
                    style={{
                      color:
                        score >= 7 ? "var(--green)" : score >= 4 ? "var(--amber)" : "var(--red)",
                    }}
                  >
                    {score}/10
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {exRows.length === 0 && sleepRows.length === 0 && moodRows.length === 0 && (
        <div className="ld-empty">No activity data logged</div>
      )}
    </>
  );
}

function SymptomsSection({ symptoms, limit }) {
  const rows = limit ? symptoms.slice(0, limit) : symptoms;
  return (
    <div className="ld-symptom-list">
      {rows.map((s, i) => (
        <div key={s.id || i} className="ld-symptom-item">
          <div className="sy-dot" style={{ background: sevColor(s.severity) }} />
          <div style={{ flex: 1 }}>
            <div className="sy-nm">
              {s.symptom}
              <span
                className="ld-sev-badge"
                style={{ background: sevColor(s.severity), color: "#fff" }}
              >
                {sevLabel(s.severity)} ({s.severity}/10)
              </span>
            </div>
            <div className="sy-meta">
              {fmtDate(s.log_date)}
              {s.body_area ? ` · ${s.body_area}` : ""}
              {s.context ? ` · ${s.context}` : ""}
            </div>
            {cleanNote(s.notes) && <div className="ld-symptom-note">{cleanNote(s.notes)}</div>}
            {s.follow_up_needed && <div className="ld-followup-tag">Follow-up needed</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function MealsTable({ meals, limit }) {
  const rows = limit ? meals.slice(0, limit) : meals;
  return (
    <div className="ld-table-wrap">
      <div className="ld-tbl-head ld-meal-cols">
        <span>Date</span>
        <span>Meal</span>
        <span>Description</span>
        <span>Calories</span>
        <span>Protein</span>
        <span>Carbs</span>
        <span>Fat</span>
      </div>
      {rows.map((m, i) => (
        <div key={m.id || i} className="ld-tbl-row ld-meal-cols">
          <span>{fmtDate(m.log_date || m.meal_date)}</span>
          <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{m.meal_type || "—"}</span>
          <span style={{ color: "var(--t2)" }}>{m.description || m.food_items || "—"}</span>
          <span style={{ fontWeight: 600 }}>{m.calories ? `${m.calories}` : "—"}</span>
          <span>{m.protein_g ? `${m.protein_g}g` : "—"}</span>
          <span>{m.carbs_g ? `${m.carbs_g}g` : "—"}</span>
          <span>{m.fat_g ? `${m.fat_g}g` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

// Medicines the patient has added in the Genie app — shown even when no
// dose has been logged yet. This is how a "Test Med (Track Sync)" surfaces
// on the web side.
function PatientMedicationsTable({ medications, limit }) {
  const rows = limit ? medications.slice(0, limit) : medications;
  return (
    <div className="ld-table-wrap">
      <div
        className="ld-tbl-head"
        style={{ gridTemplateColumns: "1.5fr 0.9fr 1fr 1.3fr 0.7fr 0.8fr" }}
      >
        <span>Name</span>
        <span>Dose</span>
        <span>Frequency</span>
        <span>Instructions</span>
        <span>Status</span>
        <span>Source</span>
      </div>
      {rows.map((m, i) => (
        <div
          key={m.id || i}
          className="ld-tbl-row"
          style={{ gridTemplateColumns: "1.5fr 0.9fr 1fr 1.3fr 0.7fr 0.8fr" }}
        >
          <span style={{ fontWeight: 600 }}>{m.name || "—"}</span>
          <span style={{ color: "var(--t2)" }}>{m.dose || "—"}</span>
          <span style={{ color: "var(--t2)" }}>
            {m.frequency ||
              (Array.isArray(m.when_to_take) ? m.when_to_take.join(", ") : m.when_to_take) ||
              m.timing ||
              "—"}
          </span>
          <span style={{ color: "var(--t3)", fontSize: 12 }}>{m.instructions || "—"}</span>
          <span
            style={{
              color: m.is_active ? "var(--green)" : "var(--t3)",
              fontWeight: 600,
            }}
          >
            {m.is_active ? "Active" : "Stopped"}
          </span>
          <span style={{ fontSize: 11, color: "var(--t3)", textTransform: "capitalize" }}>
            {m.source || "genie"}
          </span>
        </div>
      ))}
    </div>
  );
}

// Conditions the patient (or scribe) has recorded on the Genie side.
// Mirrors the status chips the patient sees on the Track → Conditions screen.
const CONDITION_STATUS_COLORS = {
  controlled: { bg: "#DCFCE7", fg: "#15803D", label: "Controlled" },
  improving: { bg: "#DBEAFE", fg: "#1D4ED8", label: "Improving" },
  monitoring: { bg: "#FEF3C7", fg: "#92400E", label: "Monitoring" },
  uncontrolled: { bg: "#FEE2E2", fg: "#B91C1C", label: "Needs Attention" },
  worsening: { bg: "#FEE2E2", fg: "#B91C1C", label: "Worsening" },
  diagnosed: { bg: "#F3F4F6", fg: "#374151", label: "Diagnosed" },
  active: { bg: "#FEF3C7", fg: "#92400E", label: "Active" },
};

function PatientConditionsTable({ conditions }) {
  return (
    <div className="ld-condition-grid" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {conditions.map((c, i) => {
        const key = String(c.status || "diagnosed").toLowerCase();
        const chip = CONDITION_STATUS_COLORS[key] || CONDITION_STATUS_COLORS.diagnosed;
        return (
          <div
            key={c.id || i}
            style={{
              background: "#fff",
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: "10px 12px",
              minWidth: 200,
              flex: "1 1 220px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name || "Condition"}</span>
              <span
                style={{
                  background: chip.bg,
                  color: chip.fg,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: 999,
                }}
              >
                {chip.label}
              </span>
            </div>
            {c.diagnosed_date && (
              <div style={{ fontSize: 11, color: "var(--t3)" }}>
                Diagnosed {fmtDate(c.diagnosed_date)}
              </div>
            )}
            {cleanNote(c.notes) && (
              <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 4 }}>
                {cleanNote(c.notes)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── View All Data Modal ── */

const ALL_TABS = [
  { id: "vitals", label: "Vitals" },
  { id: "meds", label: "Medications" },
  { id: "activity", label: "Activity" },
  { id: "symptoms", label: "Symptoms" },
  { id: "meals", label: "Meals" },
];

function ViewAllModal({ loggedData, onClose }) {
  const [activeTab, setActiveTab] = useState("vitals");

  const availableTabs = ALL_TABS.filter((t) => {
    if (t.id === "vitals") return loggedData.vitals?.length > 0;
    if (t.id === "meds") return loggedData.meds?.length > 0;
    if (t.id === "activity") return loggedData.activity?.length > 0;
    if (t.id === "symptoms") return loggedData.symptoms?.length > 0;
    if (t.id === "meals") return loggedData.meals?.length > 0;
    return false;
  });

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox ld-modal-wide">
        <div className="ld-modal-header">
          <div className="mttl" style={{ marginBottom: 0 }}>
            Patient App — All Logged Data
          </div>
          <button className="bx bx-s" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Tab bar */}
        <div className="ld-modal-tabs">
          {availableTabs.map((t) => (
            <button
              key={t.id}
              className={`ld-mtab ${activeTab === t.id ? "on" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
              <span className="ld-mtab-count">
                {t.id === "activity"
                  ? loggedData.activity?.length || 0
                  : loggedData[t.id]?.length || 0}
              </span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="ld-modal-body">
          {activeTab === "vitals" && loggedData.vitals?.length > 0 && (
            <VitalsTable vitals={loggedData.vitals} />
          )}
          {activeTab === "meds" && loggedData.meds?.length > 0 && (
            <MedAdherenceTable meds={loggedData.meds} />
          )}
          {activeTab === "activity" && loggedData.activity?.length > 0 && (
            <ActivitySection activity={loggedData.activity} />
          )}
          {activeTab === "symptoms" && loggedData.symptoms?.length > 0 && (
            <SymptomsSection symptoms={loggedData.symptoms} />
          )}
          {activeTab === "meals" && loggedData.meals?.length > 0 && (
            <MealsTable meals={loggedData.meals} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main Component ── */

const VisitLoggedData = memo(function VisitLoggedData({ loggedData }) {
  const [showAll, setShowAll] = useState(false);

  const patientMedications = loggedData.patientMedications || [];
  const patientConditions = loggedData.patientConditions || [];

  const hasAny = !!(
    loggedData.vitals?.length ||
    loggedData.activity?.length ||
    loggedData.symptoms?.length ||
    loggedData.meds?.length ||
    loggedData.meals?.length ||
    patientMedications.length ||
    patientConditions.length
  );

  // Nutrition summary
  const nutritionSummary = useMemo(() => {
    if (!loggedData.meals?.length) return null;
    const m = loggedData.meals;
    const totalCal = m.reduce((s, r) => s + (r.calories || 0), 0);
    const totalProt = m.reduce((s, r) => s + (r.protein_g || 0), 0);
    const totalCarbs = m.reduce((s, r) => s + (r.carbs_g || 0), 0);
    const totalFat = m.reduce((s, r) => s + (r.fat_g || 0), 0);
    const days = new Set(m.map((r) => r.log_date)).size || 1;
    return {
      avgCal: Math.round(totalCal / days),
      avgProt: Math.round(totalProt / days),
      avgCarbs: Math.round(totalCarbs / days),
      avgFat: Math.round(totalFat / days),
      days,
    };
  }, [loggedData.meals]);

  // Clinical alerts
  const alerts = useMemo(() => {
    const a = [];
    const vitals = loggedData.vitals || [];
    const highBP = vitals.filter((v) => v.bp_systolic >= 140 || v.bp_diastolic >= 90);
    if (highBP.length > 0)
      a.push({
        type: "warn",
        msg: `${highBP.length} elevated BP reading(s) in last 60 days. Review medication.`,
      });

    const highSugar = vitals.filter((v) => v.rbs > 180);
    if (highSugar.length > 0)
      a.push({
        type: "warn",
        msg: `${highSugar.length} blood sugar reading(s) above 180 mg/dL. Assess glycemic control.`,
      });

    const exercises = (loggedData.activity || []).filter((a) => a.activity_type === "Exercise");
    const exDays = new Set(exercises.map((e) => e.log_date)).size;
    if (exDays < 3 && loggedData.activity?.length > 0)
      a.push({
        type: "info",
        msg: `Only ${exDays} exercise day(s) in 30 days. Encourage daily activity.`,
      });

    const sleepLogs = (loggedData.activity || []).filter((a) => a.activity_type === "Sleep");
    const lowSleep = sleepLogs.filter((s) => parseFloat(s.value) < 6);
    if (lowSleep.length >= 3)
      a.push({
        type: "info",
        msg: `${lowSleep.length} nights with <6h sleep. Discuss sleep hygiene.`,
      });

    const severeSymptoms = (loggedData.symptoms || []).filter((s) => s.severity > 6);
    if (severeSymptoms.length > 0)
      a.push({
        type: "warn",
        msg: `${severeSymptoms.length} severe symptom(s) reported. Review: ${severeSymptoms.map((s) => s.symptom).join(", ")}`,
      });

    const medDays = new Set((loggedData.meds || []).map((m) => m.log_date)).size;
    if (loggedData.meds?.length > 0 && pct(medDays, 30) < 60)
      a.push({
        type: "warn",
        msg: `Medication adherence is low (${pct(medDays, 30)}%). Discuss barriers.`,
      });

    return a;
  }, [loggedData]);

  return (
    <div className="panel-body">
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📊</div>Patient App Data
          </div>
          <button className="bx bx-p" onClick={() => hasAny && setShowAll(true)} disabled={!hasAny}>
            View All Data
          </button>
        </div>
        <div className="scb">
          {!hasAny && (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No logged data from the patient app yet
            </div>
          )}

          {hasAny && (
            <>
              {/* ── Summary Cards ── */}
              <SummaryCards
                vitals={loggedData.vitals}
                activity={loggedData.activity}
                meds={loggedData.meds}
                meals={loggedData.meals}
                symptoms={loggedData.symptoms}
              />

              {/* ── Clinical Alerts ── */}
              {alerts.length > 0 && (
                <div className="ld-alerts">
                  {alerts.map((a, i) => (
                    <div key={i} className={`noticebar ${a.type === "warn" ? "amb" : "inf"}`}>
                      <span>{a.type === "warn" ? "⚠️" : "ℹ️"}</span>
                      <span className={`ni ${a.type === "warn" ? "amb" : "inf"}`}>{a.msg}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Conditions reported in app ── */}
              {patientConditions.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Conditions reported in Genie app</div>
                  <PatientConditionsTable conditions={patientConditions} />
                </div>
              )}

              {/* ── Medicines the patient is taking (from Genie app) ── */}
              {patientMedications.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Medicines the patient is taking (from Genie app)</div>
                  <PatientMedicationsTable medications={patientMedications} />
                </div>
              )}

              {/* ── Vitals ── */}
              {loggedData.vitals?.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Vitals — Self-Logged</div>
                  <VitalsTable vitals={loggedData.vitals} limit={10} />
                </div>
              )}

              {/* ── Medication Adherence ── */}
              {loggedData.meds?.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Medication Adherence</div>
                  <MedAdherenceTable meds={loggedData.meds} limit={10} />
                </div>
              )}

              {/* ── Activity ── */}
              {loggedData.activity?.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Activity & Lifestyle</div>
                  <ActivitySection activity={loggedData.activity} limit={6} />
                </div>
              )}

              {/* ── Symptoms ── */}
              {loggedData.symptoms?.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Reported Symptoms</div>
                  <SymptomsSection symptoms={loggedData.symptoms} limit={6} />
                </div>
              )}

              {/* ── Meals & Nutrition ── */}
              {loggedData.meals?.length > 0 && (
                <div className="ld-section">
                  <div className="subsec">Meals & Nutrition</div>
                  {nutritionSummary && (
                    <div className="ld-nutr-bar">
                      <div className="ld-nutr-item">
                        <span className="ld-nutr-val">{nutritionSummary.avgCal}</span>
                        <span className="ld-nutr-lbl">Avg Cal/day</span>
                      </div>
                      <div className="ld-nutr-item">
                        <span className="ld-nutr-val">{nutritionSummary.avgProt}g</span>
                        <span className="ld-nutr-lbl">Protein</span>
                      </div>
                      <div className="ld-nutr-item">
                        <span className="ld-nutr-val">{nutritionSummary.avgCarbs}g</span>
                        <span className="ld-nutr-lbl">Carbs</span>
                      </div>
                      <div className="ld-nutr-item">
                        <span className="ld-nutr-val">{nutritionSummary.avgFat}g</span>
                        <span className="ld-nutr-lbl">Fat</span>
                      </div>
                      <div className="ld-nutr-item">
                        <span className="ld-nutr-val" style={{ color: "var(--t2)" }}>
                          {nutritionSummary.days}
                        </span>
                        <span className="ld-nutr-lbl">Days</span>
                      </div>
                    </div>
                  )}
                  <MealsTable meals={loggedData.meals} limit={8} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── View All Data Modal ── */}
      {showAll && <ViewAllModal loggedData={loggedData} onClose={() => setShowAll(false)} />}
    </div>
  );
});

export default VisitLoggedData;
