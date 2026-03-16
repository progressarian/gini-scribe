import { useEffect } from "react";
import "./ReportsPage.css";
import usePatientStore from "../stores/patientStore";
import useReportsStore from "../stores/reportsStore";
import Shimmer from "../components/Shimmer.jsx";

export default function ReportsPage() {
  const patient = usePatientStore((s) => s.patient);
  const loadPatientDB = usePatientStore((s) => s.loadPatientDB);
  const reportData = useReportsStore((s) => s.reportData);
  const reportDx = useReportsStore((s) => s.reportDx);
  const reportDoctors = useReportsStore((s) => s.reportDoctors);
  const reportPeriod = useReportsStore((s) => s.reportPeriod);
  const setReportPeriod = useReportsStore((s) => s.setReportPeriod);
  const reportDoctor = useReportsStore((s) => s.reportDoctor);
  const reportLoading = useReportsStore((s) => s.reportLoading);
  const reportQuery = useReportsStore((s) => s.reportQuery);
  const setReportQuery = useReportsStore((s) => s.setReportQuery);
  const reportQueryResult = useReportsStore((s) => s.reportQueryResult);
  const reportQueryLoading = useReportsStore((s) => s.reportQueryLoading);
  const reportSection = useReportsStore((s) => s.reportSection);
  const setReportSection = useReportsStore((s) => s.setReportSection);
  const reportDrillBio = useReportsStore((s) => s.reportDrillBio);
  const setReportDrillBio = useReportsStore((s) => s.setReportDrillBio);
  const reportDrillPt = useReportsStore((s) => s.reportDrillPt);
  const setReportDrillPt = useReportsStore((s) => s.setReportDrillPt);
  const loadReports = useReportsStore((s) => s.loadReports);
  const runReportQuery = useReportsStore((s) => s.runReportQuery);

  useEffect(() => {
    loadReports(reportPeriod, reportDoctor);
  }, [loadReports, reportPeriod, reportDoctor]);

  return (
    <div>
      {/* Report Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#1e293b" }}>📊 Clinical Reports</div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => loadReports(reportPeriod, reportDoctor)}
          disabled={reportLoading}
          style={{
            background: "#2563eb",
            color: "white",
            border: "none",
            padding: "4px 12px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {reportLoading ? "⏳ Loading..." : "🔄 Refresh"}
        </button>
      </div>

      {/* Section Tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          marginBottom: 10,
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid #e2e8f0",
        }}
      >
        {[
          { id: "summary", label: "🎯 Dashboard" },
          { id: "diagnoses", label: "🏥 Diagnoses" },
          { id: "query", label: "🤖 AI Query" },
          { id: "doctors", label: "👨‍⚕️ Doctors" },
        ].map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setReportSection(s.id);
              if (!reportData || !reportDx || !reportDoctors)
                loadReports(reportPeriod, reportDoctor);
            }}
            style={{
              flex: 1,
              padding: "7px 4px",
              fontSize: 10,
              fontWeight: 600,
              cursor: "pointer",
              border: "none",
              background: reportSection === s.id ? "#1e293b" : "white",
              color: reportSection === s.id ? "white" : "#64748b",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ═══ TODAY'S SUMMARY ═══ */}
      {reportSection === "summary" && (
        <div>
          {/* Period filters */}
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
            {[
              { l: "Today", v: "today" },
              { l: "This Week", v: "week" },
              { l: "This Month", v: "month" },
              { l: "Quarter", v: "quarter" },
              { l: "Year", v: "year" },
              { l: "All", v: "all" },
            ].map((f) => (
              <button
                key={f.v}
                onClick={() => {
                  setReportPeriod(f.v);
                  loadReports(f.v, reportDoctor);
                }}
                style={{
                  padding: "3px 10px",
                  borderRadius: 20,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: reportPeriod === f.v ? "2px solid #2563eb" : "1px solid #e2e8f0",
                  background: reportPeriod === f.v ? "#eff6ff" : "white",
                  color: reportPeriod === f.v ? "#2563eb" : "#64748b",
                }}
              >
                {f.l}
              </button>
            ))}
          </div>

          {reportLoading ? (
            <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 16 }}>
              <Shimmer type="stats" count={3} />
              <Shimmer type="table" count={6} />
            </div>
          ) : !reportData ? (
            <div style={{ textAlign: "center", padding: 30 }}>
              <button
                onClick={() => loadReports(reportPeriod, reportDoctor)}
                style={{
                  background: "#2563eb",
                  color: "white",
                  border: "none",
                  padding: "10px 24px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Load Reports
              </button>
            </div>
          ) : (
            <div>
              {/* Total patients card */}
              <div
                style={{
                  background: "linear-gradient(135deg,#1e293b,#334155)",
                  borderRadius: 10,
                  padding: "12px 16px",
                  marginBottom: 10,
                  color: "white",
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <div>
                    <div style={{ fontSize: 28, fontWeight: 900 }}>{reportData.total}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>Patients Seen</div>
                  </div>
                  {reportData.by_doctor && Object.keys(reportData.by_doctor).length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        justifyContent: "flex-end",
                        maxWidth: "60%",
                      }}
                    >
                      {Object.entries(reportData.by_doctor).map(([doc, count]) => (
                        <span
                          key={doc}
                          style={{
                            background: "rgba(255,255,255,.15)",
                            borderRadius: 12,
                            padding: "2px 8px",
                            fontSize: 9,
                          }}
                        >
                          {doc}: {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ═══ BIOMARKER CONTROL RATES ═══ */}
              <div style={{ fontSize: 11, fontWeight: 800, color: "#1e293b", marginBottom: 6 }}>
                🎯 BIOMARKER CONTROL RATES
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
                {(reportData.biomarkers || [])
                  .filter((b) => b.tested > 0)
                  .map((bio) => {
                    const pct = bio.pct;
                    const pctColor = pct >= 70 ? "#059669" : pct >= 40 ? "#d97706" : "#dc2626";
                    const isExpanded = reportDrillBio === bio.key;
                    return (
                      <div key={bio.key}>
                        <div
                          onClick={() => setReportDrillBio(isExpanded ? null : bio.key)}
                          style={{
                            background: "white",
                            border: "1px solid #e2e8f0",
                            borderRadius: 8,
                            padding: "8px 12px",
                            cursor: "pointer",
                            transition: "all .15s",
                            borderColor: isExpanded ? "#2563eb" : "#e2e8f0",
                            boxShadow: isExpanded ? "0 0 0 2px rgba(37,99,235,.15)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isExpanded) e.currentTarget.style.borderColor = "#cbd5e1";
                          }}
                          onMouseLeave={(e) => {
                            if (!isExpanded) e.currentTarget.style.borderColor = "#e2e8f0";
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginBottom: 4,
                            }}
                          >
                            <span style={{ fontSize: 14 }}>{bio.emoji}</span>
                            <div style={{ flex: 1 }}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                }}
                              >
                                <span style={{ fontSize: 12, fontWeight: 700 }}>{bio.label}</span>
                                <span style={{ fontSize: 11, fontWeight: 800, color: pctColor }}>
                                  {pct}%
                                </span>
                              </div>
                              <div style={{ fontSize: 9, color: "#94a3b8" }}>
                                Target: {bio.target}
                              </div>
                            </div>
                          </div>
                          {/* Progress bar */}
                          <div
                            style={{
                              display: "flex",
                              height: 6,
                              borderRadius: 3,
                              overflow: "hidden",
                              background: "#f1f5f9",
                              gap: 1,
                            }}
                          >
                            {bio.in_control > 0 && (
                              <div
                                style={{
                                  width: `${(bio.in_control / bio.total) * 100}%`,
                                  background: "#22c55e",
                                  borderRadius: 3,
                                }}
                              />
                            )}
                            {bio.warning > 0 && (
                              <div
                                style={{
                                  width: `${(bio.warning / bio.total) * 100}%`,
                                  background: "#f59e0b",
                                  borderRadius: 3,
                                }}
                              />
                            )}
                            {bio.out_control > 0 && (
                              <div
                                style={{
                                  width: `${(bio.out_control / bio.total) * 100}%`,
                                  background: "#ef4444",
                                  borderRadius: 3,
                                }}
                              />
                            )}
                            {bio.no_data > 0 && (
                              <div
                                style={{
                                  width: `${(bio.no_data / bio.total) * 100}%`,
                                  background: "#e2e8f0",
                                  borderRadius: 3,
                                }}
                              />
                            )}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              fontSize: 9,
                              color: "#64748b",
                              marginTop: 3,
                            }}
                          >
                            <span style={{ color: "#059669" }}>✅ {bio.in_control}</span>
                            {bio.warning > 0 && (
                              <span style={{ color: "#d97706" }}>⚠️ {bio.warning}</span>
                            )}
                            <span style={{ color: "#dc2626" }}>❌ {bio.out_control}</span>
                            {bio.no_data > 0 && (
                              <span style={{ color: "#94a3b8" }}>— {bio.no_data} no data</span>
                            )}
                            <span style={{ marginLeft: "auto", fontSize: 8, color: "#94a3b8" }}>
                              {isExpanded ? "▲ Hide" : "▼ Details"}
                            </span>
                          </div>
                        </div>

                        {/* Drill-down patient list */}
                        {isExpanded && (
                          <div
                            style={{
                              background: "#f8fafc",
                              border: "1px solid #e2e8f0",
                              borderTop: "none",
                              borderRadius: "0 0 8px 8px",
                              padding: 6,
                              maxHeight: 300,
                              overflow: "auto",
                            }}
                          >
                            {bio.patients
                              .filter((p) => p.status !== "no_data")
                              .map((p, i) => (
                                <div
                                  key={i}
                                  onClick={() =>
                                    loadPatientDB({
                                      id: p.id,
                                      name: p.name,
                                      age: p.age,
                                      sex: p.sex,
                                      file_no: p.file_no,
                                    })
                                  }
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "4px 6px",
                                    borderBottom: "1px solid #e2e8f0",
                                    cursor: "pointer",
                                    fontSize: 10,
                                    borderRadius: 4,
                                  }}
                                  onMouseEnter={(e) =>
                                    (e.currentTarget.style.background = "#eff6ff")
                                  }
                                  onMouseLeave={(e) =>
                                    (e.currentTarget.style.background = "transparent")
                                  }
                                >
                                  <span style={{ fontSize: 11 }}>
                                    {p.status === "in_control"
                                      ? "✅"
                                      : p.status === "warning"
                                        ? "⚠️"
                                        : "❌"}
                                  </span>
                                  <div style={{ flex: 1 }}>
                                    <strong>{p.name}</strong>
                                    <span style={{ color: "#94a3b8", marginLeft: 4 }}>
                                      {p.age}Y/{p.sex?.charAt(0)}
                                    </span>
                                  </div>
                                  <span
                                    style={{
                                      fontWeight: 700,
                                      fontSize: 11,
                                      color:
                                        p.status === "in_control"
                                          ? "#059669"
                                          : p.status === "warning"
                                            ? "#d97706"
                                            : "#dc2626",
                                    }}
                                  >
                                    {p.display || "—"}
                                  </span>
                                  <span style={{ fontSize: 8, color: "#94a3b8" }}>
                                    {p.con_name}
                                  </span>
                                </div>
                              ))}
                            {bio.patients.filter((p) => p.status === "no_data").length > 0 && (
                              <div
                                style={{
                                  fontSize: 9,
                                  color: "#94a3b8",
                                  padding: "4px 6px",
                                  fontStyle: "italic",
                                }}
                              >
                                + {bio.patients.filter((p) => p.status === "no_data").length}{" "}
                                patients with no {bio.label} data
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>

              {/* ═══ PATIENT SCORECARD ═══ */}
              <div style={{ fontSize: 11, fontWeight: 800, color: "#1e293b", marginBottom: 6 }}>
                👥 PATIENT TARGET SCORECARD
              </div>
              <div style={{ maxHeight: 400, overflow: "auto" }}>
                {(reportData.patients || []).map((p, i) => {
                  const pctColor =
                    p.pct === null
                      ? "#94a3b8"
                      : p.pct >= 70
                        ? "#059669"
                        : p.pct >= 40
                          ? "#d97706"
                          : "#dc2626";
                  const isExpanded = reportDrillPt === p.id;
                  return (
                    <div key={i} style={{ marginBottom: 4 }}>
                      <div
                        onClick={() => setReportDrillPt(isExpanded ? null : p.id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                          background: "white",
                          border: "1px solid #e2e8f0",
                          borderRadius: 8,
                          cursor: "pointer",
                          fontSize: 11,
                          borderColor: isExpanded ? "#2563eb" : "#e2e8f0",
                        }}
                        onMouseEnter={(e) => {
                          if (!isExpanded) e.currentTarget.style.background = "#f8fafc";
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded) e.currentTarget.style.background = "white";
                        }}
                      >
                        {/* Score circle */}
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: "50%",
                            border: `3px solid ${pctColor}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <span style={{ fontSize: 11, fontWeight: 800, color: pctColor }}>
                            {p.pct !== null ? `${p.pct}%` : "—"}
                          </span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div>
                            <strong>{p.name}</strong>{" "}
                            <span style={{ color: "#94a3b8" }}>
                              {p.age}Y/{p.sex?.charAt(0)} {p.file_no && `| ${p.file_no}`}
                            </span>
                          </div>
                          <div style={{ fontSize: 9, color: "#64748b" }}>
                            {p.targets_total > 0
                              ? `${p.targets_met}/${p.targets_total} targets met`
                              : "No lab data"}
                            {p.con_name && ` • ${p.con_name}`}
                          </div>
                        </div>
                        {/* Mini traffic lights */}
                        <div
                          style={{
                            display: "flex",
                            gap: 2,
                            flexShrink: 0,
                            flexWrap: "wrap",
                            maxWidth: 100,
                            justifyContent: "flex-end",
                          }}
                        >
                          {Object.entries(p.conditions || {}).map(([key, c]) => (
                            <span
                              key={key}
                              title={`${c.label}: ${c.val} (${c.in_control ? "In target" : "Out of target"} — ${c.target})`}
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: c.in_control ? "#22c55e" : "#ef4444",
                              }}
                            />
                          ))}
                        </div>
                        <span style={{ fontSize: 9, color: "#94a3b8" }}>
                          {isExpanded ? "▲" : "▼"}
                        </span>
                      </div>

                      {/* Expanded patient detail */}
                      {isExpanded && (
                        <div
                          style={{
                            background: "#f8fafc",
                            border: "1px solid #e2e8f0",
                            borderTop: "none",
                            borderRadius: "0 0 8px 8px",
                            padding: 8,
                          }}
                        >
                          {/* Condition cards */}
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))",
                              gap: 4,
                              marginBottom: 6,
                            }}
                          >
                            {Object.entries(p.conditions || {}).map(([key, c]) => (
                              <div
                                key={key}
                                style={{
                                  background: c.in_control ? "#f0fdf4" : "#fef2f2",
                                  border: `1px solid ${c.in_control ? "#bbf7d0" : "#fecaca"}`,
                                  borderRadius: 6,
                                  padding: "4px 8px",
                                }}
                              >
                                <div style={{ fontSize: 9, color: "#64748b" }}>
                                  {c.emoji} {c.label}
                                </div>
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 800,
                                    color: c.in_control ? "#059669" : "#dc2626",
                                  }}
                                >
                                  {typeof c.val === "number"
                                    ? c.label === "Blood Pressure"
                                      ? c.val
                                      : c.val
                                    : c.val}
                                </div>
                                <div style={{ fontSize: 8, color: "#94a3b8" }}>
                                  Target: {c.target}
                                </div>
                              </div>
                            ))}
                          </div>
                          {/* Diagnoses */}
                          {p.diagnoses?.length > 0 && (
                            <div
                              style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}
                            >
                              {(p.diagnoses || [])
                                .filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i)
                                .map((d, di) => (
                                  <span
                                    key={di}
                                    style={{
                                      fontSize: 9,
                                      padding: "1px 6px",
                                      borderRadius: 4,
                                      background:
                                        d.status === "Uncontrolled"
                                          ? "#fef2f2"
                                          : d.status === "Controlled"
                                            ? "#f0fdf4"
                                            : "#f1f5f9",
                                      color:
                                        d.status === "Uncontrolled"
                                          ? "#dc2626"
                                          : d.status === "Controlled"
                                            ? "#059669"
                                            : "#64748b",
                                    }}
                                  >
                                    {d.label}
                                  </span>
                                ))}
                            </div>
                          )}
                          <button
                            onClick={() =>
                              loadPatientDB({
                                id: p.id,
                                name: p.name,
                                age: p.age,
                                sex: p.sex,
                                file_no: p.file_no,
                              })
                            }
                            style={{
                              background: "#2563eb",
                              color: "white",
                              border: "none",
                              padding: "3px 12px",
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            Open Patient →
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ DIAGNOSIS DISTRIBUTION ═══ */}
      {reportSection === "diagnoses" && (
        <div>
          {reportLoading ? (
            <div style={{ padding: 10 }}>
              <Shimmer type="cards" count={5} />
            </div>
          ) : !reportDx ? (
            <div style={{ textAlign: "center", padding: 30 }}>
              <button
                onClick={() => loadReports(reportPeriod, reportDoctor)}
                style={{
                  background: "#2563eb",
                  color: "white",
                  border: "none",
                  padding: "10px 24px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Load Reports
              </button>
            </div>
          ) : reportDx.length === 0 ? (
            <div style={{ textAlign: "center", padding: 30, color: "#94a3b8" }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>🏥</div>
              <div style={{ fontSize: 12 }}>
                No diagnosis data yet. Import patient records to see distribution.
              </div>
            </div>
          ) : (
            <div>
              {reportDx.slice(0, 12).map((dx, i) => {
                const maxCount = Math.max(...reportDx.map((d) => d.total));
                const controlPct = dx.total > 0 ? Math.round((dx.controlled / dx.total) * 100) : 0;
                return (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 11,
                        marginBottom: 2,
                      }}
                    >
                      <strong>{dx.label || dx.id}</strong>
                      <span style={{ color: "#64748b" }}>{dx.total} patients</span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        height: 20,
                        borderRadius: 4,
                        overflow: "hidden",
                        background: "#f1f5f9",
                      }}
                    >
                      {dx.controlled > 0 && (
                        <div
                          style={{
                            width: `${(dx.controlled / maxCount) * 100}%`,
                            background: "#22c55e",
                            transition: "width .3s",
                          }}
                          title={`Controlled: ${dx.controlled}`}
                        />
                      )}
                      {dx.uncontrolled > 0 && (
                        <div
                          style={{
                            width: `${(dx.uncontrolled / maxCount) * 100}%`,
                            background: "#ef4444",
                            transition: "width .3s",
                          }}
                          title={`Uncontrolled: ${dx.uncontrolled}`}
                        />
                      )}
                      {dx.present > 0 && (
                        <div
                          style={{
                            width: `${(dx.present / maxCount) * 100}%`,
                            background: "#3b82f6",
                            transition: "width .3s",
                          }}
                          title={`Present: ${dx.present}`}
                        />
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        fontSize: 9,
                        color: "#64748b",
                        marginTop: 1,
                      }}
                    >
                      {dx.controlled > 0 && (
                        <span>
                          ✅ {dx.controlled} controlled{dx.total > 0 ? ` (${controlPct}%)` : ""}
                        </span>
                      )}
                      {dx.uncontrolled > 0 && <span>⚠️ {dx.uncontrolled} uncontrolled</span>}
                      {dx.present > 0 && <span>📋 {dx.present} present</span>}
                      {dx.avg_hba1c && <span>📊 Avg HbA1c: {dx.avg_hba1c}%</span>}
                    </div>
                  </div>
                );
              })}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  justifyContent: "center",
                  fontSize: 10,
                  color: "#64748b",
                  marginTop: 8,
                }}
              >
                <span>🟢 Controlled</span>
                <span>🔴 Uncontrolled</span>
                <span>🔵 Present</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ AI QUERY ═══ */}
      {reportSection === "query" && (
        <div>
          <div
            style={{
              background: "linear-gradient(135deg,#faf5ff,#eff6ff)",
              borderRadius: 10,
              padding: 12,
              marginBottom: 10,
              border: "1px solid #c4b5fd",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6b21a8", marginBottom: 6 }}>
              🤖 Ask anything about your patient data
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
              {[
                "DM2 patients with HbA1c > 8",
                "Patients on Mounjaro - weight trends",
                "Overdue for HbA1c (>3 months)",
                "HTN patients with BP > 140/90",
                "Most prescribed medications",
                "Patients needing follow-up",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => setReportQuery(q)}
                  style={{
                    fontSize: 9,
                    background: "white",
                    border: "1px solid #d8b4fe",
                    padding: "3px 8px",
                    borderRadius: 20,
                    cursor: "pointer",
                    color: "#7c3aed",
                    fontWeight: 600,
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={reportQuery}
                onChange={(e) => setReportQuery(e.target.value)}
                placeholder="Ask a question about your patients..."
                onKeyDown={(e) => e.key === "Enter" && runReportQuery()}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "1px solid #d8b4fe",
                  borderRadius: 8,
                  fontSize: 12,
                  outline: "none",
                }}
              />
              <button
                onClick={runReportQuery}
                disabled={reportQueryLoading || !reportQuery.trim()}
                style={{
                  padding: "8px 16px",
                  background: reportQueryLoading ? "#94a3b8" : "#7c3aed",
                  color: "white",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: reportQueryLoading ? "wait" : "pointer",
                }}
              >
                {reportQueryLoading ? "⏳" : "Ask →"}
              </button>
            </div>
          </div>
          {reportQueryResult && (
            <div
              style={{
                background: "white",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: 14,
                fontSize: 12,
                lineHeight: 1.7,
                maxHeight: 500,
                overflow: "auto",
              }}
            >
              <div style={{ fontSize: 9, fontWeight: 700, color: "#7c3aed", marginBottom: 6 }}>
                🤖 AI ANALYSIS
              </div>
              {reportQueryResult.split("\n").map((line, li) => {
                const l = line.trim();
                if (!l) return <div key={li} style={{ height: 6 }} />;
                // Headers
                if (l.startsWith("## "))
                  return (
                    <div
                      key={li}
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: "#1e293b",
                        marginTop: 10,
                        marginBottom: 4,
                      }}
                    >
                      {l.replace(/^##\s*/, "").replace(/\*\*/g, "")}
                    </div>
                  );
                if (l.startsWith("# "))
                  return (
                    <div
                      key={li}
                      style={{
                        fontSize: 14,
                        fontWeight: 800,
                        color: "#1e293b",
                        marginTop: 10,
                        marginBottom: 4,
                      }}
                    >
                      {l.replace(/^#\s*/, "").replace(/\*\*/g, "")}
                    </div>
                  );
                // Table rows
                if (l.startsWith("|") && l.endsWith("|")) {
                  if (l.includes("---")) return null; // separator
                  const cells = l
                    .split("|")
                    .filter(Boolean)
                    .map((c) => c.trim());
                  const isHeader =
                    li > 0 && reportQueryResult.split("\n")[li + 1]?.trim()?.includes("---");
                  return (
                    <div
                      key={li}
                      style={{ display: "flex", gap: 0, borderBottom: "1px solid #e2e8f0" }}
                    >
                      {cells.map((c, ci) => (
                        <div
                          key={ci}
                          style={{
                            flex: 1,
                            padding: "4px 8px",
                            fontSize: 11,
                            fontWeight: isHeader ? 700 : 400,
                            background: isHeader ? "#f1f5f9" : "white",
                            color: isHeader ? "#1e293b" : "#334155",
                          }}
                        >
                          {c.replace(/\*\*/g, "")}
                        </div>
                      ))}
                    </div>
                  );
                }
                // List items
                if (l.startsWith("- ")) {
                  const text = l.slice(2);
                  // Bold parts
                  const parts = text.split(/(\*\*[^*]+\*\*)/g);
                  return (
                    <div
                      key={li}
                      style={{ display: "flex", gap: 6, padding: "2px 0", paddingLeft: 8 }}
                    >
                      <span style={{ color: "#7c3aed", fontWeight: 800 }}>•</span>
                      <span>
                        {parts.map((p, pi) =>
                          p.startsWith("**") ? (
                            <strong key={pi} style={{ color: "#1e293b" }}>
                              {p.replace(/\*\*/g, "")}
                            </strong>
                          ) : (
                            <span key={pi}>{p}</span>
                          ),
                        )}
                      </span>
                    </div>
                  );
                }
                // Regular text with bold
                const parts = l.split(/(\*\*[^*]+\*\*)/g);
                return (
                  <div key={li} style={{ padding: "1px 0" }}>
                    {parts.map((p, pi) =>
                      p.startsWith("**") ? (
                        <strong key={pi} style={{ color: "#1e293b" }}>
                          {p.replace(/\*\*/g, "")}
                        </strong>
                      ) : (
                        <span key={pi}>{p}</span>
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ DOCTOR PERFORMANCE ═══ */}
      {reportSection === "doctors" && (
        <div>
          {reportLoading ? (
            <div style={{ padding: 10 }}>
              <Shimmer type="table" count={5} />
            </div>
          ) : !reportDoctors ? (
            <div style={{ textAlign: "center", padding: 30 }}>
              <button
                onClick={() => loadReports(reportPeriod, reportDoctor)}
                style={{
                  background: "#2563eb",
                  color: "white",
                  border: "none",
                  padding: "10px 24px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Load Reports
              </button>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: "#1e293b", color: "white" }}>
                  <th style={{ padding: "8px 10px", textAlign: "left" }}>Doctor</th>
                  <th style={{ padding: "8px 6px", textAlign: "center" }}>Patients</th>
                  <th style={{ padding: "8px 6px", textAlign: "center" }}>Visits</th>
                  <th style={{ padding: "8px 6px", textAlign: "center" }}>Today</th>
                  <th style={{ padding: "8px 6px", textAlign: "center" }}>Week</th>
                  <th style={{ padding: "8px 6px", textAlign: "center" }}>Month</th>
                </tr>
              </thead>
              <tbody>
                {reportDoctors.map((d, i) => (
                  <tr
                    key={i}
                    style={{
                      borderBottom: "1px solid #f1f5f9",
                      background: i % 2 ? "#fafafa" : "white",
                    }}
                  >
                    <td style={{ padding: "6px 10px", fontWeight: 700 }}>{d.doctor}</td>
                    <td
                      style={{
                        padding: "6px 6px",
                        textAlign: "center",
                        fontWeight: 700,
                        color: "#1e40af",
                      }}
                    >
                      {d.total_patients}
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "center", color: "#64748b" }}>
                      {d.total_visits}
                    </td>
                    <td
                      style={{
                        padding: "6px 6px",
                        textAlign: "center",
                        fontWeight: 700,
                        color: parseInt(d.today) > 0 ? "#059669" : "#cbd5e1",
                      }}
                    >
                      {d.today}
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "center", color: "#475569" }}>
                      {d.this_week}
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "center", color: "#475569" }}>
                      {d.this_month}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
