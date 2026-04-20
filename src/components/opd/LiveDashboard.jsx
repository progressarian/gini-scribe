import React, { useEffect, useMemo, useState } from "react";

const T = "#009e8c";
const TL = "#e6f6f4";
const TB = "rgba(0,158,140,.22)";
const BG = "#f0f4f7";
const WH = "#fff";
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
const SK = "#2563eb";
const SKL = "#eff6ff";
const SH = "0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05)";

const FB = "'Inter',system-ui,sans-serif";
const FD = "'Instrument Serif',serif";
const FM = "'DM Mono',monospace";

if (typeof document !== "undefined" && !document.getElementById("live-dash-kf")) {
  const s = document.createElement("style");
  s.id = "live-dash-kf";
  s.textContent = `
@keyframes ldPulse {
  0%   { box-shadow: 0 0 0 0 rgba(21,128,61,.55); }
  70%  { box-shadow: 0 0 0 9px rgba(21,128,61,0);  }
  100% { box-shadow: 0 0 0 0 rgba(21,128,61,0);    }
}
.ld-dot { animation: ldPulse 1.8s ease-out infinite; }
.ld-row { transition: background .12s; }
.ld-row:hover { background: rgba(0,158,140,.06); cursor: pointer; }
`;
  document.head.appendChild(s);
}

const firstName = (n) => (n ? String(n).split("(")[0].trim() : "—");

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function useTick(ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Ring({ pct, color, centerLabel }) {
  const circ = 2 * Math.PI * 30;
  const arc = (Math.max(0, Math.min(100, pct)) / 100) * circ;
  return (
    <div style={{ position: "relative", width: 86, height: 86, flexShrink: 0 }}>
      <svg viewBox="0 0 70 70" width="86" height="86">
        <circle cx="35" cy="35" r="30" stroke={BD} strokeWidth="8" fill="none" />
        <circle
          cx="35"
          cy="35"
          r="30"
          stroke={color}
          strokeWidth="8"
          fill="none"
          strokeDasharray={circ}
          strokeDashoffset={circ - arc}
          transform="rotate(-90 35 35)"
          style={{ transition: "stroke-dashoffset .6s" }}
          strokeLinecap="round"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ fontFamily: FM, fontSize: 18, fontWeight: 600, color }}>{pct}%</div>
        <div style={{ fontSize: 9, color: INK3, letterSpacing: ".06em" }}>{centerLabel}</div>
      </div>
    </div>
  );
}

function Bar({ pct, color }) {
  return (
    <div
      style={{
        height: 5,
        background: BG,
        borderRadius: 3,
        overflow: "hidden",
        width: "100%",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
          borderRadius: 3,
          transition: "width .6s",
        }}
      />
    </div>
  );
}

function Stat({ val, subVal, label, valColor, bg, labelColor }) {
  return (
    <div
      style={{
        background: bg || WH,
        border: `1px solid ${BD}`,
        borderRadius: 10,
        padding: "14px 14px",
        boxShadow: SH,
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 26,
          fontWeight: 500,
          color: valColor || INK,
          lineHeight: 1,
        }}
      >
        {val}
        {subVal !== undefined && (
          <span style={{ fontSize: 15, color: INK3, marginLeft: 3 }}>/{subVal}</span>
        )}
      </div>
      <div
        style={{
          fontSize: 10,
          color: labelColor || INK3,
          fontWeight: 600,
          marginTop: 6,
          textTransform: "uppercase",
          letterSpacing: ".06em",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: INK2,
        marginBottom: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        textTransform: "uppercase",
        letterSpacing: ".07em",
      }}
    >
      <span>{children}</span>
      {right}
    </div>
  );
}

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

