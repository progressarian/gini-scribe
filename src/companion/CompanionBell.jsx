import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMismatchReviews } from "../queries/hooks/useMismatchReviews";
import { fDate } from "./constants";

export default function CompanionBell() {
  const navigate = useNavigate();
  const { data = [], isLoading } = useMismatchReviews();
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  const count = data.length;

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const openDoc = (patientId) => {
    setOpen(false);
    navigate(`/companion/record/${patientId}`);
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${count} document${count === 1 ? "" : "s"} awaiting review`}
        style={{
          position: "relative",
          width: 38,
          height: 38,
          borderRadius: 19,
          border: "1px solid #e2e8f0",
          background: "#fff",
          cursor: "pointer",
          fontSize: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        🔔
        {count > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              borderRadius: 9,
              background: "#dc2626",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid #fff",
            }}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 50,
            width: 320,
            maxHeight: "70vh",
            overflow: "auto",
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid #e2e8f0",
              fontSize: 13,
              fontWeight: 700,
              color: "#0f172a",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>⚠️ Needs review</span>
            <span style={{ color: "#64748b", fontSize: 12, fontWeight: 500 }}>
              {isLoading ? "Loading…" : `${count} document${count === 1 ? "" : "s"}`}
            </span>
          </div>
          {count === 0 && !isLoading && (
            <div
              style={{
                padding: "24px 14px",
                textAlign: "center",
                color: "#64748b",
                fontSize: 13,
              }}
            >
              ✅ All extractions look good
            </div>
          )}
          {data.map((row) => {
            const ext = typeof row.extracted_data === "string"
              ? safeParse(row.extracted_data)
              : row.extracted_data;
            const reportName = ext?.mismatch?.reportName;
            const fields = ext?.mismatch?.mismatchedFields || [];
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => openDoc(row.patient_id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 14px",
                  borderBottom: "1px solid #f1f5f9",
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>
                  {row.patient_name}
                  {row.patient_file_no ? ` · #${row.patient_file_no}` : ""}
                </div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  {row.title || row.doc_type} · {fDate(row.doc_date)}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#dc2626",
                    marginTop: 4,
                    fontWeight: 600,
                  }}
                >
                  ⚠️ {fields.join(" + ") || "mismatch"}
                  {reportName ? ` — doc: ${reportName}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
