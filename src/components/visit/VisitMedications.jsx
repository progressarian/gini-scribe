import { memo, useState, useMemo } from "react";
import { MED_COLORS, fmtDate, fmtDateShort, isSameDate } from "./helpers";
import { findDrug } from "../../config/drugDatabase";
import { formatWhenToTake } from "../../config/medicationTimings";
import {
  detectMedCategory,
  getCategoryLabel,
  groupMedicationsByCategory as sharedGroupByCategory,
} from "../../server-utils/medicationCategories";
import ChangesPopover from "./ChangesPopover";
import { displayMedName, displayFormBadge } from "../../lib/medName";

// Auto-detect med group from a medicine name. Delegates to the shared
// detection logic in src/server-utils/medicationCategories.js so the medcard
// view and the printed prescription always agree on which group a medicine
// belongs to. Edit category metadata/patterns there, not here.
export function autoDetectGroup(name) {
  // Prefer the local drug database first (it carries doctor-curated mappings
  // not present in the pattern lists), then fall back to shared detection.
  const n = (name || "").toLowerCase();
  const baseName = n.replace(/\s*\(.*\)/, "").trim();
  const drug = findDrug(baseName) || findDrug(n);
  if (drug?.group) return drug.group;
  return detectMedCategory({ name });
}

// Strip leading source tag (e.g. "report_extract:32059 — ", "healthray:233038167 - ")
// from a stop_reason before display. The tag is debug noise; only the human
// reason after the dash is shown.
function cleanStopReason(s) {
  if (!s) return s;
  return String(s).replace(/^[a-z_]+:[A-Za-z0-9_-]+\s*[—–-]\s*/i, "");
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
  // After collapsing, pin started_date / prescribed_date to the earliest start
  // across entries (used for "Since DD MMM YYYY" display) and pin
  // last_prescribed_date to the most recent renewal (used by the lastVisit /
  // prevVisit splitter — see below).
  Object.values(grouped).forEach((g) => {
    const earliestStarted = g._entries
      .map((e) => e.started_date)
      .filter(Boolean)
      .reduce((a, b) => (!a || b < a ? b : a), null);
    if (earliestStarted) {
      g.started_date = earliestStarted;
      g.prescribed_date = earliestStarted;
    }
    const latestPrescribed = g._entries
      .map((e) => e.last_prescribed_date)
      .filter(Boolean)
      .reduce((a, b) => (!a || b > a ? b : a), null);
    if (latestPrescribed) g.last_prescribed_date = latestPrescribed;
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

// Group medications by med_group. Uses the shared category resolver from
// medicationCategories.js so medcard groupings stay consistent with the
// printed prescription; the local diabetes sub-class sort is preserved
// because it's tuned for the medcard UI specifically.
export function groupMedsByCategory(meds) {
  const groups = sharedGroupByCategory(
    meds.map((m) => ({ ...m, med_group: m.med_group || autoDetectGroup(m.name) })),
  );
  if (groups.diabetes && groups.diabetes.length > 1) {
    groups.diabetes = [...groups.diabetes].sort(
      (a, b) => diabetesClassOrder(a.name) - diabetesClassOrder(b.name),
    );
  }
  return groups;
}

// Get group label. Delegates to the shared module so renaming a category
// updates both medcard and the printed prescription.
export function getGroupLabel(group) {
  return getCategoryLabel(group);
}

// Build a concise summary line for a single history entry.
// `h` shape: { at, reason, from:{dose,frequency,timing,when_to_take}, to:{...} }
function summarizeHistoryEntry(h) {
  if (!h || !h.from || !h.to) return "Updated";
  const parts = [];
  if ((h.from.dose || "") !== (h.to.dose || ""))
    parts.push(`Dose: ${h.from.dose || "—"} → ${h.to.dose || "—"}`);
  if ((h.from.frequency || "") !== (h.to.frequency || ""))
    parts.push(`Freq: ${h.from.frequency || "—"} → ${h.to.frequency || "—"}`);
  if (formatWhenToTake(h.from.when_to_take) !== formatWhenToTake(h.to.when_to_take))
    parts.push(
      `When: ${formatWhenToTake(h.from.when_to_take) || "—"} → ${formatWhenToTake(h.to.when_to_take) || "—"}`,
    );
  if ((h.from.timing || "") !== (h.to.timing || ""))
    parts.push(`Note: ${h.from.timing || "—"} → ${h.to.timing || "—"}`);
  return parts.length ? parts.join(" · ") : "Updated";
}

function MedHistoryPanel({ history, current }) {
  if (!history?.length) return null;
  const sorted = [...history].sort((a, b) => (a.at < b.at ? 1 : -1));
  // Normalise when_to_take through formatWhenToTake so the Postgres array
  // literal (e.g. `{"At bedtime"}`) renders as `At bedtime`, not raw.
  const fmtRx = (s) =>
    [s?.dose, s?.frequency, formatWhenToTake(s?.when_to_take), s?.timing]
      .filter(Boolean)
      .join(" · ") || "—";

  // Build version list newest→oldest: current state, then each "from" snapshot
  const versions = [
    {
      label: "Current",
      at: null,
      rx: fmtRx({
        dose: current?.dose,
        frequency: current?.frequency,
        when_to_take: current?.when_to_take,
        timing: current?.timing,
      }),
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
  onAddSubMed,
  onEditMed,
  onStopMed,
  onMoveToActive,
  onDeleteMed,
  onRestartMed,
}) {
  const [showStopped, setShowStopped] = useState(false);
  const [showPrev, setShowPrev] = useState(false);
  const [expandedHist, setExpandedHist] = useState({});
  const [restartingId, setRestartingId] = useState(null);
  const [movingId, setMovingId] = useState(null);

  const handleRestart = async (m) => {
    if (!onRestartMed || restartingId != null) return;
    setRestartingId(m.id);
    try {
      await onRestartMed(m);
    } finally {
      setRestartingId(null);
    }
  };

  const handleMoveToActive = async (m) => {
    if (!onMoveToActive || movingId != null) return;
    setMovingId(m.id);
    try {
      await onMoveToActive(m);
    } finally {
      setMovingId(null);
    }
  };
  const toggleHist = (key) => setExpandedHist((s) => ({ ...s, [key]: !s[key] }));

  const uniqueActive = useMemo(() => dedup(activeMeds), [activeMeds]);
  const uniqueStopped = useMemo(() => dedup(stoppedMeds), [stoppedMeds]);

  // Split: last visit meds (active) vs previous visit meds. Source of truth
  // is the `visit_status` column stamped by scribe on every med-write path
  // (see services/medication/visitStatus.js). Rows missing the key (legacy
  // / mid-migration) default to 'current' so nothing disappears from the UI.
  const lastVisitMeds = useMemo(
    () => uniqueActive.filter((m) => m.visit_status !== "previous"),
    [uniqueActive],
  );
  const prevVisitMeds = useMemo(
    () => uniqueActive.filter((m) => m.visit_status === "previous"),
    [uniqueActive],
  );

  // Build a parent → children map for support / conditional medications.
  // Children are still rendered, but indented under their parent rather than
  // as siblings of it in the group lists.
  const childrenByParent = useMemo(() => {
    const m = {};
    for (const med of lastVisitMeds) {
      if (med.parent_medication_id) {
        (m[med.parent_medication_id] ||= []).push(med);
      }
    }
    return m;
  }, [lastVisitMeds]);

  const topLevelMeds = useMemo(
    () => lastVisitMeds.filter((m) => !m.parent_medication_id),
    [lastVisitMeds],
  );

  // Same parent→children grouping for the previous-visit bucket so support
  // meds nest under their parent there too instead of appearing as orphaned rows.
  const prevChildrenByParent = useMemo(() => {
    const m = {};
    for (const med of prevVisitMeds) {
      if (med.parent_medication_id) {
        (m[med.parent_medication_id] ||= []).push(med);
      }
    }
    return m;
  }, [prevVisitMeds]);

  const prevTopLevelMeds = useMemo(() => {
    const prevIds = new Set(prevVisitMeds.map((m) => m.id));
    return prevVisitMeds.filter(
      (m) => !m.parent_medication_id || !prevIds.has(m.parent_medication_id),
    );
  }, [prevVisitMeds]);

  // Same grouping for the stopped bucket so the "Show stopped" list nests
  // sub-medicines under the stopped parent they belonged to.
  const stoppedChildrenByParent = useMemo(() => {
    const m = {};
    for (const med of uniqueStopped) {
      if (med.parent_medication_id) {
        (m[med.parent_medication_id] ||= []).push(med);
      }
    }
    return m;
  }, [uniqueStopped]);

  const stoppedTopLevelMeds = useMemo(
    () => uniqueStopped.filter((m) => !m.parent_medication_id),
    [uniqueStopped],
  );

  // Children whose parent isn't in the stopped list (parent still active or
  // missing). Render these flat at the bottom so they aren't lost.
  const orphanStoppedChildren = useMemo(() => {
    const stoppedIds = new Set(stoppedTopLevelMeds.map((m) => m.id));
    return uniqueStopped.filter(
      (m) => m.parent_medication_id && !stoppedIds.has(m.parent_medication_id),
    );
  }, [uniqueStopped, stoppedTopLevelMeds]);

  // Shared renderer for support / sub-medicines so the visual treatment is
  // identical in the current-visit, previous-visit, and stopped lists.
  // Tree-line + accent border + a single combined "Support for X · condition"
  // pill. `isPrev` softens the accent; `isStopped` switches it to grey and
  // swaps the action buttons for a single Restart? button.
  const SubMedRow = ({ child, parent, isPrev = false, isStopped = false }) => {
    let accent = "#818CF8"; // current visit (indigo-400)
    let accentBg = "#F5F3FF";
    let connector = "#C7D2FE";
    if (isStopped) {
      accent = "#CBD5E1"; // slate-300
      accentBg = "#F8FAFC";
      connector = "#E2E8F0";
    } else if (isPrev) {
      accent = "#A5B4FC";
      accentBg = "#F8FAFF";
    }
    return (
      <div
        className={`mtr${isPrev || isStopped ? " stp" : ""}`}
        style={{
          background: accentBg,
          borderLeft: `3px solid ${accent}`,
          position: "relative",
        }}
      >
        <div className="mmain" style={{ paddingLeft: 30 }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 12,
              top: 0,
              height: "50%",
              width: 1,
              background: connector,
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              width: 12,
              height: 1,
              background: connector,
            }}
          />
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: accent,
              flexShrink: 0,
              marginLeft: 8,
              marginRight: 6,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div className="mbrand" style={{ fontSize: 13 }}>
              {displayFormBadge(child) && (
                <span
                  style={{
                    display: "inline-block",
                    background: "var(--bg2, #eef2f7)",
                    color: "var(--t2)",
                    fontSize: 9,
                    fontWeight: 700,
                    padding: "1px 5px",
                    marginRight: 6,
                    borderRadius: 3,
                    verticalAlign: "middle",
                  }}
                  title={child.form || child.route || ""}
                >
                  {displayFormBadge(child)}
                </span>
              )}
              {displayMedName(child)}
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 3,
                padding: "2px 7px",
                background: isStopped ? "#F1F5F9" : "#EEF2FF",
                color: isStopped ? "#475569" : "#4338CA",
                fontSize: 10,
                fontWeight: 600,
                borderRadius: 10,
                lineHeight: 1.5,
                maxWidth: "100%",
              }}
              title={`Support medicine for ${displayMedName(parent)}`}
            >
              <span>↳ Support for</span>
              <span style={{ fontWeight: 700 }}>{displayMedName(parent)}</span>
              {child.support_condition && (
                <>
                  <span style={{ opacity: 0.55 }}>·</span>
                  <span style={{ fontWeight: 500 }}>{child.support_condition}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="mtd">{child.dose || "—"}</div>
        <div className="mtd">
          {isPrev || isStopped ? "Was " : ""}
          {child.frequency || "OD"}
          {child.timing && (
            <>
              <br />
              <span style={{ fontSize: 10, color: "var(--t3)" }}>{child.timing}</span>
            </>
          )}
        </div>
        <div>
          {isStopped ? (
            <>
              <span className="stoptag">Stopped</span>
              {child.stopped_date && (
                <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 2 }}>
                  {fmtDate(child.stopped_date)}
                </div>
              )}
              {child.stop_reason && (
                <div style={{ fontSize: 9, color: "var(--t3)", marginTop: 2 }}>
                  {cleanStopReason(child.stop_reason)}
                </div>
              )}
            </>
          ) : (
            isPrev && <span className="stoptag">Prev Visit</span>
          )}
        </div>
        <div className="mtd">{child.started_date ? fmtDate(child.started_date) : "—"}</div>
        <div className="macts">
          {isStopped ? (
            <button
              className="ma ma-r"
              onClick={() => handleRestart(child)}
              disabled={restartingId === child.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                opacity: restartingId === child.id ? 0.7 : 1,
                cursor: restartingId === child.id ? "not-allowed" : "pointer",
              }}
            >
              {restartingId === child.id && (
                <span
                  aria-hidden="true"
                  style={{
                    width: 9,
                    height: 9,
                    border: "2px solid rgba(0,0,0,0.18)",
                    borderTopColor: "currentColor",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "spin 0.7s linear infinite",
                  }}
                />
              )}
              {restartingId === child.id ? "Restarting…" : "Restart?"}
            </button>
          ) : (
            <>
              {isPrev && onMoveToActive && Number.isFinite(Number(child.id)) && (
                <button
                  type="button"
                  className="ma"
                  onClick={() => handleMoveToActive(child)}
                  disabled={movingId === child.id}
                  title="Re-prescribe today — moves this medicine into the current visit list"
                  style={{
                    color: "#047857",
                    borderColor: "#A7F3D0",
                    background: "#ECFDF5",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    opacity: movingId === child.id ? 0.7 : 1,
                    cursor: movingId === child.id ? "not-allowed" : "pointer",
                  }}
                >
                  {movingId === child.id && (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 9,
                        height: 9,
                        border: "2px solid rgba(4,120,87,0.3)",
                        borderTopColor: "#047857",
                        borderRadius: "50%",
                        display: "inline-block",
                        animation: "spin 0.7s linear infinite",
                      }}
                    />
                  )}
                  {movingId === child.id ? "Moving…" : "Active"}
                </button>
              )}
              <button className="ma ma-e" onClick={() => onEditMed?.(child)}>
                Edit
              </button>
              <button className="ma ma-s" onClick={() => onStopMed?.(child)}>
                Stop
              </button>
              <button className="ma ma-d" onClick={() => onDeleteMed?.(child)}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  // Group medications by category (parents only — children render nested below their parent)
  const groupedMeds = useMemo(() => groupMedsByCategory(topLevelMeds), [topLevelMeds]);

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
      [m.dose, m.frequency, formatWhenToTake(m.when_to_take), m.timing]
        .filter(Boolean)
        .join(" · ") || "—";

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
      if (formatWhenToTake(prior.when_to_take) !== formatWhenToTake(m.when_to_take))
        out.push(
          `when: ${formatWhenToTake(prior.when_to_take) || "—"} → ${formatWhenToTake(m.when_to_take) || "—"}`,
        );
      if ((prior.timing || "") !== (m.timing || ""))
        out.push(`note: ${prior.timing || "—"} → ${m.timing || "—"}`);
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
      if (prior && formatWhenToTake(prior.when_to_take) !== formatWhenToTake(m.when_to_take)) {
        return `${m.name} when→${formatWhenToTake(m.when_to_take) || "—"}`;
      }
      if (prior && (prior.timing || "") !== (m.timing || "")) {
        return `${m.name} note→${m.timing || "—"}`;
      }
      return `${m.name} updated`;
    };

    const parts = [];
    if (added.length === 1) {
      parts.push(
        `${added[0].name} ${added[0].dose || ""}${added[0].frequency ? " " + added[0].frequency : ""} added`.trim(),
      );
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
                          <div className="mbrand">
                            {displayFormBadge(m) && (
                              <span
                                style={{
                                  display: "inline-block",
                                  background: "var(--bg2, #eef2f7)",
                                  color: "var(--t2)",
                                  fontSize: 9,
                                  fontWeight: 700,
                                  padding: "1px 5px",
                                  marginRight: 6,
                                  borderRadius: 3,
                                  verticalAlign: "middle",
                                }}
                                title={m.form || m.route || ""}
                              >
                                {displayFormBadge(m)}
                              </span>
                            )}
                            {displayMedName(m)}
                            {(m.source === "patient_app" || m.source === "manual") && (
                              <span
                                style={{
                                  display: "inline-block",
                                  background: "#EEF2FF",
                                  color: "#4338CA",
                                  fontSize: 9,
                                  fontWeight: 700,
                                  padding: "1px 5px",
                                  marginLeft: 6,
                                  borderRadius: 3,
                                  verticalAlign: "middle",
                                }}
                                title="Added by the patient in the Genie app"
                              >
                                PATIENT-ADDED
                              </span>
                            )}
                          </div>
                          <div className="mgen">
                            {m.composition || ""}
                            {m.route ? ` · ${m.route}` : ""}
                            {m.clinical_note && (
                              <span
                                style={{ color: "var(--primary)", display: "block", marginTop: 2 }}
                              >
                                {m.clinical_note}
                              </span>
                            )}
                            {m.instructions && (
                              <span
                                style={{
                                  display: "block",
                                  marginTop: 2,
                                  color: "#9A3412",
                                  fontWeight: 500,
                                }}
                                title="Administration instructions"
                              >
                                ⓘ {m.instructions}
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
                              <span style={{ color: "var(--red)" }}>
                                {" "}
                                · Dr. {m.external_doctor}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="mtd">{m.started_date ? fmtDate(m.started_date) : "—"}</div>
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
                        {(m.route === "SC" ||
                          m.route === "Subcutaneous" ||
                          (m.name || "").toLowerCase().includes("inj")) && (
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
                    {(childrenByParent[m.id] || []).map((child) => (
                      <SubMedRow
                        key={child.id || `child-${m.id}-${child.name}`}
                        child={child}
                        parent={m}
                      />
                    ))}
                    {onAddSubMed && Number.isFinite(Number(m.id)) && (
                      <button
                        type="button"
                        onClick={() => onAddSubMed(m)}
                        style={{
                          marginLeft: 32,
                          marginTop: 2,
                          marginBottom: 4,
                          padding: "2px 8px",
                          fontSize: 11,
                          color: "#4338CA",
                          background: "transparent",
                          border: "1px dashed #C7D2FE",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                        title={`Add a support medicine under ${displayMedName(m)}`}
                      >
                        + Add support medicine
                      </button>
                    )}
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
            {prevTopLevelMeds.map((m, i) => (
              <div key={m.id || i}>
                <div className="mtr stp">
                  <div className="mmain">
                    <div className="mdot" style={{ background: "var(--t4)" }} />
                    <div>
                      <div className="mbrand">{displayMedName(m)}</div>
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
                  <div className="mtd">{m.started_date ? fmtDate(m.started_date) : "—"}</div>
                  <div className="macts">
                    {onMoveToActive && Number.isFinite(Number(m.id)) && (
                      <button
                        type="button"
                        className="ma"
                        onClick={() => handleMoveToActive(m)}
                        disabled={movingId === m.id}
                        title="Re-prescribe today — moves this medicine into the current visit list"
                        style={{
                          color: "#047857",
                          borderColor: "#A7F3D0",
                          background: "#ECFDF5",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          opacity: movingId === m.id ? 0.7 : 1,
                          cursor: movingId === m.id ? "not-allowed" : "pointer",
                        }}
                      >
                        {movingId === m.id && (
                          <span
                            aria-hidden="true"
                            style={{
                              width: 9,
                              height: 9,
                              border: "2px solid rgba(4,120,87,0.3)",
                              borderTopColor: "#047857",
                              borderRadius: "50%",
                              display: "inline-block",
                              animation: "spin 0.7s linear infinite",
                            }}
                          />
                        )}
                        {movingId === m.id ? "Moving…" : "Active"}
                      </button>
                    )}
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
                {(prevChildrenByParent[m.id] || []).map((child) => (
                  <SubMedRow
                    key={child.id || `prev-child-${m.id}-${child.name}`}
                    child={child}
                    parent={m}
                    isPrev
                  />
                ))}
              </div>
            ))}
          </>
        )}

        {/* Stopped meds */}
        {showStopped && uniqueStopped.length > 0 && (
          <>
            <div className="stp-lbl">Stopped Medications</div>
            {stoppedTopLevelMeds.map((m, i) => (
              <div key={m.id || i}>
                <div className="mtr stp">
                  <div className="mmain">
                    <div className="mdot" style={{ background: "var(--t4)" }} />
                    <div>
                      <div className="mbrand">{displayMedName(m)}</div>
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
                        {cleanStopReason(m.stop_reason)}
                      </div>
                    )}
                  </div>
                  <div className="mtd">{m.started_date ? fmtDate(m.started_date) : "—"}</div>
                  <div className="macts">
                    <button
                      className="ma ma-r"
                      onClick={() => handleRestart(m)}
                      disabled={restartingId === m.id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        opacity: restartingId === m.id ? 0.7 : 1,
                        cursor: restartingId === m.id ? "not-allowed" : "pointer",
                      }}
                    >
                      {restartingId === m.id && (
                        <span
                          aria-hidden="true"
                          style={{
                            width: 9,
                            height: 9,
                            border: "2px solid rgba(0,0,0,0.18)",
                            borderTopColor: "currentColor",
                            borderRadius: "50%",
                            display: "inline-block",
                            animation: "spin 0.7s linear infinite",
                          }}
                        />
                      )}
                      {restartingId === m.id ? "Restarting…" : "Restart?"}
                    </button>
                  </div>
                </div>
                {(stoppedChildrenByParent[m.id] || []).map((child) => (
                  <SubMedRow
                    key={child.id || `stopped-child-${m.id}-${child.name}`}
                    child={child}
                    parent={m}
                    isStopped
                  />
                ))}
              </div>
            ))}
            {orphanStoppedChildren.map((m, i) => (
              <div key={m.id || `orphan-${i}`} className="mtr stp">
                <div className="mmain">
                  <div className="mdot" style={{ background: "var(--t4)" }} />
                  <div>
                    <div className="mbrand">{displayMedName(m)}</div>
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
                      {cleanStopReason(m.stop_reason)}
                    </div>
                  )}
                </div>
                <div className="mtd">{m.started_date ? fmtDate(m.started_date) : "—"}</div>
                <div className="macts">
                  <button
                    className="ma ma-r"
                    onClick={() => handleRestart(m)}
                    disabled={restartingId === m.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      opacity: restartingId === m.id ? 0.7 : 1,
                      cursor: restartingId === m.id ? "not-allowed" : "pointer",
                    }}
                  >
                    {restartingId === m.id && (
                      <span
                        aria-hidden="true"
                        style={{
                          width: 9,
                          height: 9,
                          border: "2px solid rgba(0,0,0,0.18)",
                          borderTopColor: "currentColor",
                          borderRadius: "50%",
                          display: "inline-block",
                          animation: "spin 0.7s linear infinite",
                        }}
                      />
                    )}
                    {restartingId === m.id ? "Restarting…" : "Restart?"}
                  </button>
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
