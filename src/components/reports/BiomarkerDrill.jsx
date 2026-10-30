import { useEffect, useState } from "react";
import Pagination from "../ui/Pagination.jsx";
import Shimmer from "../Shimmer.jsx";
import { useBiomarkerPatients } from "../../queries/hooks/useClinicalReport";

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

const STATUS_CHIPS = [
  { value: "tested", label: "All tested", count: (b) => b.in_control + b.warning + b.out_control },
  { value: "out_control", label: "❌ Out", count: (b) => b.out_control },
  { value: "warning", label: "⚠️ Warning", count: (b) => b.warning },
  { value: "in_control", label: "✅ In", count: (b) => b.in_control },
];

const statusColor = (status) =>
  status === "in_control" ? "#059669" : status === "warning" ? "#d97706" : "#dc2626";

export default function BiomarkerDrill({ bio, period, doctor, onOpenPatient }) {
  const [status, setStatus] = useState("tested");
  const [page, setPage] = useState(1);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const list = useBiomarkerPatients(bio.key, {
    period,
    doctor,
    status,
    q,
    page,
    limit: PAGE_SIZE,
  });
  const data = list.data;

  return (
    <div
      style={{
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderTop: "none",
        borderRadius: "0 0 8px 8px",
        padding: 6,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            aria-pressed={status === chip.value}
            onClick={() => {
              setStatus(chip.value);
              setPage(1);
            }}
            style={{
              padding: "2px 8px",
              borderRadius: 12,
              fontSize: 10,
              fontWeight: 600,
              cursor: "pointer",
              border: status === chip.value ? "1px solid #2563eb" : "1px solid #e2e8f0",
              background: status === chip.value ? "#eff6ff" : "white",
              color: status === chip.value ? "#2563eb" : "#64748b",
            }}
          >
            {chip.label} {chip.count(bio)}
          </button>
        ))}
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name or UHID"
          aria-label={`Search ${bio.label} patients`}
          maxLength={100}
          style={{
            marginLeft: "auto",
            minWidth: 160,
            padding: "2px 8px",
            fontSize: 11,
            border: "1px solid #e2e8f0",
            borderRadius: 6,
          }}
        />
      </div>

      {list.isError ? (
        <div role="alert" style={{ fontSize: 11, color: "#dc2626", padding: 6 }}>
          Couldn&apos;t load these patients.{" "}
          <button type="button" onClick={() => list.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <Shimmer type="list" count={4} />
      ) : !data.total ? (
        <div style={{ fontSize: 10, color: "#64748b", padding: "4px 6px" }}>
          No patients match{q ? ` “${q}”` : ""}.
        </div>
      ) : (
        <div style={{ maxHeight: 300, overflow: "auto", opacity: list.isFetching ? 0.6 : 1 }}>
          {data.data.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                onOpenPatient({
                  id: p.id,
                  name: p.name,
                  age: p.age,
                  sex: p.sex,
                  file_no: p.file_no,
                })
              }
              className="rep-row"
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px",
                border: 0,
                borderBottom: "1px solid #e2e8f0",
                cursor: "pointer",
                fontSize: 10,
                borderRadius: 4,
                textAlign: "left",
              }}
            >
              <span style={{ fontSize: 11 }}>
                {p.status === "in_control" ? "✅" : p.status === "warning" ? "⚠️" : "❌"}
              </span>
              <span style={{ flex: 1 }}>
                <strong>{p.name}</strong>
                <span style={{ color: "#64748b", marginLeft: 4 }}>
                  {p.age}Y/{p.sex?.charAt(0)}
                </span>
              </span>
              <span style={{ fontWeight: 700, fontSize: 11, color: statusColor(p.status) }}>
                {p.display || "—"}
              </span>
              <span style={{ fontSize: 8, color: "#64748b" }}>{p.con_name}</span>
            </button>
          ))}
        </div>
      )}
      {data?.total ? (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          onChange={setPage}
          disabled={list.isFetching}
          unit="patients"
        />
      ) : null}
      {bio.no_data > 0 && (
        <div style={{ fontSize: 9, color: "#64748b", padding: "4px 6px", fontStyle: "italic" }}>
          + {bio.no_data} patients with no {bio.label} data
        </div>
      )}
    </div>
  );
}
