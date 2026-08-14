import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";

// All-Time Outcomes — the whole patient base, no date filter.
//
// The Live Dashboard answers "how is today's clinic doing?". This answers
// "how is our patient panel doing overall?" — every patient we hold readings
// for, comparing their latest value against the one before it, however far
// apart those two visits were.
//
// Verdicts come from the server, which uses the same classifier as the Live
// Dashboard, so a patient cannot be "getting worse" on one page and fine here.

const WH = "#fff";
const BG = "#f0f4f7";
const INK = "#1a2332";
const INK2 = "#3d4f63";
const INK3 = "#6b7d90";
const BD = "#dde3ea";
const RE = "#d94f4f";
const REL = "#fdf0f0";
const AM = "#d97a0a";
const AML = "#fef6e6";
const GN = "#15803d";
const GNL = "#edfcf0";
const SH = "0 1px 3px rgba(0,0,0,.08)";
const FM = "'DM Mono',monospace";
const FD = "'Instrument Serif',serif";

const GROUPS = [
  {
    key: "worse",
    label: "Getting worse",
    tone: RE,
    tint: REL,
    blurb: "A main test has deteriorated",
  },
  {
    key: "mixed",
    label: "Mixed signals",
    tone: AM,
    tint: AML,
    blurb: "One thing improved, another worsened",
  },
  {
    key: "offtarget",
    label: "Off target",
    tone: RE,
    tint: REL,
    blurb: "Not moving, but outside the safe range",
  },
  { key: "better", label: "Getting better", tone: GN, tint: GNL, blurb: "Main tests improved" },
  { key: "stable", label: "Stable", tone: INK3, tint: BG, blurb: "No meaningful change" },
  {
    key: "single",
    label: "One reading only",
    tone: INK3,
    tint: BG,
    blurb: "Nothing to compare against yet",
  },
];
const GROUP_BY_KEY = Object.fromEntries(GROUPS.map((g) => [g.key, g]));

