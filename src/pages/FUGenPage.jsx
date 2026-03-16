import "./FUGenPage.css";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useVisitStore from "../stores/visitStore";
import useExamStore from "../stores/examStore";
import useReportsStore from "../stores/reportsStore";
import useUiStore from "../stores/uiStore";
import AudioInput from "../components/AudioInput.jsx";
import { fixConMedicines } from "../medmatch.js";

export default function FUGenPage() {
  const navigate = useNavigate();
  const dgKey = useAuthStore((s) => s.dgKey);
  const whisperKey = useAuthStore((s) => s.whisperKey);
  const patient = usePatientStore((s) => s.patient);
  const pfd = usePatientStore((s) => s.getPfd());
  const conTranscript = useClinicalStore((s) => s.conTranscript);
  const setConTranscript = useClinicalStore((s) => s.setConTranscript);
  const moData = useClinicalStore((s) => s.moData);
  const setMoData = useClinicalStore((s) => s.setMoData);
  const conData = useClinicalStore((s) => s.conData);
  const setConData = useClinicalStore((s) => s.setConData);
  const processConsultant = useClinicalStore((s) => s.processConsultant);
  const setConSourceMode = useClinicalStore((s) => s.setConSourceMode);
  const complaints = useVisitStore((s) => s.complaints);
  const fuMedEdits = useVisitStore((s) => s.fuMedEdits);
  const fuNewMeds = useVisitStore((s) => s.fuNewMeds);
  const fuPlanSource = useVisitStore((s) => s.fuPlanSource);
  const setFuPlanSource = useVisitStore((s) => s.setFuPlanSource);
  const shadowData = useExamStore((s) => s.shadowData);
  const setShadowData = useExamStore((s) => s.setShadowData);
  const shadowTxDecisions = useExamStore((s) => s.shadowTxDecisions);
  const setShadowTxDecisions = useExamStore((s) => s.setShadowTxDecisions);
  const shadowLoading = useExamStore((s) => s.shadowLoading);
  const runShadowAI = useExamStore((s) => s.runShadowAI);
  const patientCI = useReportsStore((s) => s.patientCI);
  const patientCILoading = useReportsStore((s) => s.patientCILoading);
  const patientCIExpanded = useReportsStore((s) => s.patientCIExpanded);
  const setPatientCIExpanded = useReportsStore((s) => s.setPatientCIExpanded);
  const runPatientCI = useReportsStore((s) => s.runPatientCI);
  const loading = useUiStore((s) => s.loading);

  return (
    <div>
      <div className="fu-gen__header">
        <span className="fu-gen__header-icon">🤖</span>
        <div className="fu-gen__header-info">
          <div className="fu-gen__header-title">Create Treatment Plan</div>
          <div className="fu-gen__header-sub">Choose how to generate</div>
        </div>
        <span style={{ fontSize: 10, opacity: 0.6 }}>Step 5/5</span>
      </div>

      {(patientCILoading || patientCI) && (
        <div
          className="no-print"
          style={{
            marginBottom: 10,
            border:
              "2px solid " +
              (patientCI && patientCI.safety_flags && patientCI.safety_flags.length > 0
                ? "#dc2626"
                : "#2563eb"),
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <div
            onClick={function () {
              setPatientCIExpanded(!patientCIExpanded);
            }}
            style={{
              cursor: "pointer",
              background:
                patientCI && patientCI.safety_flags && patientCI.safety_flags.length > 0
                  ? "linear-gradient(135deg,#dc2626,#b91c1c)"
                  : "linear-gradient(135deg,#1e40af,#1d4ed8)",
              color: "white",
              padding: "7px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 13 }}>{"🧠"}</span>
            <span style={{ fontWeight: 800, fontSize: 12, flex: 1 }}>
              {"CLINICAL INTELLIGENCE"}
              {patientCI && patientCI.recommendations && patientCI.recommendations.length > 0 && (
                <span
                  style={{
                    background: "rgba(255,255,255,.25)",
                    borderRadius: 4,
                    padding: "0 6px",
                    marginLeft: 6,
                    fontSize: 10,
                  }}
                >
                  {"💡 " + patientCI.recommendations.length + " Rec"}
                </span>
              )}
              {patientCI &&
                patientCI.prescription_gaps &&
                patientCI.prescription_gaps.length > 0 && (
                  <span
                    style={{
                      background: "rgba(255,255,255,.25)",
                      borderRadius: 4,
                      padding: "0 6px",
                      marginLeft: 4,
                      fontSize: 10,
                    }}
                  >
                    {"💊 " + patientCI.prescription_gaps.length + " Gap"}
                  </span>
                )}
              {patientCI && patientCI.safety_flags && patientCI.safety_flags.length > 0 && (
                <span
                  style={{
                    background: "rgba(255,255,255,.25)",
                    borderRadius: 4,
                    padding: "0 6px",
                    marginLeft: 4,
                    fontSize: 10,
                  }}
                >
                  {"⚠️ " + patientCI.safety_flags.length + " Safety"}
                </span>
              )}
            </span>
            {patientCI && (
              <span style={{ fontSize: 9, opacity: 0.8 }}>
                {patientCI.phenotype_detected || "unclassified"}
              </span>
            )}
            <button
              onClick={function (e) {
                e.stopPropagation();
                runPatientCI();
              }}
              style={{
                background: "rgba(255,255,255,.2)",
                border: "none",
                color: "white",
                borderRadius: 4,
                padding: "1px 7px",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              {"↺"}
            </button>
            <span style={{ fontSize: 10, opacity: 0.8 }}>{patientCIExpanded ? "▲" : "▼"}</span>
          </div>
          {patientCILoading && (
            <div
              style={{
                padding: "10px 14px",
                fontSize: 11,
                color: "#64748b",
                background: "#f8fafc",
              }}
            >
              {"⏳ Analysing against 27 clinical protocols..."}
            </div>
          )}
          {patientCI && patientCIExpanded && !patientCILoading && (
            <div
              style={{
                background: "#fafafa",
                padding: "8px 10px",
                maxHeight: 500,
                overflowY: "auto",
              }}
            >
              {/* ── Helper: clean raw med name to short label ── */}
              {(function () {
                window._ciCleanMed = function (raw) {
                  // Strip TAB/CAP prefix, keep name + dose, cut at timing/frequency
                  var n = (raw || "").replace(/^(TAB|CAP|INJ|SYR|TABS?|CAPS?)[\. ]+/i, "").trim();
                  // Cut at frequency/timing words but keep dose numbers before them
                  n = n
                    .replace(
                      /[\s,]+(ONCE DAILY|TWICE DAILY|THREE TIMES|DAILY|OD|BD|TDS|QID|AT [0-9]|FOR [0-9]|THEN[,]?|ON AWAK|MORNING|NIGHT|BEDTIME|EMPTY STOMACH|AFTER MEALS|BEFORE MEALS|WITH MEALS|MIN BEFORE|MIN AFTER).*/i,
                      "",
                    )
                    .trim();
                  return n.length > 35 ? n.slice(0, 33) + "…" : n;
                };
                window._ciDrugClass = function (name) {
                  var u = (name || "").toUpperCase();
                  if (
                    u.indexOf("GLYCOMET") !== -1 ||
                    u.indexOf("METFORMIN") !== -1 ||
                    u.indexOf("GLUCONORM") !== -1
                  )
                    return "Metformin";
                  if (
                    u.indexOf("THYRONORM") !== -1 ||
                    u.indexOf("ELTROXIN") !== -1 ||
                    u.indexOf("LEVOTHYROX") !== -1
                  )
                    return "Thyroid";
                  if (
                    u.indexOf("LIPITAS") !== -1 ||
                    u.indexOf("LIPICARD") !== -1 ||
                    u.indexOf("ATORVA") !== -1 ||
                    u.indexOf("ROZAVEL") !== -1 ||
                    u.indexOf("ROSUVAS") !== -1
                  )
                    return "Statin";
                  if (
                    u.indexOf("TRICOR") !== -1 ||
                    u.indexOf("FENOLIP") !== -1 ||
                    u.indexOf("FENOFIBRATE") !== -1
                  )
                    return "Fibrate";
                  if (
                    u.indexOf("DAPLO") !== -1 ||
                    u.indexOf("FORXIGA") !== -1 ||
                    u.indexOf("JARDIANCE") !== -1
                  )
                    return "SGLT2i";
                  if (
                    u.indexOf("JANUVIA") !== -1 ||
                    u.indexOf("TRAJENTA") !== -1 ||
                    u.indexOf("SITACIP") !== -1 ||
                    u.indexOf("LINAXA") !== -1
                  )
                    return "DPP4i";
                  if (
                    u.indexOf("OZEMPIC") !== -1 ||
                    u.indexOf("WEGOVY") !== -1 ||
                    u.indexOf("RYBELSUS") !== -1 ||
                    u.indexOf("MOUNJARO") !== -1
                  )
                    return "GLP1";
                  if (
                    u.indexOf("TRESIBA") !== -1 ||
                    u.indexOf("RYZODEG") !== -1 ||
                    u.indexOf("LANTUS") !== -1 ||
                    u.indexOf("BASALOG") !== -1
                  )
                    return "Insulin";
                  if (u.indexOf("TELMA") !== -1 || u.indexOf("TELMISARTAN") !== -1) return "ARB";
                  if (u.indexOf("AMLODIPINE") !== -1 || u.indexOf("AMLONG") !== -1) return "CCB";
                  if (
                    u.indexOf("DIAMICRON") !== -1 ||
                    u.indexOf("GLIZID") !== -1 ||
                    u.indexOf("GLICLAZIDE") !== -1
                  )
                    return "SU";
                  if (
                    u.indexOf("LUMIA") !== -1 ||
                    u.indexOf("CALCIROL") !== -1 ||
                    u.indexOf("CHOLECALC") !== -1 ||
                    u.indexOf("UPRISE") !== -1
                  )
                    return "VitD";
                  return null;
                };
                return null;
              })()}

              {/* ── TREATMENT PLAN REVIEW — main section ── */}
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  color: "#1e40af",
                  marginBottom: 6,
                  letterSpacing: 0.5,
                }}
              >
                {"📋 TREATMENT PLAN REVIEW"}
              </div>

              {/* Render each protocol as a diagnosis block */}
              {(function () {
                var snap = patientCI.snapshot || {};
                var rawMeds = snap.current_medication_names || [];
                var contraClasses = (snap.drug_history || [])
                  .filter(function (d) {
                    return d.contraindicated;
                  })
                  .map(function (d) {
                    return (d.drug_class || "").toUpperCase();
                  });

                // Build set of drug classes already on
                var onClasses = new Set();
                rawMeds.forEach(function (m) {
                  var cls = window._ciDrugClass(m);
                  if (cls) onClasses.add(cls);
                });

                // Globally accepted prescription order
                var PROTOCOL_ORDER = [
                  "THYR-HYPO-01",
                  "THYR-SUBCLIN-01", // 1. Thyroid
                  "GLY-PRE-01",
                  "GLY-STD-01",
                  "GLY-STD-02",
                  "GLY-STD-02B", // 2. Glycaemic
                  "GLY-A1C-HIGH-01",
                  "GLY-THYR-01",
                  "LIP-STD-01",
                  "LIP-CVD-01",
                  "LIP-HDL-01",
                  "LIP-TG-01", // 3. Lipids
                  "BP-DIAB-MICRO-01",
                  "BP-STEP2-01",
                  "BP-STEP3-01", // 4. BP / Cardiovascular
                  "REN-G2-01",
                  "REN-EARLY-01",
                  "REN-CKD-01", // 5. Renal
                  "MICRO-VITD-01",
                  "MICRO-B12-01",
                  "ANA-IRON-01", // 6. Supplements
                  "GLY-MASLD-01", // 7. GLP-1 (MASLD)
                ];
                // Protocols without a drug card (no formulary_match) = screening/monitoring
                var recs = (patientCI.recommendations || []).filter(function (r) {
                  return r.formulary_match;
                });
                var screeningCards = (patientCI.recommendations || []).filter(function (r) {
                  return !r.formulary_match;
                });
                var monitoringCards = patientCI.monitoring || [];

                // Sort recs by PROTOCOL_ORDER
                recs = recs.slice().sort(function (a, b) {
                  var ai = PROTOCOL_ORDER.indexOf(a.protocol_id);
                  var bi = PROTOCOL_ORDER.indexOf(b.protocol_id);
                  if (ai === -1) ai = 999;
                  if (bi === -1) bi = 999;
                  return ai - bi;
                });

                var allProtocols = recs;
                var safetyProtocols = patientCI.safety_flags || [];

                return (
                  <div>
                    {/* Each recommendation protocol = one diagnosis block */}
                    {allProtocols.map(function (r, i) {
                      var fm = r.formulary_match;
                      var drugClass = fm ? fm.drug_class || "" : "";
                      var isOnMed =
                        onClasses.has(drugClass) ||
                        rawMeds.some(function (m) {
                          return (
                            (m || "")
                              .toUpperCase()
                              .indexOf(
                                fm && fm.brand ? fm.brand.split(" ")[0].toUpperCase() : "XXXXX",
                              ) !== -1
                          );
                        });
                      var isMonitoring =
                        r.protocol_id &&
                        (r.protocol_id.indexOf("MICRO-") === 0 ||
                          r.protocol_id.indexOf("MON-") === 0) &&
                        !fm;

                      return (
                        <div
                          key={i}
                          style={{
                            background: "white",
                            border: "1px solid #e2e8f0",
                            borderRadius: 7,
                            padding: "6px 9px",
                            marginBottom: 5,
                            fontSize: 10,
                          }}
                        >
                          {/* Diagnosis / protocol name */}
                          <div
                            style={{
                              fontWeight: 700,
                              color: "#1e293b",
                              fontSize: 10,
                              marginBottom: 3,
                            }}
                          >
                            {r.title}
                          </div>

                          {/* Drug status block */}
                          {fm ? (
                            isOnMed ? (
                              /* Already prescribed — show actual prescribed med name + dose */
                              (function () {
                                var brandKey = (fm.brand || "").split(" ")[0].toUpperCase();
                                var actualMed = rawMeds.find(function (m) {
                                  return (m || "").toUpperCase().indexOf(brandKey) !== -1;
                                });
                                return (
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 6,
                                      background: "#f0fdf4",
                                      border: "1px solid #bbf7d0",
                                      borderRadius: 5,
                                      padding: "4px 8px",
                                    }}
                                  >
                                    <span style={{ fontSize: 13 }}>{"✅"}</span>
                                    <div>
                                      <div
                                        style={{ fontWeight: 700, color: "#166534", fontSize: 10 }}
                                      >
                                        {actualMed ? window._ciCleanMed(actualMed) : fm.brand}
                                      </div>
                                      <div style={{ color: "#15803d", fontSize: 9 }}>
                                        {"Already prescribed — no change needed"}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()
                            ) : (
                              /* Missing — recommend adding */
                              <div
                                style={{
                                  background: "#eff6ff",
                                  border: "1px solid #93c5fd",
                                  borderRadius: 5,
                                  padding: "5px 8px",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 5,
                                    marginBottom: 3,
                                  }}
                                >
                                  <span style={{ fontSize: 11, fontWeight: 800, color: "#1d4ed8" }}>
                                    {"➕ ADD:"}
                                  </span>
                                  <span style={{ fontWeight: 800, color: "#1e40af", fontSize: 11 }}>
                                    {fm.brand}
                                  </span>
                                  <span style={{ color: "#3b82f6", fontSize: 9 }}>
                                    {" — " + fm.formulation}
                                  </span>
                                </div>
                                <div style={{ color: "#1e3a5f", fontSize: 9 }}>
                                  {"▶ " + fm.starting_dose}
                                </div>
                                {fm.uptitration && (
                                  <div style={{ color: "#1e3a5f", fontSize: 9 }}>
                                    {"↑ " + fm.uptitration}
                                  </div>
                                )}
                                {fm.timing && (
                                  <div style={{ color: "#1e40af", fontSize: 9 }}>
                                    {"🕐 " + fm.timing}
                                  </div>
                                )}
                                {fm.substitute_with && (
                                  <div style={{ color: "#92400e", fontSize: 9, marginTop: 2 }}>
                                    {"⚡ If not tolerated: " + fm.substitute_with}
                                  </div>
                                )}
                              </div>
                            )
                          ) : (
                            /* No formulary card — monitoring or reasoning card */
                            r.dose_notes && (
                              <div
                                style={{
                                  color: "#475569",
                                  fontSize: 9,
                                  lineHeight: 1.5,
                                  marginTop: 2,
                                }}
                              >
                                {r.dose_notes}
                              </div>
                            )
                          )}
                        </div>
                      );
                    })}

                    {/* ── Continuation meds — always show these drug classes if patient is on them ── */}
                    {(function () {
                      var CONT_DEFS = [
                        {
                          keys: ["GLYCOMET", "METFORMIN", "GLUCONORM", "OBIMET"],
                          label: "Glycaemic management — Metformin",
                          color: "#065f46",
                          bg: "#f0fdf4",
                          border: "#bbf7d0",
                        },
                        {
                          keys: [
                            "LIPITAS",
                            "ATORVASTATIN",
                            "ROZAVEL",
                            "ROSUVAS",
                            "ATCHOL",
                            "CRESTOR",
                            "FENOFIBRATE",
                            "TRICOR",
                            "LIPICURE",
                          ],
                          label: "Lipid management",
                          color: "#1e3a5f",
                          bg: "#f0f9ff",
                          border: "#bae6fd",
                        },
                      ];
                      var blocks = [];
                      CONT_DEFS.forEach(function (def) {
                        // Find all meds matching this class
                        var matched = rawMeds.filter(function (m) {
                          var u = (m || "").toUpperCase();
                          return def.keys.some(function (k) {
                            return u.indexOf(k) !== -1;
                          });
                        });
                        if (matched.length === 0) return;
                        // Skip if already shown as "already prescribed" in a protocol card above
                        var shownInProtocol = (patientCI.recommendations || []).some(function (r) {
                          if (!r.formulary_match) return false;
                          var brand = (r.formulary_match.brand || "").toUpperCase();
                          return def.keys.some(function (k) {
                            return brand.indexOf(k) !== -1;
                          });
                        });
                        if (shownInProtocol) return;
                        blocks.push({
                          label: def.label,
                          meds: matched,
                          color: def.color,
                          bg: def.bg,
                          border: def.border,
                        });
                      });
                      if (blocks.length === 0) return null;
                      return blocks.map(function (b, bi) {
                        return (
                          <div
                            key={"cont-" + bi}
                            style={{
                              background: "white",
                              border: "1px solid #e2e8f0",
                              borderRadius: 7,
                              padding: "6px 9px",
                              marginBottom: 5,
                              fontSize: 10,
                            }}
                          >
                            <div
                              style={{
                                fontWeight: 700,
                                color: "#1e293b",
                                fontSize: 10,
                                marginBottom: 3,
                              }}
                            >
                              {b.label}
                            </div>
                            {b.meds.map(function (med, mi) {
                              return (
                                <div
                                  key={mi}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    background: b.bg,
                                    border: "1px solid " + b.border,
                                    borderRadius: 5,
                                    padding: "4px 8px",
                                    marginBottom: mi < b.meds.length - 1 ? 3 : 0,
                                  }}
                                >
                                  <span style={{ fontSize: 13 }}>{"✅"}</span>
                                  <div>
                                    <div style={{ fontWeight: 700, color: b.color, fontSize: 10 }}>
                                      {window._ciCleanMed(med)}
                                    </div>
                                    <div style={{ color: b.color, fontSize: 9, opacity: 0.8 }}>
                                      {"Already prescribed — no change needed"}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      });
                    })()}

                    {/* Contraindicated classes */}
                    {contraClasses.length > 0 && (
                      <div style={{ marginBottom: 5 }}>
                        {(snap.drug_history || [])
                          .filter(function (d) {
                            return d.contraindicated;
                          })
                          .map(function (d, i) {
                            return (
                              <div
                                key={i}
                                style={{
                                  background: "#fef2f2",
                                  border: "1px solid #fecaca",
                                  borderRadius: 7,
                                  padding: "5px 9px",
                                  marginBottom: 4,
                                  fontSize: 10,
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                  <span>{"⛔"}</span>
                                  <span style={{ fontWeight: 800, color: "#dc2626" }}>
                                    {d.drug_class}
                                  </span>
                                  {d.brand && (
                                    <span style={{ color: "#991b1b", fontSize: 9 }}>
                                      {"(" + d.brand + ")"}
                                    </span>
                                  )}
                                  <span style={{ fontSize: 9, color: "#991b1b", fontWeight: 600 }}>
                                    {"— CONTRAINDICATED"}
                                  </span>
                                </div>
                                {d.stopped_reason && (
                                  <div style={{ color: "#7f1d1d", fontSize: 9, marginTop: 2 }}>
                                    {d.stopped_reason}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {/* Current medications confirmed */}
                    {rawMeds.length > 0 && (
                      <div style={{ marginBottom: 5 }}>
                        <div
                          style={{
                            fontSize: 9,
                            fontWeight: 800,
                            color: "#0369a1",
                            marginBottom: 3,
                          }}
                        >
                          {"💊 CURRENT MEDICATIONS"}
                        </div>
                        <div
                          style={{
                            background: "#f0f9ff",
                            border: "1px solid #bae6fd",
                            borderRadius: 6,
                            padding: "5px 8px",
                          }}
                        >
                          {rawMeds.map(function (med, i) {
                            return (
                              <div
                                key={i}
                                style={{ fontSize: 9, color: "#075985", padding: "1px 0" }}
                              >
                                {"• " + window._ciCleanMed(med)}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Safety flags */}
                    {safetyProtocols.length > 0 && (
                      <div style={{ marginBottom: 5 }}>
                        <div
                          style={{
                            fontSize: 9,
                            fontWeight: 800,
                            color: "#dc2626",
                            marginBottom: 3,
                          }}
                        >
                          {"⚠️ SAFETY FLAGS"}
                        </div>
                        {safetyProtocols.map(function (f, i) {
                          return (
                            <div
                              key={i}
                              style={{
                                background: "#fef2f2",
                                border: "1px solid #fecaca",
                                borderRadius: 6,
                                padding: "5px 8px",
                                marginBottom: 3,
                                fontSize: 10,
                              }}
                            >
                              <div style={{ fontWeight: 700, color: "#dc2626" }}>
                                {f.title.replace("SAFETY HARD STOP: ", "").replace("SAFETY: ", "")}
                              </div>
                              {f.dose_notes && (
                                <div
                                  style={{
                                    color: "#7f1d1d",
                                    marginTop: 2,
                                    fontSize: 9,
                                    lineHeight: 1.4,
                                  }}
                                >
                                  {f.dose_notes}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Screening & Monitoring — separate section at bottom */}
                    {(screeningCards.length > 0 || monitoringCards.length > 0) && (
                      <div style={{ marginTop: 6 }}>
                        <div
                          style={{
                            fontSize: 9,
                            fontWeight: 800,
                            color: "#7c3aed",
                            marginBottom: 4,
                            letterSpacing: 0.5,
                          }}
                        >
                          {"🔍 SCREENING & MONITORING"}
                        </div>
                        {screeningCards.concat(monitoringCards).map(function (m, i) {
                          return (
                            <div
                              key={"scr-" + i}
                              style={{
                                background: "#faf5ff",
                                border: "1px solid #e9d5ff",
                                borderRadius: 6,
                                padding: "5px 8px",
                                marginBottom: 3,
                                fontSize: 10,
                              }}
                            >
                              <div style={{ fontWeight: 700, color: "#5b21b6", fontSize: 10 }}>
                                {m.title}
                              </div>
                              {m.dose_notes && (
                                <div
                                  style={{
                                    color: "#4c1d95",
                                    fontSize: 9,
                                    marginTop: 1,
                                    lineHeight: 1.4,
                                  }}
                                >
                                  {m.dose_notes}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* 4 PATH OPTIONS */}
      {!fuPlanSource && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          {[
            {
              id: "edit",
              icon: "✏️",
              title: "From Quick Edits",
              desc: "Use medication edits from Step 3",
              color: "#059669",
              bg: "#f0fdf4",
            },
            {
              id: "shadow",
              icon: "🤖",
              title: "Shadow AI Analysis",
              desc: "AI analyzes labs + trends + meds",
              color: "#7c3aed",
              bg: "#faf5ff",
            },
            {
              id: "consultant",
              icon: "🎙️",
              title: "Consultant Dictation",
              desc: "Consultant dictates changes",
              color: "#9a3412",
              bg: "#fff7ed",
            },
            {
              id: "merge",
              icon: "🔀",
              title: "AI + Consultant Merge",
              desc: "AI first, consultant reviews & overrides",
              color: "#1e40af",
              bg: "#eff6ff",
            },
          ].map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setFuPlanSource(p.id);
                if (p.id === "shadow" || p.id === "merge") {
                  runShadowAI();
                }
              }}
              style={{
                padding: 14,
                background: p.bg,
                border: `2px solid ${p.color}30`,
                borderRadius: 10,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 4 }}>{p.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: p.color }}>{p.title}</div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>{p.desc}</div>
            </button>
          ))}
        </div>
      )}

      {/* PATH: Quick Edit → Plan */}
      {fuPlanSource === "edit" && (
        <div
          style={{
            background: "white",
            borderRadius: 10,
            padding: 14,
            border: "2px solid #059669",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 800, color: "#059669", marginBottom: 6 }}>
            ✏️ Generate from Quick Edits
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
            {Object.values(fuMedEdits).filter((e) => e.action === "MODIFY").length} modified,{" "}
            {Object.values(fuMedEdits).filter((e) => e.action === "STOP").length} stopped,{" "}
            {fuNewMeds.filter((m) => m.name).length} new
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#475569",
              marginBottom: 8,
              background: "#f8fafc",
              padding: 8,
              borderRadius: 6,
            }}
          >
            This will use your med edits to build the treatment plan. For more intelligent analysis,
            try Shadow AI.
          </div>
          <button
            onClick={() => {
              // Build conData from edits — use conData state (NOT pfd.con_data which is empty)
              const lastConData = conData || pfd?.consultations?.[0]?.con_data || {};
              // Fall back to DB medications if con_data has no medications_confirmed
              const conMeds = lastConData.medications_confirmed || [];
              const lastMeds =
                conMeds.length > 0
                  ? conMeds
                  : (() => {
                      const seen = new Set();
                      return (pfd?.medications || [])
                        .filter((m) => {
                          const k = (m.name || "").toUpperCase().replace(/\s+/g, "");
                          if (seen.has(k)) return false;
                          seen.add(k);
                          return true;
                        })
                        .map((m) => ({
                          name: m.name || "",
                          composition: m.composition || "",
                          dose: m.dose || "",
                          frequency: m.frequency || "",
                          timing: m.timing || "",
                          route: m.route || "Oral",
                          forDiagnosis: m.for_diagnosis ? [m.for_diagnosis] : [],
                          isNew: false,
                        }));
                    })();
              const meds = lastMeds
                .filter((m, i) => fuMedEdits[i]?.action !== "STOP")
                .map((m, i) => {
                  const edit = fuMedEdits[i] || {};
                  return {
                    ...m,
                    dose: edit.dose || m.dose,
                    frequency: edit.freq || m.frequency,
                    isNew: false,
                    _shadowAction: edit.action === "MODIFY" ? "MODIFY" : "CONTINUE",
                  };
                });
              fuNewMeds
                .filter((nm) => nm.name.trim())
                .forEach((nm) => {
                  meds.push({
                    name: nm.name.toUpperCase(),
                    dose: nm.dose,
                    frequency: nm.freq,
                    timing: nm.timing,
                    isNew: true,
                    route: "Oral",
                    forDiagnosis: [nm.forDx || ""],
                    _shadowAction: "ADD",
                  });
                });
              // Include external consultant meds that weren't stopped
              const medNames = new Set(
                meds.map((m) => (m.name || "").toUpperCase().replace(/\s+/g, "")),
              );
              (pfd?.medications || [])
                .filter(
                  (m) =>
                    m.is_active !== false &&
                    !medNames.has((m.name || "").toUpperCase().replace(/\s+/g, "")) &&
                    (m.prescriber || m.con_name || "") !==
                      (pfd?.consultations?.[0]?.con_name || "") &&
                    fuMedEdits[
                      `ext_${(pfd?.medications || []).filter((em) => em.is_active !== false && !medNames.has((em.name || "").toUpperCase().replace(/\s+/g, ""))).indexOf(m)}`
                    ]?.action !== "STOP",
                )
                .forEach((m) => {
                  const k = (m.name || "").toUpperCase().replace(/\s+/g, "");
                  if (!medNames.has(k)) {
                    medNames.add(k);
                    meds.push({
                      name: m.name || "",
                      composition: m.composition || "",
                      dose: m.dose || "",
                      frequency: m.frequency || "",
                      timing: m.timing || "",
                      route: m.route || "Oral",
                      isNew: false,
                      forDiagnosis: m.for_diagnosis ? [m.for_diagnosis] : [],
                      _shadowAction: "CONTINUE",
                      prescriber: m.prescriber || m.con_name || "External",
                    });
                  }
                });
              const stoppedMeds = [
                ...lastMeds
                  .filter((m, i) => fuMedEdits[i]?.action === "STOP")
                  .map((m) => ({ name: m.name, reason: "Stopped at follow-up" })),
              ];
              const newConData = {
                ...lastConData,
                medications_confirmed: fixConMedicines({ medications_confirmed: meds })
                  .medications_confirmed,
                medications_stopped: stoppedMeds,
                assessment_summary:
                  lastConData.assessment_summary ||
                  `Follow-up visit. ${Object.values(fuMedEdits).filter((e) => e.action === "MODIFY").length} medications modified, ${Object.values(fuMedEdits).filter((e) => e.action === "STOP").length} stopped, ${fuNewMeds.filter((m) => m.name).length} new added.`,
              };
              setConData(newConData);
              if (!moData) {
                setMoData({
                  diagnoses: pfd?.diagnoses || [],
                  chief_complaints: complaints,
                  previous_medications: lastMeds,
                });
              }
              navigate("/plan");
            }}
            style={{
              width: "100%",
              padding: 12,
              background: "linear-gradient(135deg,#059669,#047857)",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            📄 Generate Treatment Plan from Edits
          </button>
        </div>
      )}

      {/* PATH: Shadow AI (running / results) */}
      {(fuPlanSource === "shadow" || fuPlanSource === "merge") && (
        <div style={{ marginBottom: 12 }}>
          {shadowLoading && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: "#7c3aed",
                fontSize: 13,
                fontWeight: 700,
                background: "white",
                borderRadius: 10,
                border: "2px solid #c4b5fd",
              }}
            >
              🧠 AI analyzing labs, trends, medications, history...
            </div>
          )}
          {shadowData && (
            <div
              style={{
                background: "white",
                borderRadius: 10,
                border: "2px solid #c4b5fd",
                overflow: "hidden",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  padding: "8px 12px",
                  background: "#faf5ff",
                  borderBottom: "2px solid #c4b5fd",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 800, color: "#6d28d9" }}>
                  🤖 Shadow AI Analysis
                </div>
              </div>
              <div style={{ padding: 12 }}>
                {/* Diagnoses */}
                {(shadowData.diagnoses || []).length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>
                      🏥 Diagnoses
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {shadowData.diagnoses.map((d, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 10,
                            padding: "3px 8px",
                            borderRadius: 5,
                            fontWeight: 700,
                            background:
                              d.status === "Uncontrolled"
                                ? "#fef2f2"
                                : d.status === "New"
                                  ? "#eff6ff"
                                  : "#f0fdf4",
                            color:
                              d.status === "Uncontrolled"
                                ? "#dc2626"
                                : d.status === "New"
                                  ? "#2563eb"
                                  : "#059669",
                            border: `1px solid ${d.status === "Uncontrolled" ? "#fecaca" : d.status === "New" ? "#bfdbfe" : "#bbf7d0"}`,
                          }}
                        >
                          {d.label} • {d.status}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Treatment recommendations */}
                {(shadowData.treatment_plan || []).length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>
                      💊 Medication Recommendations
                    </div>
                    {shadowData.treatment_plan.map((t, i) => {
                      const key = t.drug || `tx_${i}`;
                      const decision = shadowTxDecisions[key];
                      return (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "5px 8px",
                            marginBottom: 3,
                            borderRadius: 6,
                            background:
                              t.action === "ADD"
                                ? "#f0fdf4"
                                : t.action === "STOP"
                                  ? "#fef2f2"
                                  : t.action === "MODIFY"
                                    ? "#fffbeb"
                                    : "#f8fafc",
                            border: `1px solid ${t.action === "ADD" ? "#bbf7d0" : t.action === "STOP" ? "#fecaca" : t.action === "MODIFY" ? "#fde68a" : "#e2e8f0"}`,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              minWidth: 40,
                              color:
                                t.action === "ADD"
                                  ? "#059669"
                                  : t.action === "STOP"
                                    ? "#dc2626"
                                    : t.action === "MODIFY"
                                      ? "#d97706"
                                      : "#475569",
                            }}
                          >
                            {t.action}
                          </span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 11, fontWeight: 700 }}>{t.drug}</span>
                            <span style={{ fontSize: 10, color: "#64748b", marginLeft: 4 }}>
                              {t.dose || ""} {t.frequency || ""}
                            </span>
                            {t.reason && (
                              <div style={{ fontSize: 9, color: "#94a3b8" }}>{t.reason}</div>
                            )}
                          </div>
                          <div className="no-print" style={{ display: "flex", gap: 2 }}>
                            <button
                              onClick={() =>
                                setShadowTxDecisions((p) => ({
                                  ...p,
                                  [key]: decision === "adopt" ? undefined : "adopt",
                                }))
                              }
                              style={{
                                fontSize: 9,
                                padding: "2px 6px",
                                borderRadius: 4,
                                border: "none",
                                cursor: "pointer",
                                fontWeight: 700,
                                background: decision === "adopt" ? "#059669" : "#f0fdf4",
                                color: decision === "adopt" ? "white" : "#059669",
                              }}
                            >
                              ✓
                            </button>
                            <button
                              onClick={() =>
                                setShadowTxDecisions((p) => ({
                                  ...p,
                                  [key]: decision === "disagree" ? undefined : "disagree",
                                }))
                              }
                              style={{
                                fontSize: 9,
                                padding: "2px 6px",
                                borderRadius: 4,
                                border: "none",
                                cursor: "pointer",
                                fontWeight: 700,
                                background: decision === "disagree" ? "#dc2626" : "#fef2f2",
                                color: decision === "disagree" ? "white" : "#dc2626",
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Investigations */}
                {(shadowData.investigations || []).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 3 }}>
                      🧪 Investigations
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {shadowData.investigations.map((t, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 10,
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: "#eff6ff",
                            color: "#2563eb",
                            fontWeight: 600,
                          }}
                        >
                          {typeof t === "string" ? t : t.test || ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Red flags */}
                {(shadowData.red_flags || []).length > 0 && (
                  <div>
                    {shadowData.red_flags.map((rf, i) => (
                      <div key={i} style={{ fontSize: 10, color: "#dc2626", padding: "2px 0" }}>
                        ⚠️ {rf}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Shadow-only: adopt button */}
              {fuPlanSource === "shadow" && (
                <div
                  style={{ padding: 12, borderTop: "2px solid #c4b5fd", display: "flex", gap: 6 }}
                >
                  <button
                    onClick={() => {
                      // Adopt shadow AI as conData
                      const adopted = (shadowData.treatment_plan || []).filter((t) => {
                        const key = t.drug || `tx_${(shadowData.treatment_plan || []).indexOf(t)}`;
                        return shadowTxDecisions[key] !== "disagree";
                      });
                      const meds = adopted
                        .filter((t) => t.action !== "STOP")
                        .map((t) => ({
                          name: (t.drug || "").toUpperCase(),
                          dose: t.dose || "",
                          frequency: t.frequency || "",
                          timing: t.timing || "",
                          forDiagnosis: t.for ? [t.for] : [],
                          isNew: t.action === "ADD",
                          _shadowAction: t.action,
                          route: "Oral",
                        }));
                      const stopped = adopted
                        .filter((t) => t.action === "STOP")
                        .map((t) => ({ name: t.drug, reason: t.reason || "AI recommended stop" }));
                      const newConData = {
                        diagnoses: shadowData.diagnoses || [],
                        medications_confirmed: fixConMedicines({ medications_confirmed: meds })
                          .medications_confirmed,
                        medications_stopped: stopped,
                        goals: shadowData.goals || [],
                        investigations_ordered: shadowData.investigations || [],
                        diet_lifestyle: shadowData.diet_lifestyle || [],
                        self_monitoring: shadowData.self_monitoring || [],
                        follow_up: shadowData.follow_up || {},
                        assessment_summary:
                          shadowData.assessment_summary ||
                          `AI-generated treatment plan based on ${pfd?.consultations?.length || 0} previous visits.`,
                        red_flags: shadowData.red_flags || [],
                        _fromShadow: true,
                      };
                      setConData(newConData);
                      if (!moData) {
                        setMoData({
                          diagnoses: shadowData.diagnoses || [],
                          chief_complaints: complaints,
                          previous_medications: pfd?.medications || [],
                        });
                      }
                      navigate("/plan");
                    }}
                    style={{
                      flex: 1,
                      padding: 12,
                      background: "linear-gradient(135deg,#7c3aed,#6d28d9)",
                      color: "white",
                      border: "none",
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    ✅ Adopt AI Plan → View
                  </button>
                  <button
                    onClick={() => setFuPlanSource("merge")}
                    style={{
                      padding: "12px 16px",
                      background: "#f8fafc",
                      border: "2px solid #e2e8f0",
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      color: "#475569",
                    }}
                  >
                    + Add Consultant Notes
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* PATH: Consultant dictation / Merge */}
      {(fuPlanSource === "consultant" ||
        (fuPlanSource === "merge" && shadowData && !shadowLoading)) && (
        <div
          style={{
            background: "white",
            borderRadius: 10,
            border: `2px solid ${fuPlanSource === "merge" ? "#1e40af" : "#9a3412"}`,
            overflow: "hidden",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              background: fuPlanSource === "merge" ? "#eff6ff" : "#fff7ed",
              borderBottom: "2px solid #e2e8f0",
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: fuPlanSource === "merge" ? "#1e40af" : "#9a3412",
              }}
            >
              {fuPlanSource === "merge"
                ? "🔀 Consultant Reviews AI + Dictates"
                : "🎙️ Consultant Dictation"}
            </div>
          </div>
          <div style={{ padding: 12 }}>
            <AudioInput
              label="Dictate treatment plan changes"
              dgKey={dgKey}
              whisperKey={whisperKey}
              color={fuPlanSource === "merge" ? "#1e40af" : "#9a3412"}
              compact
              onTranscript={(t) => {
                const cur = useClinicalStore.getState().conTranscript;
                setConTranscript((cur ? cur + "\n" : "") + t);
              }}
            />
            <textarea
              value={conTranscript || ""}
              onChange={(e) => setConTranscript(e.target.value)}
              placeholder={
                fuPlanSource === "merge"
                  ? "Consultant: I agree with statin increase, reduce thyroid to 50, also add calcium 500 BD..."
                  : "Dictate full plan: Continue DM meds, increase statin, reduce thyroid..."
              }
              rows={4}
              style={{
                width: "100%",
                fontSize: 13,
                padding: 10,
                border: "2px solid #e2e8f0",
                borderRadius: 8,
                resize: "vertical",
                boxSizing: "border-box",
                lineHeight: 1.5,
                marginTop: 6,
              }}
            />
            <button
              onClick={() => {
                if (fuPlanSource === "merge") {
                  setConSourceMode("merge");
                }
                processConsultant();
                navigate("/plan");
              }}
              disabled={loading.con || !conTranscript}
              style={{
                width: "100%",
                marginTop: 8,
                padding: 12,
                background: loading.con
                  ? "#94a3b8"
                  : `linear-gradient(135deg,${fuPlanSource === "merge" ? "#1e40af,#1d4ed8" : "#9a3412,#7c2d12"})`,
                color: "white",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 800,
                cursor: loading.con ? "wait" : "pointer",
              }}
            >
              {loading.con
                ? "⏳ Processing..."
                : fuPlanSource === "merge"
                  ? "🔀 Merge & Generate Plan"
                  : "📄 Generate Plan from Dictation"}
            </button>
          </div>
        </div>
      )}

      {/* Back to path selection */}
      {fuPlanSource && (
        <button
          onClick={() => {
            setFuPlanSource(null);
            setShadowData(null);
            setShadowTxDecisions({});
          }}
          style={{
            width: "100%",
            padding: 8,
            background: "#f8fafc",
            border: "2px solid #e2e8f0",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            color: "#64748b",
            marginTop: 8,
          }}
        >
          ← Choose Different Path
        </button>
      )}
    </div>
  );
}
