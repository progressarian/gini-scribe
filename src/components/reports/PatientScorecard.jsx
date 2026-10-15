import { useEffect, useState } from "react";
import Pagination from "../ui/Pagination.jsx";
import Shimmer from "../Shimmer.jsx";
import { useReportScorecard } from "../../queries/hooks/useClinicalReport";

const PAGE_SIZES = [25, 50, 100];
const SEARCH_DELAY_MS = 300;

const pctColorOf = (pct) =>
  pct === null ? "#94a3b8" : pct >= 70 ? "#059669" : pct >= 40 ? "#d97706" : "#dc2626";

const dxTone = (status) =>
  status === "Uncontrolled"
    ? { background: "#fef2f2", color: "#dc2626" }
    : status === "Controlled"
      ? { background: "#f0fdf4", color: "#059669" }
      : { background: "#f1f5f9", color: "#64748b" };

function ScoreRow({ p, open, onToggle, onOpenPatient }) {
  const pctColor = pctColorOf(p.pct);
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="rep-score"
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          cursor: "pointer",
          fontSize: 11,
          textAlign: "left",
          borderColor: open ? "#2563eb" : "#e2e8f0",
        }}
      >
        <span
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
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block" }}>
            <strong>{p.name}</strong>{" "}
            <span style={{ color: "#94a3b8" }}>
              {p.age}Y/{p.sex?.charAt(0)} {p.file_no && `| ${p.file_no}`}
            </span>
          </span>
          <span style={{ display: "block", fontSize: 9, color: "#64748b" }}>
            {p.targets_total > 0 ? `${p.targets_met}/${p.targets_total} targets met` : "No lab data"}
            {p.con_name && ` • ${p.con_name}`}
          </span>
        </span>
        <span
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
        </span>
        <span style={{ fontSize: 9, color: "#94a3b8" }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderTop: "none",
            borderRadius: "0 0 8px 8px",
            padding: 8,
          }}
        >
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
                  {c.val}
                </div>
                <div style={{ fontSize: 8, color: "#94a3b8" }}>Target: {c.target}</div>
              </div>
            ))}
          </div>
          {p.diagnoses?.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
              {p.diagnoses
                .filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i)
                .map((d) => (
                  <span
                    key={d.id}
                    style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, ...dxTone(d.status) }}
                  >
                    {d.label}
                  </span>
                ))}
            </div>
          )}
          <button
            type="button"
            onClick={() =>
              onOpenPatient({ id: p.id, name: p.name, age: p.age, sex: p.sex, file_no: p.file_no })
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
}

export default function PatientScorecard({ period, doctor, onOpenPatient }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(PAGE_SIZES[0]);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    setPage(1);
    setOpenId(null);
  }, [period, doctor]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const list = useReportScorecard({ period, doctor, q, page, limit });
  const data = list.data;

  return (
    <section aria-label="Patient target scorecard">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#1e293b" }}>
          👥 PATIENT TARGET SCORECARD
        </div>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name or UHID"
          aria-label="Search scorecard patients"
          maxLength={100}
          style={{
            marginLeft: "auto",
            minWidth: 180,
            padding: "3px 8px",
            fontSize: 11,
            border: "1px solid #e2e8f0",
            borderRadius: 6,
          }}
        />
      </div>
      {list.isError ? (
        <div role="alert" style={{ fontSize: 11, color: "#dc2626", padding: 6 }}>
          Couldn&apos;t load the scorecard.{" "}
          <button type="button" onClick={() => list.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <Shimmer type="list" count={5} />
      ) : !data.total ? (
        <div style={{ fontSize: 11, color: "#94a3b8", padding: 8 }}>
          {q ? `No patients match “${q}”.` : "No patients in this period."}
        </div>
      ) : (
        <div style={{ opacity: list.isFetching ? 0.6 : 1 }}>
          {data.data.map((p) => (
            <ScoreRow
              key={p.id}
              p={p}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
              onOpenPatient={onOpenPatient}
            />
          ))}
        </div>
      )}
      {data?.total ? (
        <Pagination
          page={page}
          pageSize={limit}
          total={data.total}
          onChange={setPage}
          onPageSizeChange={setLimit}
          pageSizeOptions={PAGE_SIZES}
          disabled={list.isFetching}
          unit="patients"
        />
      ) : null}
    </section>
  );
}