function Card({ children, style }) {
  return (
    <div
      style={{
        background: WH,
        border: `1px solid ${BD}`,
        borderRadius: 10,
        padding: 14,
        boxShadow: SH,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ val, label, sub, tone, tint }) {
  return (
    <div
      style={{
        background: tint || WH,
        border: `1px solid ${tone || BD}`,
        borderRadius: 10,
        padding: 14,
        boxShadow: SH,
      }}
    >
      <div
        style={{ fontFamily: FM, fontSize: 24, fontWeight: 500, color: tone || INK, lineHeight: 1 }}
      >
        {val}
      </div>
      <div
        style={{
          fontSize: 10,
          color: tone || INK3,
          fontWeight: 700,
          marginTop: 6,
          textTransform: "uppercase",
          letterSpacing: ".06em",
        }}
      >
        {label}
      </div>
      {sub != null && <div style={{ fontSize: 10, color: INK3, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// Proportional stacked bar — the whole panel at a glance in one row.
function GroupBar({ counts, total, onPick, active }) {
  return (
    <div
      style={{
        display: "flex",
        height: 26,
        borderRadius: 6,
        overflow: "hidden",
        border: `1px solid ${BD}`,
      }}
    >
      {GROUPS.map((g) => {
        const n = counts[g.key] || 0;
        if (!n) return null;
        const pct = total ? (n / total) * 100 : 0;
        return (
          <div
            key={g.key}
            onClick={() => onPick(active === g.key ? "all" : g.key)}
            title={`${g.label}: ${n} (${Math.round(pct)}%)`}
            style={{
              width: `${pct}%`,
              background: g.tone,
              opacity: active === "all" || active === g.key ? 1 : 0.35,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 9,
              fontWeight: 800,
              color: "#fff",
              transition: "opacity .15s",
            }}
          >
            {pct > 6 ? `${Math.round(pct)}%` : ""}
          </div>
        );
      })}
    </div>
  );
}

const fmt = (v) => (v == null ? "—" : Number.isInteger(v) ? v : Number(v.toFixed(1)));

export default function CohortDashboard() {
  const [data, setData] = useState(null);
  const [group, setGroup] = useState("all");
  const [basis, setBasis] = useState("last");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [exporting, setExporting] = useState(false);
  const LIMIT = 50;

  // Excel is built server-side (one row per patient plus a Summary sheet) and
  // fetched through the same authenticated client as everything else — a plain
  // <a href> would miss the auth header and return 403.
  const exportExcel = async () => {
    setExporting(true);
    setErr("");
    try {
      const params = new URLSearchParams({ group, q, basis });
      const r = await api.get(`/api/opd/cohort/export?${params}`, { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `patient-outcomes-${group}-since-${basis}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr("");
    const params = new URLSearchParams({
      group,
      q,
      basis,
      limit: String(LIMIT),
      offset: String(page * LIMIT),
    });
    api
      .get(`/api/opd/cohort?${params}`)
      .then((r) => !cancelled && setData(r.data))
      .catch((e) => !cancelled && setErr(e?.response?.data?.error || e.message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [group, q, page, basis]);

  // Reset to the first page whenever the filter changes.
  useEffect(() => setPage(0), [group, q, basis]);

  const pctOf = (n) => (data?.total ? Math.round((n / data.total) * 100) : 0);
  const markers = data?.markers || [];
  const pages = data ? Math.ceil(data.matched / LIMIT) : 0;

  const coverageRows = useMemo(() => {
    if (!data?.coverage) return [];
    return markers.map((m) => ({ ...m, ...(data.coverage[m.key] || {}) }));
  }, [data, markers]);

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: BG,
        color: INK,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontFamily: FD, fontSize: 22 }}>All-Time Patient Outcomes</div>
          <div style={{ fontSize: 11, color: INK3 }}>
            Every patient on record · no date filter ·{" "}
            {basis === "first"
              ? "latest reading vs their first ever"
              : "latest reading vs the one before it"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Which baseline to compare today's reading against. The two
              disagree for roughly a third of markers, so it is a real choice,
              not a display preference. */}
          <div
            style={{
              display: "inline-flex",
              border: `1px solid ${BD}`,
              borderRadius: 6,
              overflow: "hidden",
              background: WH,
            }}
          >
            {[
              ["last", "Since last visit", "Compare with the reading before this one"],
              ["first", "Since first visit", "Compare with their earliest reading ever"],
            ].map(([v, label, tip]) => (
              <button
                key={v}
                type="button"
                title={tip}
                onClick={() => setBasis(v)}
                style={{
                  border: "none",
                  padding: "6px 12px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  background: basis === v ? "#009e8c" : WH,
                  color: basis === v ? WH : INK2,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="🔍 Name or file number…"
            style={{
              padding: "6px 10px",
              fontSize: 12,
              border: `1px solid ${BD}`,
              borderRadius: 6,
              outline: "none",
              background: WH,
              minWidth: 200,
            }}
          />
          <button
            type="button"
            onClick={exportExcel}
            disabled={exporting}
            title="Download the current view as an Excel workbook"
            style={{
              background: exporting ? "#e8edf2" : "#107c41",
              border: `1px solid ${exporting ? BD : "#107c41"}`,
              color: exporting ? INK3 : WH,
              borderRadius: 6,
              padding: "6px 11px",
              fontSize: 11,
              fontWeight: 700,
              cursor: exporting ? "default" : "pointer",
            }}
          >
            {exporting ? "Preparing…" : "⬇ Export Excel"}
          </button>
          <button
            type="button"
            onClick={() => api.get("/api/opd/cohort?refresh=1").then(() => setPage(0))}
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              color: INK2,
              borderRadius: 6,
              padding: "6px 11px",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ⟳ Rebuild
          </button>
        </div>
      </div>

      {err && (
        <Card style={{ borderLeft: `3px solid ${RE}` }}>
          <div style={{ fontSize: 12, color: RE, fontWeight: 600 }}>Could not load cohort</div>
          <div style={{ fontSize: 11, color: INK2 }}>{err}</div>
        </Card>
      )}

      {!data ? (
        <Card>
          <div style={{ fontSize: 12, color: INK3 }}>Building cohort…</div>
        </Card>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            <Stat
              val={data.total.toLocaleString()}
              label="Patients on record"
              sub="with at least one reading"
            />
            <Stat
              val={`${pctOf(data.fine)}%`}
              label="Doing fine"
              sub={`${data.fine.toLocaleString()} patients`}
              tone={GN}
              tint={GNL}
            />
            <Stat
              val={`${pctOf(data.notFine)}%`}
              label="Need attention"
              sub={`${data.notFine.toLocaleString()} patients`}
              tone={RE}
              tint={REL}
            />
          </div>

          <Card>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: INK2,
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: ".07em",
              }}
            >
              The whole panel · click a band to filter
            </div>
            <GroupBar counts={data.counts} total={data.total} onPick={setGroup} active={group} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
              {GROUPS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setGroup(group === g.key ? "all" : g.key)}
                  title={g.blurb}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: group === g.key ? g.tint : WH,
                    border: `1px solid ${group === g.key ? g.tone : BD}`,
                    borderRadius: 20,
                    padding: "4px 11px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: group === g.key ? g.tone : INK2,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: g.tone }} />
                  {g.label}
                  <b style={{ fontFamily: FM }}>{(data.counts[g.key] || 0).toLocaleString()}</b>
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: INK2,
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: ".07em",
              }}
            >
              By test
            </div>
            <div style={{ fontSize: 10, color: INK3, marginBottom: 8 }}>
              How many patients have each test on file, how many can be compared over time, and how
              many are currently outside the safe range.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: INK3 }}>
                    <th style={{ padding: "5px 8px" }}>Test</th>
                    <th style={{ padding: "5px 8px" }}>On file</th>
                    <th style={{ padding: "5px 8px" }}>Comparable</th>
                    <th style={{ padding: "5px 8px" }}>Off target</th>
                    <th style={{ padding: "5px 8px", width: "35%" }} />
                  </tr>
                </thead>
                <tbody>
                  {coverageRows.map((m) => {
                    const pct = m.withValue ? Math.round((m.offTarget / m.withValue) * 100) : 0;
                    const tone = pct >= 30 ? RE : pct >= 15 ? AM : GN;
                    return (
                      <tr key={m.key} style={{ borderTop: `1px solid ${BD}` }}>
                        <td style={{ padding: "5px 8px", fontWeight: 700 }}>{m.label}</td>
                        <td style={{ padding: "5px 8px", fontFamily: FM }}>
                          {(m.withValue || 0).toLocaleString()}
                        </td>
                        <td style={{ padding: "5px 8px", fontFamily: FM, color: INK3 }}>
                          {(m.withTrend || 0).toLocaleString()}
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            fontFamily: FM,
                            color: tone,
                            fontWeight: 700,
                          }}
                        >
                          {m.key === "weight"
                            ? "—"
                            : `${(m.offTarget || 0).toLocaleString()} · ${pct}%`}
                        </td>
                        <td style={{ padding: "5px 8px" }}>
                          {m.key !== "weight" && (
                            <div
                              style={{
                                height: 6,
                                background: BG,
                                borderRadius: 3,
                                overflow: "hidden",
                              }}
                            >
                              <div style={{ height: "100%", width: `${pct}%`, background: tone }} />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: INK3, marginTop: 8 }}>
              Weight is tracked and shown but never changes a patient&apos;s verdict — it has no
              single safe range.
            </div>
          </Card>

          <Card>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: INK2,
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: ".07em",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                {group === "all" ? "All patients" : GROUP_BY_KEY[group]?.label} ·{" "}
                <span
                  style={{ color: INK3, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}
                >
                  {data.matched.toLocaleString()} match{data.matched === 1 ? "" : "es"}, worst first
                </span>
              </span>
              {busy && <span style={{ color: INK3, fontWeight: 400 }}>loading…</span>}
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: INK3 }}>
                    <th style={{ padding: "6px 8px" }}>Patient</th>
                    <th style={{ padding: "6px 8px" }}>Status</th>
                    {markers.map((m) => (
                      <th key={m.key} style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                        {m.label}
                      </th>
                    ))}
                    <th style={{ padding: "6px 8px" }}>Last reading</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const g = GROUP_BY_KEY[r.group] || {};
                    return (
                      <tr key={r.patient_id} style={{ borderTop: `1px solid ${BD}` }}>
                        <td style={{ padding: "6px 8px" }}>
                          <div style={{ fontWeight: 700 }}>{r.name || "—"}</div>
                          <div style={{ fontSize: 9, color: INK3, fontFamily: FM }}>
                            {r.file_no}
                          </div>
                        </td>
                        <td style={{ padding: "6px 8px", minWidth: 150 }}>
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              padding: "2px 7px",
                              borderRadius: 5,
                              background: g.tint,
                              color: g.tone,
                              border: `1px solid ${g.tone}44`,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {g.label}
                          </span>
                          {r.reason && (
                            <div
                              style={{ fontSize: 9, color: INK3, marginTop: 3, lineHeight: 1.35 }}
                            >
                              {r.reason}
                            </div>
                          )}
                        </td>
                        {markers.map((m) => {
                          const cur = r.cur?.[m.key];
                          const prev = r.prev?.[m.key];
                          const bad = r.offTarget?.includes(m.key);
                          return (
                            <td
                              key={m.key}
                              style={{
                                padding: "6px 8px",
                                fontFamily: FM,
                                whiteSpace: "nowrap",
                                color: bad ? RE : INK2,
                                fontWeight: bad ? 700 : 400,
                              }}
                            >
                              {cur == null ? (
                                <span style={{ color: "#c3ccd6" }}>—</span>
                              ) : (
                                <>
                                  {prev != null && prev !== cur && (
                                    <span style={{ color: INK3, fontSize: 9 }}>{fmt(prev)} → </span>
                                  )}
                                  {fmt(cur)}
                                </>
                              )}
                            </td>
                          );
                        })}
                        <td
                          style={{
                            padding: "6px 8px",
                            color: INK3,
                            fontFamily: FM,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.lastSeen || "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {!data.rows.length && (
                    <tr>
                      <td
                        colSpan={markers.length + 3}
                        style={{ padding: 14, color: INK3, textAlign: "center" }}
                      >
                        No patients match.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 10,
                  justifyContent: "center",
                }}
              >
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  style={{
                    border: `1px solid ${BD}`,
                    background: WH,
                    borderRadius: 6,
                    padding: "4px 10px",
                    fontSize: 11,
                    cursor: page === 0 ? "default" : "pointer",
                    opacity: page === 0 ? 0.4 : 1,
                  }}
                >
                  ‹ Prev
                </button>
                <span style={{ fontSize: 11, color: INK3, fontFamily: FM }}>
                  {page + 1} / {pages}
                </span>
                <button
                  type="button"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  style={{
                    border: `1px solid ${BD}`,
                    background: WH,
                    borderRadius: 6,
                    padding: "4px 10px",
                    fontSize: 11,
                    cursor: page + 1 >= pages ? "default" : "pointer",
                    opacity: page + 1 >= pages ? 0.4 : 1,
                  }}
                >
                  Next ›
                </button>
              </div>
            )}
          </Card>

          <div style={{ fontSize: 10, color: INK3, lineHeight: 1.6 }}>
            <b>How to read this.</b> “Doing fine” means nothing is deteriorating <i>and</i> nothing
            is currently outside its safe range. “Need attention” covers three different problems:
            something got worse, signals disagree with each other, or a value is off target even
            though it has not moved. Each test is compared against its own previous reading, which
            may be from a different date than the others — there is no time limit on how old that
            comparison is, so a “trend” can span years.{" "}
            <b>
              {basis === "first"
                ? "Showing change since each patient’s first ever reading — the treatment journey."
                : "Showing change since each patient’s previous reading — the same basis as the Live Dashboard."}
            </b>{" "}
            The two baselines disagree for about a third of markers, because a first reading is
            often the pre-treatment baseline and flatters the comparison.
            {data.generated_at && (
              <> Built {new Date(data.generated_at).toLocaleString("en-IN")} · cached 10 min.</>
            )}
          </div>
        </>
      )}
    </div>
  );
}
