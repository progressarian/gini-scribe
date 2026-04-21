import { memo, useState, useMemo } from "react";
import { MED_COLORS, fmtDate, fmtDateShort, isSameDate } from "./helpers";
import { MED_GROUPS, findDrug } from "../../config/drugDatabase";
import ChangesPopover from "./ChangesPopover";

// Auto-detect med group from name when med_group is not set
function autoDetectGroup(name) {
  const n = (name || "").toLowerCase();
  // Strip parenthetical composition: "Ryzodeg (Insulin degludec/aspart)" → "ryzodeg"
  const baseName = n.replace(/\s*\(.*\)/, "").trim();

  // Try the drug database first
  const drug = findDrug(baseName) || findDrug(n);
  if (drug?.group) return drug.group;

  // Keyword-based fallback for common drugs not in the database
  // Insulin
  if (
    n.includes("insulin") ||
    [
      "ryzodeg",
      "lantus",
      "novorapid",
      "novomix",
      "humalog",
      "humulin",
      "tresiba",
      "toujeo",
      "glargine",
      "aspart",
      "lispro",
      "degludec",
    ].some((k) => baseName.includes(k))
  )
    return "diabetes";
  // Metformin combos
  if (
    n.includes("metformin") ||
    ["glycomet", "glucophage", "istamet", "obimet"].some((k) => baseName.includes(k))
  )
    return "diabetes";
  // SGLT2
  if (
    ["forxiga", "jardiance", "dapagliflozin", "empagliflozin", "canagliflozin", "sglt2"].some((k) =>
      baseName.includes(k),
    )
  )
    return "diabetes";
  // DPP4 + combos
  if (
    [
      "trajenta",
      "januvia",
      "galvus",
      "sitagliptin",
      "vildagliptin",
      "linagliptin",
      "teneligliptin",
      "gliptin",
      "janumet",
      "istavel",
      "zita",
      "jalra",
    ].some((k) => baseName.includes(k))
  )
    return "diabetes";
  // GLP1
  if (
    [
      "ozempic",
      "rybelsus",
      "mounjaro",
      "semaglutide",
      "tirzepatide",
      "liraglutide",
      "dulaglutide",
    ].some((k) => baseName.includes(k))
  )
    return "diabetes";
  // Sulphonylureas
  if (
    ["glimepiride", "gliclazide", "glipizide", "amaryl", "diamicron", "glizid", "glimpid"].some(
      (k) => baseName.includes(k),
    )
  )
    return "diabetes";
  // Other diabetes
  if (["glucobay", "acarbose", "voglibose", "pioglitazone"].some((k) => baseName.includes(k)))
    return "diabetes";
  // ACE/ARB (kidney/BP)
  if (
    [
      "ramipril",
      "enalapril",
      "lisinopril",
      "telmisartan",
      "losartan",
      "olmesartan",
      "valsartan",
      "telisatan",
      "telma",
      "cardace",
    ].some((k) => baseName.includes(k))
  )
    return "kidney";
  // BP
  if (
    [
      "amlodipine",
      "metoprolol",
      "atenolol",
      "cilacar",
      "cilnidipine",
      "chlorthalidone",
      "hydrochlorothiazide",
      "bisoprolol",
      "carvedilol",
      "prazosin",
    ].some((k) => baseName.includes(k))
  )
    return "bp";
  // Lipids
  if (
    [
      "rosuvastatin",
      "atorvastatin",
      "rosulip",
      "atorva",
      "lipitas",
      "crestor",
      "fenofibrate",
      "ezetimibe",
      "statin",
    ].some((k) => baseName.includes(k))
  )
    return "lipids";
  // Antiplatelet (under BP/cardiac)
  if (
    ["aspirin", "ecospirin", "clopidogrel", "prasugrel", "ticagrelor"].some((k) =>
      baseName.includes(k),
    )
  )
    return "bp";
  // Thyroid
  if (["levothyroxine", "thyronorm", "eltroxin", "thyroxine"].some((k) => baseName.includes(k)))
    return "thyroid";
  // Prostate / Urology (don't lump with supplements)
  if (
    [
      "tamsulosin",
      "urimax",
      "silodosin",
      "dutasteride",
      "finasteride",
      "alfuzosin",
      "flotral",
    ].some((k) => baseName.includes(k))
  )
    return "external";
  // Supplements
  if (
    [
      "vitamin",
      "aktiv",
      "calci",
      "calcium",
      "shelcal",
      "iron",
      "folic",
      "omega",
      "maxepa",
      "methylcobal",
      "b12",
      "d3",
      "cospiaq",
      "probiot",
      "enzyme",
      "pantop",
      "panto",
      "rabep",
      "omeprazole",
    ].some((k) => baseName.includes(k))
  )
    return "supplement";

  return "supplement"; // fallback
}

