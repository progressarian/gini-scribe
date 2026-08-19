import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "../services/api";
import "./OBTDashboardPage.css";

const todayStr = () => new Date().toISOString().split("T")[0];
const addDaysStr = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
};
const prettyDate = (s) => {
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

const visitTone = (type) => {
  const t = (type || "").toLowerCase();
  if (t.startsWith("new")) return "blue";
  if (t.startsWith("follow")) return "amber";
  if (t === "not set") return "orange";
  return "slate";
};

function Tile({ label, value, tone = "slate", hint }) {
  return (
    <div className={`obt-tile obt-tile--${tone}`}>
      <div className="obt-tile__value">{value ?? 0}</div>
      <div className="obt-tile__label">{label}</div>
      {hint && <div className="obt-tile__hint">{hint}</div>}
    </div>
  );
}

export default function OBTDashboardPage() {
  const [date, setDate] = useState(addDaysStr(1));

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["obtDashboard", date],
    queryFn: async () => {
      const { data } = await api.get("/api/obt-dashboard", { params: { date } });
      return data;
    },
    staleTime: 20_000,
    refetchInterval: 60_000,
  });

  const summary = data?.summary || {};
  const visitTypes = data?.visitTypes || [];

  return (
    <div className="obt">
      <div className="obt__hdr">
        <div className="obt__title">
          <h1>📞 OBT Dashboard</h1>
          <span className="obt__datelab">
            {prettyDate(date)}
            {isFetching && !isLoading ? " · refreshing…" : ""}
          </span>
        </div>
        <div className="obt__controls">
          <button
            type="button"
            className={`obt-chip ${date === todayStr() ? "obt-chip--on" : ""}`}
            onClick={() => setDate(todayStr())}
          >
            Today
          </button>
          <button
            type="button"
            className={`obt-chip ${date === addDaysStr(1) ? "obt-chip--on" : ""}`}
            onClick={() => setDate(addDaysStr(1))}
          >
            Tomorrow
          </button>
          <input
            type="date"
            className="ctrl"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      {isError && (
        <div className="obt-error">
          Could not load the dashboard: {error?.response?.data?.error || error?.message}
        </div>
      )}
      {isLoading && <div className="obt-empty">Loading…</div>}

      {data && (
        <>
          <h2 className="obt-sect">Calling</h2>
          <div className="obt-tiles">
            <Tile label="Appointments" value={summary.total} tone="slate" />
            <Tile
              label="Still to call"
              value={summary.need_call}
              tone="orange"
              hint={`${summary.not_called ?? 0} not called yet`}
            />
            <Tile label="Spoke" value={summary.spoke} tone="green" />
            <Tile label="No answer" value={summary.not_picked} tone="red" />
            <Tile label="Busy / switched off" value={summary.unreachable} tone="amber" />
            <Tile label="Will call later" value={summary.call_later} tone="amber" />
            <Tile label="Rescheduled" value={summary.rescheduled} tone="blue" />
            <Tile label="No call needed" value={summary.no_call_needed} tone="slate" />
          </div>

          <h2 className="obt-sect">Visit type</h2>
          <div className="obt-tiles">
            {visitTypes.length === 0 && <Tile label="No appointments" value={0} tone="slate" />}
            {visitTypes.map((v) => (
              <Tile key={v.type} label={v.type} value={v.count} tone={visitTone(v.type)} />
            ))}
          </div>

          <h2 className="obt-sect">Home collection</h2>
          <div className="obt-tiles">
            <Tile
              label="Needs home collection"
              value={summary.home_collection}
              tone="purple"
              hint={`of ${summary.total ?? 0} appointments`}
            />
          </div>
        </>
      )}
    </div>
  );
}