export default function LiveDashboard({
  appointments = [],
  updatedAt,
  isFetching,
  onRefresh,
  onSelectAppt,
}) {
  useTick(1000);

  const m = useMemo(() => {
    const appts = Array.isArray(appointments) ? appointments : [];
    const get = (a) => {
      const bio = a.biomarkers || {};
      const compl = a.compliance || {};
      const prev = Number(a.prev_hba1c) || null;
      const cur = Number(bio.hba1c) || null;
      return {
        id: a.id,
        name: firstName(a.patient_name),
        time: a.time_slot || "",
        status: a.status || "pending",
        category: a.category || null,
        hba1c: cur,
        prevHba1c: prev,
        medPct: compl.medPct != null ? Number(compl.medPct) : null,
        raw: a,
      };
    };
    const rows = appts.map(get);
    const total = rows.length;
    const withHba1c = rows.filter((r) => r.hba1c).length;
    const controlled = rows.filter((r) => r.hba1c && r.hba1c <= 7).length;
    const improving = rows.filter(
      (r) => r.hba1c && r.prevHba1c && r.hba1c > 7 && r.hba1c <= 9 && r.hba1c < r.prevHba1c,
    ).length;
    const uncontrolled = rows.filter((r) => r.hba1c && r.hba1c > 9).length;
    const rising = rows.filter((r) => r.hba1c && r.prevHba1c && r.hba1c > r.prevHba1c).length;
    const noData = rows.filter((r) => !r.hba1c).length;

    const countStatus = (s) => rows.filter((r) => r.status === s).length;
    const seen = countStatus("seen");
    const checkedin = countStatus("checkedin");
    const in_visit = countStatus("in_visit");
    const pending = rows.filter((r) => r.status === "pending" || r.status === "scheduled").length;

    const pctCoverage = total ? Math.round((withHba1c / total) * 100) : 0;
    const pctControlled = withHba1c ? Math.round((controlled / withHba1c) * 100) : 0;

    const needsAttention = rows
      .filter(
        (r) =>
          r.hba1c &&
          (r.hba1c > 9 ||
            (r.prevHba1c && r.hba1c > r.prevHba1c && r.hba1c > 8) ||
            (r.medPct != null && r.medPct < 60)),
      )
      .sort((a, b) => b.hba1c - a.hba1c);

    const missingBio = rows.filter(
      (r) => !r.hba1c && r.status !== "cancelled" && r.status !== "no_show",
    );

    const onTrack = rows
      .filter((r) => r.hba1c && r.hba1c <= 7.5 && (!r.prevHba1c || r.hba1c <= r.prevHba1c))
      .sort((a, b) => a.hba1c - b.hba1c);

    const buckets = [
      rows.filter((r) => r.hba1c && r.hba1c <= 7).length,
      rows.filter((r) => r.hba1c && r.hba1c > 7 && r.hba1c <= 8).length,
      rows.filter((r) => r.hba1c && r.hba1c > 8 && r.hba1c <= 9).length,
      rows.filter((r) => r.hba1c && r.hba1c > 9 && r.hba1c <= 10).length,
      rows.filter((r) => r.hba1c && r.hba1c > 10).length,
    ];

    return {
      rows,
      total,
      withHba1c,
      controlled,
      improving,
      uncontrolled,
      rising,
      noData,
      seen,
      checkedin,
      in_visit,
      pending,
      pctCoverage,
      pctControlled,
      needsAttention,
      missingBio,
      onTrack,
      buckets,
    };
  }, [appointments]);

  const coverageColor = m.pctCoverage >= 80 ? GN : m.pctCoverage >= 60 ? AM : RE;
  const controlColor = m.pctControlled >= 60 ? GN : m.pctControlled >= 30 ? AM : RE;

  const todayStr = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const flowRow = (key, label, color) => {
    const counts = {
      seen: m.seen,
      in_visit: m.in_visit,
      checkedin: m.checkedin,
      pending: m.pending,
    };
    const count = counts[key] || 0;
    if (!count) return null;
    const pct = m.total ? Math.round((count / m.total) * 100) : 0;
    return (
      <div key={key} style={{ marginBottom: 7 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            marginBottom: 3,
          }}
        >
          <span style={{ color, fontWeight: 600 }}>{label}</span>
          <span style={{ fontFamily: FM, color: INK2 }}>{count}</span>
        </div>
        <Bar pct={pct} color={color} />
      </div>
    );
  };

  const select = (row) => {
    if (onSelectAppt) onSelectAppt(row.raw);
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: FB,
        color: INK,
      }}
    >
      {/* ── Header ────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontFamily: FD, fontSize: 22, color: INK }}>
            Today&apos;s Clinical Dashboard
          </div>
          <div style={{ fontSize: 11, color: INK3 }}>{todayStr}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: GNL,
              border: `1px solid ${GN}22`,
              borderRadius: 16,
              padding: "4px 11px",
              fontSize: 11,
              color: GN,
              fontWeight: 600,
            }}
          >
            <span
              className="ld-dot"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: GN,
                display: "inline-block",
                opacity: isFetching ? 1 : 0.85,
              }}
            />
            Live · Updated {fmtTime(updatedAt)}
          </div>
          <button
            onClick={onRefresh}
            disabled={isFetching}
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              color: INK2,
              borderRadius: 6,
              padding: "5px 11px",
              fontSize: 11,
              fontWeight: 600,
              cursor: isFetching ? "default" : "pointer",
              opacity: isFetching ? 0.6 : 1,
              fontFamily: FB,
            }}
          >
            {isFetching ? "… refreshing" : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {/* ── 5-stat row ────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5,1fr)",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <Stat val={m.total} label="Today's patients" />
        <Stat val={m.withHba1c} subVal={m.total} label="HbA1c on file" valColor={coverageColor} />
        <Stat val={m.controlled} label="At target (≤7%)" valColor={GN} bg={GNL} labelColor={GN} />
        <Stat
          val={m.uncontrolled}
          label="Uncontrolled (>9%)"
          valColor={m.uncontrolled ? RE : INK3}
          bg={m.uncontrolled ? REL : WH}
          labelColor={m.uncontrolled ? RE : INK3}
        />
        <Stat
          val={m.rising}
          label="HbA1c rising ↑"
          valColor={m.rising ? AM : INK3}
          bg={m.rising ? AML : WH}
          labelColor={m.rising ? AM : INK3}
        />
      </div>

      {/* ── Middle row: rings + flow ──────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <Card style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Ring pct={m.pctCoverage} color={coverageColor} centerLabel="data" />
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Biomarker Coverage</div>
            <div style={{ fontSize: 11, color: INK3 }}>
              {m.withHba1c} of {m.total} patients have HbA1c on file
            </div>
            {m.noData > 0 ? (
              <div style={{ fontSize: 11, color: RE, marginTop: 6, fontWeight: 600 }}>
                ⚠ {m.noData} missing — enter before visit
              </div>
            ) : m.total > 0 ? (
              <div style={{ fontSize: 11, color: GN, marginTop: 6 }}>✓ All patients have data</div>
            ) : null}
          </div>
        </Card>

        <Card style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Ring pct={m.pctControlled} color={controlColor} centerLabel="goal" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Control Rate</div>
            <div style={{ fontSize: 11, color: INK3, marginBottom: 6 }}>
              {m.controlled} at target · {m.improving} improving
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <div style={{ flex: 1, maxWidth: 140 }}>
                <Bar pct={m.pctControlled} color={controlColor} />
              </div>
              <span style={{ fontSize: 10, color: INK3 }}>Goal 100%</span>
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle>Today&apos;s visit flow</SectionTitle>
          {flowRow("seen", "Seen", GN)}
          {flowRow("in_visit", "With doctor", "#7c3aed")}
          {flowRow("checkedin", "Checked in", SK)}
          {flowRow("pending", "Pending", INK3)}
          {m.total === 0 && <div style={{ fontSize: 11, color: INK3 }}>No appointments today</div>}
        </Card>
      </div>

      {/* ── Needs attention + On track ────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Card>
          <SectionTitle
            right={
              <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                {m.needsAttention.length} patients
              </span>
            }
          >
            ⚠ Needs extra attention
          </SectionTitle>
          {m.needsAttention.length === 0 ? (
            <div style={{ fontSize: 12, color: GN, padding: "8px 0" }}>
              ✓ All controlled patients today
            </div>
          ) : (
            m.needsAttention.map((r) => {
              const trend =
                r.prevHba1c && r.hba1c > r.prevHba1c
                  ? "↑"
                  : r.prevHba1c && r.hba1c < r.prevHba1c
                    ? "↓"
                    : "";
              const reasons = [];
              if (r.hba1c > 9) reasons.push("HbA1c " + r.hba1c + "%");
              if (r.prevHba1c && r.hba1c > r.prevHba1c)
                reasons.push("Rising from " + r.prevHba1c + "%");
              if (r.medPct != null && r.medPct < 60) reasons.push(r.medPct + "% compliance");
              return (
                <div
                  key={r.id}
                  className="ld-row"
                  onClick={() => select(r)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 10px",
                    background: REL,
                    border: `1px solid ${RE}22`,
                    borderRadius: 7,
                    marginBottom: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>{r.name}</div>
                    <div style={{ fontSize: 10, color: RE }}>{reasons.join(" · ")}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: FM, fontSize: 13, color: RE, fontWeight: 600 }}>
                      {r.hba1c}% <span style={{ color: trend === "↑" ? RE : GN }}>{trend}</span>
                    </div>
                    <div style={{ fontSize: 10, color: INK3 }}>{r.time}</div>
                  </div>
                </div>
              );
            })
          )}

          {m.missingBio.length > 0 && (
            <div style={{ borderTop: `1px solid ${BD}`, paddingTop: 8, marginTop: 4 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: AM,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  marginBottom: 6,
                }}
              >
                ⚠ No biomarkers entered yet
              </div>
              {m.missingBio.map((r) => (
                <div
                  key={r.id}
                  className="ld-row"
                  onClick={() => select(r)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "7px 10px",
                    background: AML,
                    border: `1px solid ${AM}22`,
                    borderRadius: 7,
                    marginBottom: 6,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>{r.name}</div>
                    <div style={{ fontSize: 10, color: AM }}>Enter HbA1c before visit</div>
                  </div>
                  <div style={{ fontSize: 10, color: INK3, fontFamily: FM }}>{r.time}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Card style={{ flex: 1 }}>
            <SectionTitle
              right={
                <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                  {m.onTrack.length} patients
                </span>
              }
            >
              ✅ On track today
            </SectionTitle>
            {m.onTrack.length === 0 ? (
              <div style={{ fontSize: 12, color: INK3 }}>No patients at target today</div>
            ) : (
              m.onTrack.map((r) => {
                const trend =
                  r.prevHba1c && r.hba1c > r.prevHba1c
                    ? "↑"
                    : r.prevHba1c && r.hba1c < r.prevHba1c
                      ? "↓"
                      : "";
                return (
                  <div
                    key={r.id}
                    className="ld-row"
                    onClick={() => select(r)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "7px 10px",
                      background: GNL,
                      border: `1px solid ${GN}22`,
                      borderRadius: 7,
                      marginBottom: 6,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>{r.name}</div>
                      <div style={{ fontSize: 10, color: GN }}>
                        {r.category === "ctrl" ? "Controlled" : "Improving"}
                      </div>
                    </div>
                    <div style={{ fontFamily: FM, fontSize: 13, color: GN, fontWeight: 600 }}>
                      {r.hba1c}% <span>{trend}</span>
                    </div>
                  </div>
                );
              })
            )}
          </Card>

          <Card>
            <SectionTitle>HbA1c distribution — today</SectionTitle>
            <div
              style={{
                display: "flex",
                gap: 7,
                alignItems: "flex-end",
                height: 56,
                marginBottom: 6,
              }}
            >
              {m.buckets.map((count, i) => {
                const max = Math.max(...m.buckets, 1);
                const h = Math.max(4, Math.round((count / max) * 50));
                const colors = [GN, "#5aad5a", AM, "#e07030", RE];
                return (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 3,
                    }}
                  >
                    <div style={{ fontFamily: FM, fontSize: 10, color: colors[i] }}>{count}</div>
                    <div
                      style={{
                        width: "100%",
                        background: colors[i],
                        borderRadius: "3px 3px 0 0",
                        height: h,
                        transition: "height .5s",
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              {["≤7%", "7–8", "8–9", "9–10", ">10%"].map((r) => (
                <div key={r} style={{ flex: 1, textAlign: "center", fontSize: 9, color: INK3 }}>
                  {r}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* ── Programme goal ────────────────────────────────────── */}
      <Card
        style={{
          borderLeft: `3px solid ${T}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              Programme Goal — 100% Patients in Control
            </div>
            <div style={{ fontSize: 11, color: INK3 }}>
              Today&apos;s progress toward the programme mission
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: FM,
                fontSize: 28,
                fontWeight: 500,
                color: controlColor,
              }}
            >
              {m.pctControlled}%
            </div>
            <div style={{ fontSize: 10, color: INK3 }}>of {m.withHba1c} with data at target</div>
          </div>
        </div>
        <div
          style={{
            height: 10,
            background: BG,
            borderRadius: 5,
            overflow: "hidden",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${m.pctControlled}%`,
              background: `linear-gradient(90deg, ${RE}, ${AM}, ${GN})`,
              borderRadius: 5,
              transition: "width .8s",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            color: INK3,
          }}
        >
          <span>0%</span>
          <span style={{ color: AM, fontWeight: 600 }}>Today: {m.pctControlled}%</span>
          <span style={{ color: GN, fontWeight: 600 }}>Goal: 100%</span>
        </div>
      </Card>
    </div>
  );
}