// Deduplicate meds by name (same logic as Outcomes page)
function dedup(meds) {
  const grouped = {};
  meds.forEach((m) => {
    // Normalize: strip parenthetical composition for dedup
    // "GLIZID M XR (GLICLAZIDE/METFORMIN)" → "GLIZID M XR"
    const raw = (m.pharmacy_match || m.name || "").toUpperCase();
    const key = raw
      .replace(/\s*\(.*\)/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!key) return;
    if (!grouped[key]) {
      grouped[key] = { ...m, _entries: [] };
    }
    // Keep the entry with latest data
    const k = `${m.dose}|${m.frequency}|${m.prescribed_date || m.created_at}`;
    const isDup = grouped[key]._entries.some(
      (e) => `${e.dose}|${e.frequency}|${e.prescribed_date || e.created_at}` === k,
    );
    if (!isDup) grouped[key]._entries.push(m);
    // Use the most recent entry's data
    if (
      !grouped[key].prescribed_date ||
      (m.prescribed_date && m.prescribed_date > grouped[key].prescribed_date)
    ) {
      const entries = grouped[key]._entries;
      Object.assign(grouped[key], m, { _entries: entries });
    }
  });
  return Object.values(grouped);
}

// Drug class sort order within diabetes group (from clinical brief)
// Insulin first (highest risk), then foundation → benefit → glucose lowering
function diabetesClassOrder(name) {
  const n = (name || "").toLowerCase();
  const base = n.replace(/\s*\(.*\)/, "").trim();
  if (
    [
      "insulin",
      "ryzodeg",
      "lantus",
      "novorapid",
      "novomix",
      "humalog",
      "humulin",
      "tresiba",
      "toujeo",
      "glargine",
      "aspart",
      "lispro",
      "degludec",
    ].some((k) => base.includes(k))
  )
    return 1;
  if (["metformin", "glycomet", "glucophage", "obimet"].some((k) => base.includes(k))) return 2;
  if (
    ["forxiga", "jardiance", "dapagliflozin", "empagliflozin", "canagliflozin"].some((k) =>
      base.includes(k),
    )
  )
    return 3;
  if (
    [
      "ozempic",
      "rybelsus",
      "mounjaro",
      "semaglutide",
      "tirzepatide",
      "liraglutide",
      "dulaglutide",
    ].some((k) => base.includes(k))
  )
    return 4;
  if (
    [
      "trajenta",
      "januvia",
      "galvus",
      "sitagliptin",
      "vildagliptin",
      "linagliptin",
      "teneligliptin",
      "janumet",
      "istavel",
      "jalra",
    ].some((k) => base.includes(k))
  )
    return 5;
  if (
    ["glimepiride", "gliclazide", "glipizide", "amaryl", "diamicron", "glizid", "glimpid"].some(
      (k) => base.includes(k),
    )
  )
    return 6;
  if (["glucobay", "acarbose", "voglibose", "pioglitazone"].some((k) => base.includes(k))) return 7;
  // Combo drugs with metformin — sort by the non-metformin component
  if (base.includes("istamet") || base.includes("dapanorm")) return 3; // SGLT2/DPP4 + met combos
  return 8;
}

// Group medications by med_group (auto-detect from name if not set)
function groupMedsByCategory(meds) {
  const groups = {};
  meds.forEach((m) => {
    const group = m.med_group || autoDetectGroup(m.name);
    if (!groups[group]) groups[group] = [];
    groups[group].push(m);
  });
  // Sort within diabetes group by drug class order
  if (groups.diabetes) {
    groups.diabetes.sort((a, b) => diabetesClassOrder(a.name) - diabetesClassOrder(b.name));
  }
  return groups;
}

