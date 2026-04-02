import { memo } from "react";

const DocPreviewModal = memo(function DocPreviewModal({ preview, onClose }) {
  if (!preview) return null;

  const isImage = preview.mime && preview.mime.startsWith("image/");
  const isPdf = preview.mime?.includes("pdf") || preview.name?.toLowerCase().endsWith(".pdf");

  return (
    <div
      className="mo open"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ zIndex: 9999 }}
    >
      <div
        className="mbox"
        style={{
          width: "90vw",
          maxWidth: 900,
          height: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {preview.name || "Document Preview"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {preview.url && (
              <a
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="btn"
                style={{ fontSize: 12, textDecoration: "none", padding: "5px 12px" }}
              >
                Open in new tab
              </a>
            )}
            <button className="btn" onClick={onClose} style={{ fontSize: 12, padding: "5px 12px" }}>
              Close
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
          {preview.url ? (
            isPdf ? (
              <iframe
                src={preview.url}
                title={preview.name}
                style={{ width: "100%", height: "100%", border: "none" }}
              />
            ) : isImage ? (
              <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
                <img
                  src={preview.url}
                  alt={preview.name}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                />
              </div>
            ) : (
              <iframe
                src={preview.url}
                title={preview.name}
                style={{ width: "100%", height: "100%", border: "none" }}
              />
            )
          ) : preview.extracted ? (
            <div style={{ padding: 20 }}>
              <ExtractedDataView data={preview.extracted} />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--t3)",
                fontSize: 14,
              }}
            >
              No preview available for this document
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function ExtractedDataView({ data }) {
  if (!data || typeof data !== "object") return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {data.doctor_name && (
        <div style={{ fontSize: 13, color: "var(--t2)" }}>
          <strong>Doctor:</strong> {data.doctor_name}
          {data.visit_date ? ` — ${data.visit_date}` : ""}
        </div>
      )}

      {data.diagnoses?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>
            Diagnoses
          </div>
          {data.diagnoses.map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--t2)", padding: "3px 0" }}>
              {d.label || d.name || JSON.stringify(d)}
              {d.status ? ` (${d.status})` : ""}
            </div>
          ))}
        </div>
      )}

      {data.medications?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>
            Medications
          </div>
          {data.medications.map((m, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                color: "var(--t2)",
                padding: "4px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <strong>{m.name}</strong>
              {m.dose ? ` ${m.dose}` : ""}
              {m.frequency ? ` — ${m.frequency}` : ""}
              {m.timing ? ` (${m.timing})` : ""}
            </div>
          ))}
        </div>
      )}

      {data.stopped_medications?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--red)" }}>
            Stopped Medications
          </div>
          {data.stopped_medications.map((m, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--t3)", padding: "3px 0" }}>
              {m.name}
              {m.reason ? ` — ${m.reason}` : ""}
            </div>
          ))}
        </div>
      )}

      {data.advice?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>
            Advice
          </div>
          {data.advice.map((a, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--t2)", padding: "2px 0" }}>
              {a}
            </div>
          ))}
        </div>
      )}

      {data.follow_up && (
        <div style={{ fontSize: 12, color: "var(--primary)", fontWeight: 500 }}>
          Follow-up: {data.follow_up}
        </div>
      )}

      {data.lab_tests?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>
            Lab Tests
          </div>
          {data.lab_tests.map((t, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--t2)", padding: "2px 0" }}>
              {t.test_name || t.name || JSON.stringify(t)}
              {t.result != null ? `: ${t.result} ${t.unit || ""}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default DocPreviewModal;
