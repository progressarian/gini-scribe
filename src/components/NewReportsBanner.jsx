import usePatientStore from "../stores/patientStore";
import useReportsStore from "../stores/reportsStore";
import useClinicalStore from "../stores/clinicalStore";
import { getNewReportsSinceLastVisit } from "../utils/helpers";
import { fmtLabVal } from "./visit/helpers";

export default function NewReportsBanner() {
  const patientFullData = usePatientStore((s) => s.patientFullData);
  const newReportsIncluded = useReportsStore((s) => s.newReportsIncluded);
  const newReportsExpanded = useReportsStore((s) => s.newReportsExpanded);
  const setNewReportsIncluded = useReportsStore((s) => s.setNewReportsIncluded);
  const setNewReportsExpanded = useReportsStore((s) => s.setNewReportsExpanded);
  const includeNewReportsInPlan = useReportsStore((s) => s.includeNewReportsInPlan);
  const setConTranscript = useClinicalStore((s) => s.setConTranscript);
  const setConData = useClinicalStore((s) => s.setConData);

  const newReportsSinceLastVisit = getNewReportsSinceLastVisit(patientFullData);
  const hasNewReports = newReportsSinceLastVisit.length > 0;

  if (!hasNewReports) return null;

  if (newReportsIncluded) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          marginBottom: 8,
          background: "#f0fdf4",
          border: "1px solid #bbf7d0",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 12 }}>✅</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#059669" }}>
          {newReportsSinceLastVisit.length} new lab results included
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            setNewReportsIncluded(false);
            setNewReportsExpanded(true);
          }}
          style={{
            fontSize: 9,
            background: "white",
            border: "1px solid #bbf7d0",
            borderRadius: 4,
            padding: "2px 6px",
            cursor: "pointer",
            color: "#64748b",
          }}
        >
          Review again
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        background: "linear-gradient(135deg,#fffbeb,#fef3c7)",
        border: "1px solid #f59e0b",
        borderRadius: 8,
        padding: "8px 12px",
        marginBottom: 8,
      }}
    >
      <div
        onClick={() => setNewReportsExpanded(!newReportsExpanded)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
      >
        <span style={{ fontSize: 14 }}>🔔</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e" }}>
            {newReportsSinceLastVisit.length} New Lab Results Since Last Visit
          </div>
          {!newReportsExpanded && (
            <div style={{ fontSize: 9, color: "#a16207", marginTop: 2 }}>
              {[...new Set(newReportsSinceLastVisit.map((l) => l.test_name))]
                .slice(0, 6)
                .join(", ")}
              {[...new Set(newReportsSinceLastVisit.map((l) => l.test_name))].length > 6 && " ..."}
            </div>
          )}
        </div>
        <span style={{ fontSize: 9, color: "#a16207", fontWeight: 600 }}>
          {newReportsExpanded ? "▲ Hide" : "▼ Review"}
        </span>
      </div>

      {newReportsExpanded && (
        <div style={{ marginTop: 8, borderTop: "1px solid #fcd34d", paddingTop: 8 }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, marginBottom: 8 }}
          >
            <thead>
              <tr style={{ background: "rgba(245,158,11,.15)" }}>
                <th
                  style={{
                    textAlign: "left",
                    padding: "3px 6px",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#92400e",
                  }}
                >
                  Test
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "3px 6px",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#92400e",
                  }}
                >
                  Result
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "3px 6px",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#92400e",
                  }}
                >
                  Ref
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "3px 6px",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#92400e",
                  }}
                >
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {newReportsSinceLastVisit.map((l, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #fde68a" }}>
                  <td style={{ padding: "3px 6px", fontWeight: 600 }}>{l.test_name}</td>
                  <td
                    style={{
                      padding: "3px 6px",
                      textAlign: "center",
                      fontWeight: 700,
                      color: l.flag === "H" ? "#dc2626" : l.flag === "L" ? "#2563eb" : "#059669",
                    }}
                  >
                    {fmtLabVal(null, l.result)} {l.unit || ""}{" "}
                    {l.flag === "H" ? "↑" : l.flag === "L" ? "↓" : ""}
                  </td>
                  <td
                    style={{
                      padding: "3px 6px",
                      textAlign: "center",
                      fontSize: 9,
                      color: "#94a3b8",
                    }}
                  >
                    {l.ref_range || "—"}
                  </td>
                  <td
                    style={{
                      padding: "3px 6px",
                      textAlign: "center",
                      fontSize: 9,
                      color: "#64748b",
                    }}
                  >
                    {l.test_date?.split("T")[0] || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button
            onClick={() =>
              includeNewReportsInPlan(newReportsSinceLastVisit, setConTranscript, setConData)
            }
            style={{
              width: "100%",
              background: "linear-gradient(135deg,#f59e0b,#d97706)",
              color: "white",
              border: "none",
              padding: "8px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            📋 Include in Treatment Plan
          </button>
        </div>
      )}
    </div>
  );
}
