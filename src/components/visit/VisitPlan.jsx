import { memo } from "react";
import { fmtDate, fmtDateLong, getLabVal } from "./helpers";

const VisitPlan = memo(function VisitPlan({
  consultations,
  goals,
  doctorNote,
  onDoctorNoteChange,
  patient,
  doctor,
  activeDx,
  activeMeds,
  latestVitals,
  summary,
  labResults,
  onEndVisit,
  onAddReferral,
}) {
  const latestCon = consultations[0]?.con_data;
  const tests = latestCon?.investigations_to_order || latestCon?.tests_ordered || [];
  const followUp = latestCon?.follow_up;
  const today = new Date().toISOString().split("T")[0];
  const hba1c = getLabVal(labResults, "HbA1c");
  const fbs = getLabVal(labResults, "FBS");

  return (
    <>
      {/* PLAN */}
      <div className="sc" id="plan">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📝</div>Plan for This Visit
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn">📋 Templates</button>
            <button className="bx bx-p" onClick={onAddReferral}>+ Referral</button>
          </div>
        </div>
        <div className="scb">
          <div className="plg">
            <div className="plc">
              <div className="plct">🧪 Tests Ordered</div>
              {tests.length > 0 ? (
                tests.map((t, i) => (
                  <div key={i} className="ti">
                    <span className="ti-nm">{typeof t === "string" ? t : t.name || t.test}</span>
                    <span className={`urg ${t.urgency === "urgent" ? "u-u" : "u-n"}`}>
                      {t.urgency === "urgent" ? "Urgent" : "Next visit"}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12, color: "var(--t3)" }}>No tests ordered</div>
              )}
            </div>
            <div className="plc">
              <div className="plct">🏃 Lifestyle Instructions</div>
              {latestCon?.diet_lifestyle?.length > 0 ? (
                latestCon.diet_lifestyle.map((d, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.9 }}>
                    {typeof d === "string" ? d : d.instruction || JSON.stringify(d)}
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12, color: "var(--t3)" }}>
                  No lifestyle instructions recorded
                </div>
              )}
              {followUp && (
                <div style={{ marginTop: 10 }}>
                  <div className="plct">Follow-up</div>
                  <div style={{ fontSize: 12, color: "var(--t2)" }}>
                    {followUp.date ? fmtDateLong(followUp.date) : followUp.notes || "Scheduled"}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="subsec">Templates &amp; Patient Instructions</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
            <button className="btn">📌 Insulin Titration Guide</button>
            <button className="btn">🥗 1000 kcal Diet Plan</button>
            <button className="btn">💉 Mounjaro Injection Guide</button>
            <button className="btn">🩸 Blood Sugar Log Sheet</button>
            <button className="btn">📋 Fasting Lab Instructions</button>
          </div>
          <div className="subsec">Doctor's Note</div>
          <textarea
            className="nf"
            value={doctorNote}
            onChange={(e) => onDoctorNoteChange(e.target.value)}
            placeholder="Add your notes for this visit..."
            style={{ marginBottom: 12 }}
          />

          {goals.length > 0 && (
            <div className="nv-row" style={{ marginBottom: 12 }}>
              <div>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#065f46",
                    textTransform: "uppercase",
                    letterSpacing: ".5px",
                  }}
                >
                  Goals Set
                </div>
                <div style={{ fontSize: 12, color: "#047857" }}>
                  {goals
                    .slice(0, 3)
                    .map((g) => `${g.marker}: ${g.current_value} → ${g.target_value}`)
                    .join(" · ")}
                </div>
              </div>
            </div>
          )}

          {/* Next Visit row */}
          <div className="nv-row">
            <div>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: "#065f46",
                  textTransform: "uppercase",
                  letterSpacing: ".5px",
                }}
              >
                Next Visit Scheduled
              </div>
              <div className="nv-date">
                {followUp?.date ? fmtDateLong(followUp.date) : "Not yet scheduled"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <button className="bx bx-g">Change Date</button>
              <button className="bx bx-p">Send Reminder via WhatsApp</button>
            </div>
          </div>
        </div>
      </div>

      {/* SUMMARY */}
      <div className="sc" id="summary">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📄</div>Visit Summary &amp; Print
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn">🖨 Print Rx</button>
            <button className="btn">💊 Print Med Card</button>
            <button className="btn">📱 Send via WhatsApp</button>
          </div>
        </div>
        <div className="scb">
          <div className="sumcard">
            <div className="sum-title">Visit Summary — {fmtDate(today)}</div>
            <div className="sum-row">
              <span className="sum-k">Patient</span>
              <span className="sum-v">
                {patient.name}, {patient.age}
                {patient.sex?.[0]} · ID: {patient.file_no || patient.id} ·{" "}
                {doctor?.name || "Doctor"}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Program</span>
              <span className="sum-v">
                {summary.carePhase} · Visit #{summary.totalVisits}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Diagnoses</span>
              <span className="sum-v">
                {activeDx.map((d) => `${d.label || d.diagnosis_id} (${d.status})`).join(", ") ||
                  "None"}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Key Markers</span>
              <span className="sum-v">
                {[
                  hba1c && `HbA1c ${hba1c.result}%`,
                  fbs && `FPG ${fbs.result}`,
                  latestVitals?.bp_sys && `BP ${latestVitals.bp_sys}/${latestVitals.bp_dia}`,
                  latestVitals?.weight && `Weight ${latestVitals.weight}kg`,
                ]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Medications</span>
              <span className="sum-v">{activeMeds.map((m) => m.name).join(" · ") || "None"}</span>
            </div>
            <div className="sum-acts">
              {onEndVisit && (
                <button className="btn-p" onClick={onEndVisit}>
                  ✓ Complete &amp; Save Visit
                </button>
              )}
              <button className="btn">Print Full Prescription</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});

export default VisitPlan;
