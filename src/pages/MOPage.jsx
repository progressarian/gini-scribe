import "./MOPage.css";
import { useNavigate } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useUiStore from "../stores/uiStore";
import NewReportsBanner from "../components/NewReportsBanner.jsx";
import AudioInput from "../components/AudioInput.jsx";
import Err from "../components/Err.jsx";
import { DC, sa } from "../config/constants.js";

export default function MOPage() {
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const dgKey = useAuthStore((s) => s.dgKey);
  const whisperKey = useAuthStore((s) => s.whisperKey);
  const moName = useAuthStore((s) => s.moName);
  const setMoName = useAuthStore((s) => s.setMoName);
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const isFollowUp = usePatientStore((s) => s.getIsFollowUp());
  const moTranscript = useClinicalStore((s) => s.moTranscript);
  const setMoTranscript = useClinicalStore((s) => s.setMoTranscript);
  const moData = useClinicalStore((s) => s.moData);
  const setMoData = useClinicalStore((s) => s.setMoData);
  const moBrief = useClinicalStore((s) => s.moBrief);
  const setMoBrief = useClinicalStore((s) => s.setMoBrief);
  const processMO = useClinicalStore((s) => s.processMO);
  const generateMOBrief = useClinicalStore((s) => s.generateMOBrief);
  const loading = useUiStore((s) => s.loading);
  const errors = useUiStore((s) => s.errors);
  const clearErr = useUiStore((s) => s.clearErr);

  return (
    <div>
      <NewReportsBanner />
      <div className="mo__name-row">
        <label className="mo__name-label">MO:</label>
        {doctorsList.filter((d) => d.role === "mo").length > 0 ? (
          <select
            value={moName}
            onChange={(e) => setMoName(e.target.value)}
            style={{
              padding: "4px 8px",
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              width: 200,
              background: "white",
            }}
          >
            {doctorsList
              .filter((d) => d.role === "mo")
              .map((d) => (
                <option key={d.id} value={d.short_name}>
                  {d.name}
                </option>
              ))}
            <option value="">— Other —</option>
          </select>
        ) : (
          <input
            value={moName}
            onChange={(e) => setMoName(e.target.value)}
            placeholder="Dr. Name"
            style={{
              padding: "4px 8px",
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              width: 160,
            }}
          />
        )}
      </div>

      {/* ── MO BRIEF FOR CONSULTANT ── */}
      {dbPatientId && (
        <div style={{ marginBottom: 10 }}>
          {!moBrief ? (
            <button
              onClick={() => setMoBrief(generateMOBrief())}
              style={{
                width: "100%",
                background: "linear-gradient(135deg,#1e40af,#3b82f6)",
                color: "white",
                border: "none",
                padding: "10px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              📋 Generate Consultant Brief
            </button>
          ) : (
            <div style={{ border: "2px solid #1e40af", borderRadius: 10, overflow: "hidden" }}>
              <div
                style={{
                  background: "linear-gradient(135deg,#1e40af,#1e3a8a)",
                  color: "white",
                  padding: "8px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 14 }}>📋</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>
                    {moBrief.isFollowUp ? "FOLLOW-UP" : "NEW PATIENT"} BRIEF
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.8 }}>
                    {moBrief.isFollowUp
                      ? `${moBrief.totalVisits} visits • Last: ${moBrief.daysSince}d ago${moBrief.lastVisit?.con_name ? ` • ${moBrief.lastVisit.con_name}` : ""}`
                      : "First visit"}
                  </div>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(moBrief.briefText);
                  }}
                  style={{
                    background: "rgba(255,255,255,.2)",
                    border: "none",
                    color: "white",
                    padding: "4px 10px",
                    borderRadius: 5,
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  📋 Copy
                </button>
                <button
                  onClick={() => setMoBrief(generateMOBrief())}
                  style={{
                    background: "rgba(255,255,255,.15)",
                    border: "none",
                    color: "white",
                    padding: "4px 8px",
                    borderRadius: 5,
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  🔄
                </button>
                <button
                  onClick={() => setMoBrief(null)}
                  style={{
                    background: "rgba(255,255,255,.1)",
                    border: "none",
                    color: "white",
                    padding: "4px 6px",
                    borderRadius: 5,
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>

              <div style={{ padding: 10, fontSize: 11, lineHeight: 1.7 }}>
                {moBrief.diagnoses.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div
                      style={{ fontSize: 10, fontWeight: 700, color: "#1e40af", marginBottom: 3 }}
                    >
                      KNOWN CONDITIONS
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {moBrief.diagnoses.map((d, i) => (
                        <span
                          key={i}
                          style={{
                            padding: "2px 8px",
                            borderRadius: 5,
                            fontSize: 10,
                            fontWeight: 600,
                            background:
                              d.status === "Uncontrolled"
                                ? "#fef2f2"
                                : d.status === "Controlled"
                                  ? "#f0fdf4"
                                  : "#fefce8",
                            color:
                              d.status === "Uncontrolled"
                                ? "#dc2626"
                                : d.status === "Controlled"
                                  ? "#059669"
                                  : "#92400e",
                            border: `1px solid ${d.status === "Uncontrolled" ? "#fecaca" : d.status === "Controlled" ? "#bbf7d0" : "#fde68a"}`,
                          }}
                        >
                          {d.label} — {d.status}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {moBrief.medications.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div
                      style={{ fontSize: 10, fontWeight: 700, color: "#1e40af", marginBottom: 3 }}
                    >
                      CURRENT MEDICATIONS ({moBrief.medications.length})
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                      {moBrief.medications.map((m, i) => (
                        <div
                          key={i}
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            background: i % 2 ? "#f8fafc" : "white",
                            borderRadius: 3,
                          }}
                        >
                          <strong>{m.name}</strong> {m.dose || ""}{" "}
                          <span style={{ color: "#64748b" }}>{m.timing || m.frequency || ""}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(moBrief.improving.length > 0 || moBrief.worsening.length > 0) && (
                  <div style={{ marginBottom: 8, display: "flex", gap: 6 }}>
                    {moBrief.improving.length > 0 && (
                      <div
                        style={{
                          flex: 1,
                          background: "#f0fdf4",
                          borderRadius: 6,
                          padding: 6,
                          border: "1px solid #bbf7d0",
                        }}
                      >
                        <div style={{ fontSize: 9, fontWeight: 700, color: "#059669" }}>
                          📈 IMPROVING
                        </div>
                        {moBrief.improving.map((l, i) => (
                          <div key={i} style={{ fontSize: 10, color: "#059669" }}>
                            {l.name}:{" "}
                            <span style={{ textDecoration: "line-through", opacity: 0.6 }}>
                              {l.previous}
                            </span>{" "}
                            → <strong>{l.latest}</strong>
                            {l.latestUnit}
                          </div>
                        ))}
                      </div>
                    )}
                    {moBrief.worsening.length > 0 && (
                      <div
                        style={{
                          flex: 1,
                          background: "#fef2f2",
                          borderRadius: 6,
                          padding: 6,
                          border: "1px solid #fecaca",
                        }}
                      >
                        <div style={{ fontSize: 9, fontWeight: 700, color: "#dc2626" }}>
                          📉 WORSENING
                        </div>
                        {moBrief.worsening.map((l, i) => (
                          <div key={i} style={{ fontSize: 10, color: "#dc2626" }}>
                            {l.name}:{" "}
                            <span style={{ textDecoration: "line-through", opacity: 0.6 }}>
                              {l.previous}
                            </span>{" "}
                            → <strong>{l.latest}</strong>
                            {l.latestUnit}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {moBrief.labTrends.filter((l) => l.isKey).length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div
                      style={{ fontSize: 10, fontWeight: 700, color: "#1e40af", marginBottom: 3 }}
                    >
                      KEY LAB VALUES
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {moBrief.labTrends
                        .filter((l) => l.isKey)
                        .map((l, i) => (
                          <span
                            key={i}
                            style={{
                              padding: "2px 6px",
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 600,
                              background:
                                l.latestFlag === "H"
                                  ? "#fef2f2"
                                  : l.latestFlag === "L"
                                    ? "#eff6ff"
                                    : "#f8fafc",
                              color:
                                l.latestFlag === "H"
                                  ? "#dc2626"
                                  : l.latestFlag === "L"
                                    ? "#2563eb"
                                    : "#334155",
                              border: `1px solid ${l.latestFlag === "H" ? "#fecaca" : l.latestFlag === "L" ? "#bfdbfe" : "#e2e8f0"}`,
                            }}
                          >
                            {l.name}: <strong>{l.latest}</strong>
                            {l.latestUnit}
                            {l.previous && (
                              <span style={{ opacity: 0.5, marginLeft: 3 }}>
                                (prev: {l.previous})
                              </span>
                            )}
                            {l.latestFlag === "H" ? "↑" : l.latestFlag === "L" ? "↓" : ""}
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                {moBrief.currentVitals?.bp_sys && (
                  <div style={{ marginBottom: 4 }}>
                    <div
                      style={{ fontSize: 10, fontWeight: 700, color: "#1e40af", marginBottom: 3 }}
                    >
                      TODAY'S VITALS
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {[
                        {
                          l: "BP",
                          v: `${moBrief.currentVitals.bp_sys}/${moBrief.currentVitals.bp_dia}`,
                          p: moBrief.prevVitals
                            ? `${moBrief.prevVitals.bp_sys}/${moBrief.prevVitals.bp_dia}`
                            : null,
                        },
                        {
                          l: "Wt",
                          v: moBrief.currentVitals.weight
                            ? `${moBrief.currentVitals.weight}kg`
                            : null,
                          p: moBrief.prevVitals?.weight ? `${moBrief.prevVitals.weight}kg` : null,
                        },
                        { l: "BMI", v: moBrief.currentVitals.bmi, p: moBrief.prevVitals?.bmi },
                        { l: "Pulse", v: moBrief.currentVitals.pulse, p: null },
                        {
                          l: "SpO2",
                          v: moBrief.currentVitals.spo2 ? `${moBrief.currentVitals.spo2}%` : null,
                          p: null,
                        },
                      ]
                        .filter((x) => x.v)
                        .map((x, i) => (
                          <span
                            key={i}
                            style={{
                              background: "#fff7ed",
                              border: "1px solid #fed7aa",
                              borderRadius: 4,
                              padding: "2px 6px",
                              fontSize: 10,
                            }}
                          >
                            <strong style={{ color: "#9a3412" }}>{x.l}:</strong> {x.v}
                            {x.p && (
                              <span style={{ color: "#94a3b8", marginLeft: 3 }}>(prev: {x.p})</span>
                            )}
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                {moBrief.newLabs.length > 0 && (
                  <div
                    style={{
                      background: "#fffbeb",
                      border: "1px solid #fde68a",
                      borderRadius: 6,
                      padding: 6,
                      marginTop: 6,
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#92400e" }}>
                      🔬 {moBrief.newLabs.length} NEW RESULTS since last visit
                    </div>
                    <div style={{ fontSize: 9, color: "#a16207", marginTop: 2 }}>
                      {[...new Set(moBrief.newLabs.map((l) => l.test_name))].join(", ")}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <AudioInput
        label="MO — Patient History"
        dgKey={dgKey}
        whisperKey={whisperKey}
        color="#1e40af"
        onTranscript={(t) => {
          setMoTranscript(t);
          setMoData(null);
          clearErr("mo");
        }}
      />
      {moTranscript && (
        <button
          onClick={processMO}
          disabled={loading.mo}
          style={{
            marginTop: 6,
            width: "100%",
            background: loading.mo ? "#6b7280" : moData ? "#059669" : "#1e40af",
            color: "white",
            border: "none",
            padding: "10px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: loading.mo ? "wait" : "pointer",
          }}
        >
          {loading.mo
            ? "🔬 Structuring..."
            : moData
              ? "✅ Done — Re-process"
              : "🔬 Structure MO Summary"}
        </button>
      )}
      <Err msg={errors.mo} onDismiss={() => clearErr("mo")} />

      {moData && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              background: "#1e40af",
              color: "white",
              padding: "8px 12px",
              borderRadius: "8px 8px 0 0",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 13 }}>
              📋 MO Summary — {patient.name || "Patient"}{" "}
              <span style={{ fontSize: 10, opacity: 0.7 }}>by {moName}</span>
            </span>
            <button
              onClick={navClick("/consultant")}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                color: "white",
                padding: "3px 10px",
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Next: Consultant →
            </button>
          </div>
          <div
            style={{
              border: "1px solid #bfdbfe",
              borderTop: "none",
              borderRadius: "0 0 8px 8px",
              padding: 12,
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
              {sa(moData, "diagnoses").map((d, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: (DC[d.id] || "#64748b") + "12",
                    border: `1px solid ${DC[d.id] || "#64748b"}30`,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: DC[d.id] || "#64748b",
                    }}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600, color: DC[d.id] || "#64748b" }}>
                    {d.label}
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: 8,
                      background:
                        d.status === "Uncontrolled" || d.status === "Suboptimal"
                          ? "#fef2f2"
                          : d.status === "Active"
                            ? "#fef3c7"
                            : "#f0fdf4",
                      color:
                        d.status === "Uncontrolled" || d.status === "Suboptimal"
                          ? "#dc2626"
                          : d.status === "Active"
                            ? "#92400e"
                            : "#059669",
                    }}
                  >
                    {d.status}
                  </span>
                </div>
              ))}
            </div>

            {sa(moData, "complications").length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 3 }}>
                  ⚠️ COMPLICATIONS
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {sa(moData, "complications").map((c, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: c.severity === "high" ? "#fef2f2" : "#fef3c7",
                        border: `1px solid ${c.severity === "high" ? "#fecaca" : "#fde68a"}`,
                        color: c.severity === "high" ? "#dc2626" : "#92400e",
                      }}
                    >
                      {c.name} ({c.status}) {c.detail && `— ${c.detail}`}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {moData.history && (
              <div
                style={{
                  marginBottom: 10,
                  background: "#f8fafc",
                  borderRadius: 6,
                  padding: 8,
                  border: "1px solid #e2e8f0",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>
                  📖 HISTORY
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.8, color: "#475569" }}>
                  {moData.history.family && moData.history.family !== "NIL" && (
                    <div>
                      👨‍👩‍👧 <strong>Family:</strong> {moData.history.family}
                    </div>
                  )}
                  {moData.history.past_medical_surgical &&
                    moData.history.past_medical_surgical !== "NIL" && (
                      <div>
                        🏥 <strong>Past:</strong> {moData.history.past_medical_surgical}
                      </div>
                    )}
                  {moData.history.personal && moData.history.personal !== "NIL" && (
                    <div>
                      🚬 <strong>Personal:</strong> {moData.history.personal}
                    </div>
                  )}
                  {moData.history.covid && (
                    <div>
                      🦠 <strong>COVID:</strong> {moData.history.covid}
                    </div>
                  )}
                  {moData.history.vaccination && (
                    <div>
                      💉 <strong>Vaccination:</strong> {moData.history.vaccination}
                    </div>
                  )}
                </div>
              </div>
            )}

            {sa(moData, "previous_medications").length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#1e40af", marginBottom: 4 }}>
                  💊 PREVIOUS MEDICATIONS
                </div>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 11,
                    border: "1px solid #bfdbfe",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#1e40af", color: "white" }}>
                      <th style={{ padding: "3px 8px", textAlign: "left" }}>Medicine</th>
                      <th style={{ padding: "3px 8px" }}>Dose</th>
                      <th style={{ padding: "3px 8px" }}>Freq</th>
                      <th style={{ padding: "3px 8px" }}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sa(moData, "previous_medications").map((m, i) => (
                      <tr key={i} style={{ background: i % 2 ? "#eff6ff" : "white" }}>
                        <td style={{ padding: "3px 8px" }}>
                          <strong>{m.name}</strong>
                          {m.composition && (
                            <div style={{ fontSize: 9, color: "#94a3b8" }}>{m.composition}</div>
                          )}
                        </td>
                        <td style={{ padding: "3px 8px", textAlign: "center" }}>{m.dose}</td>
                        <td style={{ padding: "3px 8px", textAlign: "center" }}>{m.frequency}</td>
                        <td style={{ padding: "3px 8px", textAlign: "center" }}>{m.timing}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sa(moData, "investigations").length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", marginBottom: 4 }}>
                  🔬 INVESTIGATIONS
                </div>
                {sa(moData, "investigations").map((inv, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "4px 8px",
                      marginBottom: 2,
                      borderRadius: 4,
                      background: inv.critical
                        ? "#fef2f2"
                        : inv.flag === "HIGH"
                          ? "#fff7ed"
                          : inv.flag === "LOW"
                            ? "#eff6ff"
                            : "#f0fdf4",
                      border: `1px solid ${inv.critical ? "#fecaca" : inv.flag === "HIGH" ? "#fed7aa" : inv.flag === "LOW" ? "#bfdbfe" : "#bbf7d0"}`,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {inv.test}
                      {inv.date && (
                        <span style={{ fontSize: 9, color: "#94a3b8", marginLeft: 4 }}>
                          ({inv.date})
                        </span>
                      )}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: inv.critical
                            ? "#dc2626"
                            : inv.flag === "HIGH"
                              ? "#ea580c"
                              : inv.flag === "LOW"
                                ? "#2563eb"
                                : "#059669",
                        }}
                      >
                        {inv.value} {inv.unit}
                      </span>
                      {inv.critical && (
                        <span
                          style={{
                            background: "#dc2626",
                            color: "white",
                            padding: "0 4px",
                            borderRadius: 4,
                            fontSize: 9,
                            fontWeight: 700,
                          }}
                        >
                          CRITICAL
                        </span>
                      )}
                      {inv.flag === "HIGH" && !inv.critical && (
                        <span style={{ color: "#ea580c", fontSize: 10 }}>⚠️ HIGH</span>
                      )}
                      {inv.flag === "LOW" && (
                        <span style={{ color: "#2563eb", fontSize: 10 }}>⚠️ LOW</span>
                      )}
                      {!inv.flag && <span style={{ color: "#059669", fontSize: 10 }}>✅</span>}
                      {inv.ref && (
                        <span style={{ fontSize: 9, color: "#94a3b8" }}>({inv.ref})</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {sa(moData, "missing_investigations").length > 0 && (
              <div
                style={{
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 11,
                  color: "#1e40af",
                }}
              >
                ❓ <strong>Missing investigations:</strong>{" "}
                {sa(moData, "missing_investigations").join(", ")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