// Get group label
function getGroupLabel(group) {
  const found = MED_GROUPS.find((g) => g.id === group);
  return found ? found.label : group.charAt(0).toUpperCase() + group.slice(1);
}

// Build a concise summary line for a single history entry.
// `h` shape: { at, reason, from:{dose,frequency,timing}, to:{...} }
function summarizeHistoryEntry(h) {
  if (!h || !h.from || !h.to) return "Updated";
  const parts = [];
  if ((h.from.dose || "") !== (h.to.dose || ""))
    parts.push(`Dose: ${h.from.dose || "—"} → ${h.to.dose || "—"}`);
  if ((h.from.frequency || "") !== (h.to.frequency || ""))
    parts.push(`Freq: ${h.from.frequency || "—"} → ${h.to.frequency || "—"}`);
  if ((h.from.timing || "") !== (h.to.timing || ""))
    parts.push(`Timing: ${h.from.timing || "—"} → ${h.to.timing || "—"}`);
  return parts.length ? parts.join(" · ") : "Updated";
}

function MedHistoryPanel({ history, current }) {
  if (!history?.length) return null;
  const sorted = [...history].sort((a, b) => (a.at < b.at ? 1 : -1));
  const fmtRx = (s) =>
    [s?.dose, s?.frequency, s?.timing].filter(Boolean).join(" · ") || "—";

  // Build version list newest→oldest: current state, then each "from" snapshot
  const versions = [
    {
      label: "Current",
      at: null,
      rx: fmtRx({ dose: current?.dose, frequency: current?.frequency, timing: current?.timing }),
      reason: null,
    },
    ...sorted.map((h, i) => ({
      label: i === 0 ? "Previous" : `v${sorted.length - i}`,
      at: h.at,
      rx: fmtRx(h.from),
      reason: h.reason,
      change: summarizeHistoryEntry(h),
    })),
  ];

  return (
    <div
      style={{
        background: "#fafafa",
        borderBottom: "1px solid var(--border)",
        padding: "8px 10px 10px 40px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--t4)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        Medication history ({sorted.length} edit{sorted.length === 1 ? "" : "s"})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {versions.map((v, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "6px 8px",
              background: i === 0 ? "#ecfdf5" : "#ffffff",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: i === 0 ? "#047857" : "var(--t3)",
                minWidth: 64,
                paddingTop: 2,
              }}
            >
              {v.label}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: "var(--text)" }}>{v.rx}</div>
              {v.change && (
                <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 2 }}>
                  Changed → {v.change}
                </div>
              )}
              <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 2 }}>
                {v.at ? fmtDate(v.at) : "In use now"}
                {v.reason ? ` · ${v.reason}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const VisitMedications = memo(function VisitMedications({
  activeMeds,
  stoppedMeds,
  onAddMed,
  onEditMed,
  onStopMed,
  onDeleteMed,
}) {
  const [showStopped, setShowStopped] = useState(false);
  const [showPrev, setShowPrev] = useState(false);
  const [expandedHist, setExpandedHist] = useState({});
  const toggleHist = (key) => setExpandedHist((s) => ({ ...s, [key]: !s[key] }));

  const uniqueActive = useMemo(() => dedup(activeMeds), [activeMeds]);
  const uniqueStopped = useMemo(() => dedup(stoppedMeds), [stoppedMeds]);

  // Split: last visit meds (active) vs previous visit meds (display as stopped)
  const { lastVisitMeds, prevVisitMeds } = useMemo(() => {
    const dates = uniqueActive.map((m) => m.prescribed_date).filter(Boolean);
    const latestDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
    if (!latestDate) return { lastVisitMeds: uniqueActive, prevVisitMeds: [] };
    return {
      lastVisitMeds: uniqueActive.filter(
        (m) => !m.prescribed_date || m.prescribed_date === latestDate,
      ),
      prevVisitMeds: uniqueActive.filter(
        (m) => m.prescribed_date && m.prescribed_date !== latestDate,
      ),
    };
  }, [uniqueActive]);

  // Group medications by category
  const groupedMeds = useMemo(() => groupMedsByCategory(lastVisitMeds), [lastVisitMeds]);

  // Group order
  const groupOrder = ["diabetes", "kidney", "bp", "lipids", "thyroid", "supplement", "external"];

  const medSummary = useMemo(() => {
    if (!activeMeds?.length) return null;

    const latest = activeMeds.reduce((max, m) => {
      const d = m.updated_at || m.started_date || m.created_at;
      return d && d > (max || "") ? d : max;
    }, null);
    if (!latest) return null;

    const onDate = activeMeds.filter((m) => {
      const d = m.updated_at || m.started_date || m.created_at;
      return d && isSameDate(d, latest);
    });

    const added = onDate.filter((m) => isSameDate(m.created_at, latest));
    const changed = onDate.filter((m) => !isSameDate(m.created_at, latest));

    // Build a lookup of prior versions of each med (by name key) so we can
    // compare dose/frequency/timing and surface what actually changed.
    const normKey = (m) =>
      (m.pharmacy_match || m.name || "")
        .toUpperCase()
        .replace(/\s*\(.*\)/, "")
        .replace(/\s+/g, " ")
        .trim();
    const priorByKey = {};
    for (const m of activeMeds) {
      if (isSameDate(m.updated_at || m.started_date || m.created_at, latest)) continue;
      const k = normKey(m);
      if (!k) continue;
      const d = m.updated_at || m.started_date || m.created_at;
      if (!priorByKey[k] || (d && d > priorByKey[k]._d)) priorByKey[k] = { ...m, _d: d };
    }

    const fmtRx = (m) =>
      [m.dose, m.frequency, m.timing].filter(Boolean).join(" · ") || "—";

    // Build a diff field list for a changed med vs its prior version.
    // Only include fields that actually changed — no extracted details.
    const diffLines = (m) => {
      const prior = priorByKey[normKey(m)];
      if (!prior) return [fmtRx(m)];
      const out = [];
      if ((prior.dose || "") !== (m.dose || ""))
        out.push(`dose: ${prior.dose || "—"} → ${m.dose || "—"}`);
      if ((prior.frequency || "") !== (m.frequency || ""))
        out.push(`freq: ${prior.frequency || "—"} → ${m.frequency || "—"}`);
      if ((prior.timing || "") !== (m.timing || ""))
        out.push(`timing: ${prior.timing || "—"} → ${m.timing || "—"}`);
      return out.length ? out : [`${fmtRx(prior)} → ${fmtRx(m)}`];
    };

    // Short inline change label for the left-of-title pill
    const shortChange = (m) => {
      const prior = priorByKey[normKey(m)];
      if (prior && (prior.dose || "") !== (m.dose || "")) {
        return `${m.name} ${prior.dose || "—"}→${m.dose || "—"}`;
      }
      if (prior && (prior.frequency || "") !== (m.frequency || "")) {
        return `${m.name} ${prior.frequency || "—"}→${m.frequency || "—"}`;
      }
      if (prior && (prior.timing || "") !== (m.timing || "")) {
        return `${m.name} timing→${m.timing || "—"}`;
      }
      return `${m.name} updated`;
    };

    const parts = [];
    if (added.length === 1) {
      parts.push(`${added[0].name} ${added[0].dose || ""}${added[0].frequency ? " " + added[0].frequency : ""} added`.trim());
    } else if (added.length > 1) {
      parts.push(`${added.length} meds added`);
    }
    if (changed.length === 1) {
      parts.push(shortChange(changed[0]));
    } else if (changed.length > 1) {
      parts.push(`${changed.length} meds changed`);
    }

    const text = parts.length > 0 ? parts.join(", ") : "Updated";

    const tooltipLines = [`Changes on ${fmtDate(latest)}:`];
    if (added.length > 0) {
      tooltipLines.push("Added:");
      added.forEach((m) => {
        tooltipLines.push(`  + ${m.name} ${fmtRx(m)}`);
      });
    }
    if (changed.length > 0) {
      tooltipLines.push("Changed:");
      changed.forEach((m) => {
        tooltipLines.push(`  • ${m.name}`);
        diffLines(m).forEach((line) => tooltipLines.push(`      ${line}`));
      });
    }

    const addedDetails = added.map((m) => ({
      name: m.name,
      diff: [fmtRx(m)],
    }));
    const changedDetails = changed.map((m) => ({
      name: m.name,
      diff: diffLines(m),
    }));

    return {
      text,
      date: latest,
      tooltip: tooltipLines.join("\n"),
      added: addedDetails,
      changed: changedDetails,
    };
  }, [activeMeds]);

  return (
    <div className="sc" id="medications">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-g">💊</div>Medications
          {medSummary && (
            <ChangesPopover
              date={medSummary.date}
              label={`${medSummary.text} — ${fmtDateShort(medSummary.date)}`}
              added={medSummary.added}
              changed={medSummary.changed}
            />
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {prevVisitMeds.length > 0 && (
            <button className="bx bx-n" onClick={() => setShowPrev(!showPrev)}>
              Prev Visit ({prevVisitMeds.length})
            </button>
          )}
          {uniqueStopped.length > 0 && (
            <button className="bx bx-n" onClick={() => setShowStopped(!showStopped)}>
              Stopped Meds
            </button>
          )}
          <button className="bx bx-p" onClick={onAddMed}>
            + Add Medicine
          </button>
        </div>
      </div>
      <div className="scb">
        <div className="mth">
          <span className="mthl">Medicine</span>
          <span className="mthl">Dose</span>
          <span className="mthl">Timing</span>
          <span className="mthl">For / Since</span>
          <span className="mthl">Started On</span>
          <span className="mthl">Actions</span>
        </div>

        {groupOrder.map((group) => {
          const meds = groupedMeds[group];
          if (!meds || meds.length === 0) return null;

          const isExternal = group === "external";

          return (
            <div key={group}>
              {/* Group header */}
              <div
                className="med-group-header"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  background: isExternal ? "#fef2f2" : "#f8fafc",
                  borderBottom: `1px solid ${isExternal ? "#fecaca" : "var(--border)"}`,
                  marginTop: group === groupOrder[0] ? 0 : 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: isExternal ? "#dc2626" : "var(--t2)",
                  }}
                >
                  {getGroupLabel(group)}
                </span>
                <span style={{ fontSize: 10, color: "var(--t4)" }}>({meds.length})</span>
                {isExternal && (
                  <span style={{ fontSize: 10, color: "#dc2626", marginLeft: "auto" }}>
                    Do not modify without consent
                  </span>
                )}
              </div>

              {/* Medications in group */}
              {meds.map((m, i) => {
                const rowKey = m.id || `${group}-${i}`;
                const hasHistory = Array.isArray(m.history) && m.history.length > 0;
                const isOpen = !!expandedHist[rowKey];
                return (
                <div key={rowKey}>
                <div className="mtr">
                  <div className="mmain">
                    {hasHistory ? (
                      <button
                        type="button"
                        aria-label={isOpen ? "Hide history" : "Show history"}
                        onClick={() => toggleHist(rowKey)}
                        style={{
                          width: 18,
                          height: 18,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          color: "var(--t2)",
                          fontSize: 12,
                          padding: 0,
                          marginRight: 2,
                          transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                          transition: "transform 0.15s ease",
                        }}
                        title={`${m.history.length} previous version${m.history.length === 1 ? "" : "s"}`}
                      >
                        ▶
                      </button>
                    ) : (
                      <span style={{ width: 18, display: "inline-block" }} />
                    )}
                    <div
                      className="mdot"
                      style={{ background: MED_COLORS[i % MED_COLORS.length] }}
                    />
                    <div>
                      <div className="mbrand">{m.name}</div>
                      <div className="mgen">
                        {m.composition || ""}
                        {m.route ? ` · ${m.route}` : ""}
                        {m.clinical_note && (
                          <span style={{ color: "var(--primary)", display: "block", marginTop: 2 }}>
                            {m.clinical_note}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mtd">{m.dose || "—"}</div>
                  <div className="mtd">
                    {m.frequency || "OD"}
                    {m.timing && (
                      <>
                        <br />
                        <span style={{ fontSize: 10, color: "var(--t3)" }}>{m.timing}</span>
                      </>
                    )}
                  </div>
                  <div>
                    {m.for_diagnosis?.length > 0 && (
                      <span className="mfor">{m.for_diagnosis[0]}</span>
                    )}
                    {m.prescribed_date && (
                      <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 3 }}>
                        Since {fmtDate(m.prescribed_date)}
                        {m.prescriber ? ` · ${m.prescriber}` : ""}
                        {m.external_doctor && (
                          <span style={{ color: "var(--red)" }}> · Dr. {m.external_doctor}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="mtd">{m.created_at ? fmtDate(m.created_at) : "—"}</div>
                  <div className="macts">
                    {!isExternal && (
                      <>
                        <button className="ma ma-e" onClick={() => onEditMed?.(m)}>
                          Edit
                        </button>
                        <button className="ma ma-s" onClick={() => onStopMed?.(m)}>
                          Stop
                        </button>
                        <button className="ma ma-d" onClick={() => onDeleteMed?.(m)}>
                          Delete
                        </button>
                      </>
                    )}
                    {isExternal && (
                      <button
                        className="ma"
                        style={{
                          color: "var(--t3)",
                          borderColor: "var(--border)",
                          background: "var(--bg)",
                        }}
                        title="External medication - cannot modify"
                      >
                        View Only
                      </button>
                    )}
                    {(m.route === "SC" ||
                      m.route === "Subcutaneous" ||
                      (m.name || "").toLowerCase().includes("inj")) &&
                      !isExternal && (
                        <button
                          className="ma"
                          style={{
                            color: "var(--amber)",
                            borderColor: "var(--amb-bd)",
                            background: "var(--amb-lt)",
                          }}
                        >
                          Pause
                        </button>
                      )}
                  </div>
                </div>
                  {isOpen && <MedHistoryPanel history={m.history} current={m} />}
                </div>
                );
              })}
            </div>
          );
        })}

        {lastVisitMeds.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--t3)", padding: 16, textAlign: "center" }}>
            No active medications
          </div>
        )}

        {/* Previous visit meds */}
        {showPrev && prevVisitMeds.length > 0 && (
          <>
            <div className="stp-lbl">Previous Visit Medications</div>
            {prevVisitMeds.map((m, i) => (
              <div key={m.id || i} className="mtr stp">
                <div className="mmain">
                  <div className="mdot" style={{ background: "var(--t4)" }} />
                  <div>
                    <div className="mbrand">{m.name}</div>
                    <div className="mgen">{m.composition || ""}</div>
                  </div>
                </div>
                <div className="mtd">{m.dose || "—"}</div>
                <div className="mtd">Was {m.frequency || "OD"}</div>
                <div>
                  <span className="stoptag">Prev Visit</span>
                  {m.prescribed_date && (
                    <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 2 }}>
                      {fmtDate(m.prescribed_date)}
                    </div>
                  )}
                </div>
                <div className="mtd">{m.created_at ? fmtDate(m.created_at) : "—"}</div>
                <div className="macts">
                  <button className="ma ma-e" onClick={() => onEditMed?.(m)}>
                    Edit
                  </button>
                  <button className="ma ma-s" onClick={() => onStopMed?.(m)}>
                    Stop
                  </button>
                  <button className="ma ma-d" onClick={() => onDeleteMed?.(m)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Stopped meds */}
        {showStopped && uniqueStopped.length > 0 && (
          <>
            <div className="stp-lbl">Stopped Medications</div>
            {uniqueStopped.map((m, i) => (
              <div key={m.id || i} className="mtr stp">
                <div className="mmain">
                  <div className="mdot" style={{ background: "var(--t4)" }} />
                  <div>
                    <div className="mbrand">{m.name}</div>
                    <div className="mgen">{m.composition || ""}</div>
                  </div>
                </div>
                <div className="mtd">{m.dose || "—"}</div>
                <div className="mtd">Was {m.frequency || "OD"}</div>
                <div>
                  <span className="stoptag">Stopped</span>
                  {m.stopped_date && (
                    <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 2 }}>
                      {fmtDate(m.stopped_date)}
                    </div>
                  )}
                  {m.stop_reason && (
                    <div style={{ fontSize: 9, color: "var(--t3)", marginTop: 2 }}>
                      {m.stop_reason}
                    </div>
                  )}
                </div>
                <div className="mtd">{m.created_at ? fmtDate(m.created_at) : "—"}</div>
                <div className="macts">
                  <button className="ma ma-r">Restart?</button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Add new medicine row */}
        <div className="addr" style={{ marginTop: 9 }} onClick={onAddMed}>
          <span style={{ fontSize: 16, color: "var(--t3)" }}>+</span>
          <span className="addr-lbl">Add new medicine — type to search</span>
        </div>
      </div>
    </div>
  );
});

export default VisitMedications;
