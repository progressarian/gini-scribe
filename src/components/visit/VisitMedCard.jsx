import { memo, useRef, useCallback } from "react";
import { MED_COLORS } from "./helpers";

export const TIME_SLOTS = [
  {
    key: "fasting",
    label: "Khaali pet (Fasting)",
    emoji: "🌅",
    colorVar: "--teal",
    bgCls: "teal-lt",
  },
  {
    key: "before_breakfast",
    label: "Naashte se pehle (Before Breakfast)",
    emoji: "🌄",
    colorVar: "--primary",
    bgCls: "pri-lt",
  },
  {
    key: "after_breakfast",
    label: "Naashte ke baad (After Breakfast)",
    emoji: "☕",
    colorVar: "--amber",
    bgCls: "amb-lt",
  },
  {
    key: "before_lunch",
    label: "Khaane se pehle (Before Lunch)",
    emoji: "🍽️",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
  {
    key: "after_lunch",
    label: "Khaane ke baad (After Lunch)",
    emoji: "🍛",
    colorVar: "--green",
    bgCls: "grn-lt",
  },
  {
    key: "before_dinner",
    label: "Dinner se pehle (Before Dinner)",
    emoji: "🌙",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
  {
    key: "after_dinner",
    label: "Dinner ke baad (After Dinner)",
    emoji: "🌆",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
  {
    key: "bedtime",
    label: "Sone se pehle (Bedtime)",
    emoji: "💤",
    colorVar: "--purple",
    bgCls: "pur-lt",
  },
  { key: "weekly", label: "Weekly", emoji: "📅", colorVar: "--purple", bgCls: "pur-lt" },
];

// Returns an ARRAY of slot keys — a medicine can appear in multiple slots
export function getTimeSlots(med) {
  const t = (med.timing || "").toLowerCase();
  const f = (med.frequency || "").toLowerCase();
  const slots = new Set();

  // Explicit timing keywords
  if (t.includes("fasting")) slots.add("fasting");
  if (t.includes("before breakfast") || (t.includes("before food") && t.includes("morning")))
    slots.add("before_breakfast");
  if (t.includes("after breakfast") || t.includes("with breakfast")) slots.add("after_breakfast");
  if (t.includes("before lunch")) slots.add("before_lunch");
  if (t.includes("after lunch") || t.includes("with lunch")) slots.add("after_lunch");
  if (t.includes("before dinner") || (t.includes("before food") && t.includes("evening")))
    slots.add("before_dinner");
  if (t.includes("after dinner") || t.includes("with dinner")) slots.add("after_dinner");
  if (
    t.includes("bedtime") ||
    t.includes("at bedtime") ||
    t.includes("before bed") ||
    t.includes("night")
  )
    slots.add("bedtime");
  if (t.includes("morning") || t.includes("am")) slots.add("after_breakfast");
  if (t.includes("evening")) slots.add("after_dinner");
  if (f.includes("weekly") || f.includes("week")) slots.add("weekly");

  // Frequency-based inference when no explicit timing matched
  if (slots.size === 0) {
    if (f.includes("tds") || f.includes("tid") || f.includes("three")) {
      slots.add("after_breakfast");
      slots.add("after_lunch");
      slots.add("after_dinner");
    } else if (f.includes("bd") || f.includes("twice")) {
      slots.add("after_breakfast");
      slots.add("after_dinner");
    } else if (f.includes("od") || f.includes("once") || f.includes("hs"))
      slots.add("after_breakfast");
    else slots.add("after_breakfast"); // fallback
  }

  return [...slots];
}

// Kept for backward compatibility — returns first slot only
export function getTimeSlot(med) {
  return getTimeSlots(med)[0];
}

export function buildMedCardPrintHTML(patient, grouped, slotsWithMeds, activeMeds) {
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const slotColors = {
    fasting: { color: "#0e7490", bg: "#ecfeff" },
    before_breakfast: { color: "#009e8c", bg: "#e6f6f4" },
    after_breakfast: { color: "#d97a0a", bg: "#fef6e6" },
    before_lunch: { color: "#6b7d90", bg: "#f0f4f7" },
    after_lunch: { color: "#16a34a", bg: "#f0fdf4" },
    before_dinner: { color: "#6b7d90", bg: "#f0f4f7" },
    after_dinner: { color: "#6b7d90", bg: "#f0f4f7" },
    bedtime: { color: "#7c3aed", bg: "#f5f3ff" },
    weekly: { color: "#7c3aed", bg: "#f5f3ff" },
  };

  let medsHTML = "";

  if (slotsWithMeds.length > 0) {
    for (const slot of slotsWithMeds) {
      const sc = slotColors[slot.key] || slotColors.morning;
      medsHTML += `<div style="margin-bottom:16px">`;
      medsHTML += `<div style="font-size:11px;font-weight:700;color:${sc.color};text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;padding:5px 10px;background:${sc.bg};border-radius:6px;display:inline-block">${slot.emoji} ${slot.label}</div>`;
      medsHTML += `<table style="width:100%;border-collapse:collapse;margin-top:4px">`;
      medsHTML += `<thead><tr style="background:#f8fafc">
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Medicine</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Dose</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Frequency / Timing</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">For</th>
      </tr></thead><tbody>`;
      for (const m of grouped[slot.key]) {
        const dotColor = MED_COLORS[m._idx % MED_COLORS.length];
        medsHTML += `<tr style="border-bottom:1px solid #eef1f5">
          <td style="padding:7px 10px;font-size:12px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};margin-right:6px;vertical-align:middle"></span>
            <strong>${m.name}</strong>${m.composition ? `<br><span style="font-size:10px;color:#6b7d90;margin-left:14px">${m.composition}</span>` : ""}
          </td>
          <td style="padding:7px 10px;font-size:12px">${m.dose || "1 tablet"}</td>
          <td style="padding:7px 10px;font-size:12px">${m.frequency || "OD"}${m.timing ? ` · ${m.timing}` : ""}</td>
          <td style="padding:7px 10px;font-size:11px;color:#6b7d90">${m.indication || ""}</td>
        </tr>`;
      }
      medsHTML += `</tbody></table></div>`;
    }
  } else if (activeMeds.length > 0) {
    medsHTML += `<table style="width:100%;border-collapse:collapse">`;
    medsHTML += `<thead><tr style="background:#f8fafc">
      <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Medicine</th>
      <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Dose</th>
      <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Frequency / Timing</th>
    </tr></thead><tbody>`;
    activeMeds.forEach((m, i) => {
      const dotColor = MED_COLORS[i % MED_COLORS.length];
      medsHTML += `<tr style="border-bottom:1px solid #eef1f5">
        <td style="padding:7px 10px;font-size:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};margin-right:6px;vertical-align:middle"></span>
          <strong>${m.name}</strong>${m.composition ? `<br><span style="font-size:10px;color:#6b7d90;margin-left:14px">${m.composition}</span>` : ""}
        </td>
        <td style="padding:7px 10px;font-size:12px">${m.dose || ""}</td>
        <td style="padding:7px 10px;font-size:12px">${m.frequency || "OD"}${m.timing ? ` · ${m.timing}` : ""}</td>
      </tr>`;
    });
    medsHTML += `</tbody></table>`;
  } else {
    medsHTML = `<p style="text-align:center;color:#6b7d90;padding:20px">No active medications</p>`;
  }

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Medicine Card — ${patient.name}</title>
<style>
  @page { size: A4; margin: 18mm 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #1a2332; line-height: 1.5; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head><body>
<div style="max-width:700px;margin:0 auto">
  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #009e8c;padding-bottom:12px;margin-bottom:18px">
    <div>
      <div style="font-size:20px;font-weight:700;color:#009e8c;letter-spacing:-.5px">Gini Health</div>
      <div style="font-size:10px;color:#6b7d90">Medicine Card</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:13px;font-weight:600">${patient.name}</div>
      <div style="font-size:11px;color:#6b7d90">${patient.age ? patient.age + "Y" : ""}${patient.sex ? " · " + patient.sex : ""}${patient.file_no ? " · ID #" + patient.file_no : ""}</div>
      <div style="font-size:10px;color:#6b7d90">Printed: ${today}</div>
    </div>
  </div>

  <!-- Instruction -->
  <div style="font-size:13px;font-weight:600;color:#3d4f63;margin-bottom:14px">
    ${patient.name} ji, apni dawaiyan roz iss tarah leni hain:
  </div>

  <!-- Medications -->
  ${medsHTML}

  <!-- Footer -->
  <div style="margin-top:20px;padding:10px 14px;background:#e6f6f4;border-radius:8px;border:1px solid rgba(0,158,140,.22);font-size:12px;color:#009e8c;display:flex;align-items:center;gap:8px">
    <span>📞</span>
    <span>Koi problem ho? Gini Health se contact karein: +91 8146320100 (WhatsApp available)</span>
  </div>
</div>
</body></html>`;
}

const VisitMedCard = memo(function VisitMedCard({ patient, activeMeds }) {
  const cardRef = useRef(null);

  // Group meds by time slot — one med can appear in multiple slots
  const grouped = {};
  activeMeds.forEach((m, i) => {
    const slots = getTimeSlots(m);
    slots.forEach((slot) => {
      if (!grouped[slot]) grouped[slot] = [];
      grouped[slot].push({ ...m, _idx: i });
    });
  });

  const slotsWithMeds = TIME_SLOTS.filter((s) => grouped[s.key]?.length > 0);

  const handlePrint = useCallback(() => {
    const html = buildMedCardPrintHTML(patient, grouped, slotsWithMeds, activeMeds);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    // Wait for content to render then trigger print
    setTimeout(() => {
      win.focus();
      win.print();
    }, 300);
  }, [patient, grouped, slotsWithMeds, activeMeds]);

  return (
    <div className="panel-body">
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-g">💊</div>Medicine Card — Patient Language
          </div>
          <button className="btn" onClick={handlePrint}>
            🖨 Print Card
          </button>
        </div>
        <div className="scb" ref={cardRef}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t2)", marginBottom: 14 }}>
            {patient.name} ji, apni dawaiyan roz iss tarah leni hain:
          </div>

          {slotsWithMeds.map((slot) => (
            <div key={slot.key} className="mc-mg" style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: `var(${slot.colorVar})`,
                  textTransform: "uppercase",
                  letterSpacing: ".5px",
                  marginBottom: 6,
                  padding: "5px 10px",
                  background: `var(--${slot.bgCls})`,
                  borderRadius: 6,
                  display: "inline-block",
                  ...(slot.border ? { border: "1px solid var(--border)" } : {}),
                }}
              >
                {slot.emoji} {slot.label}
              </div>
              {grouped[slot.key].map((m) => (
                <div key={m.id || m._idx} className="mtr" style={{ marginTop: 5 }}>
                  <div className="mmain">
                    <div
                      className="mdot"
                      style={{ background: MED_COLORS[m._idx % MED_COLORS.length] }}
                    />
                    <div>
                      <div className="mbrand">{m.name}</div>
                      <div className="mgen">{m.composition || m.notes || ""}</div>
                    </div>
                  </div>
                  <div className="mtd">{m.dose || "1 tablet"}</div>
                  <div className="mtd">
                    {m.frequency || "OD"}
                    {m.timing ? ` · ${m.timing}` : ""}
                  </div>
                  <div>{m.indication && <span className="mfor">{m.indication}</span>}</div>
                  <div />
                </div>
              ))}
            </div>
          ))}

          {/* Fallback if no grouping possible - show all */}
          {slotsWithMeds.length === 0 &&
            activeMeds.length > 0 &&
            activeMeds.map((m, i) => (
              <div key={m.id || i} className="mtr" style={{ marginBottom: 5 }}>
                <div className="mmain">
                  <div className="mdot" style={{ background: MED_COLORS[i % MED_COLORS.length] }} />
                  <div>
                    <div className="mbrand">{m.name}</div>
                    <div className="mgen">{m.composition || ""}</div>
                  </div>
                </div>
                <div className="mtd">{m.dose || ""}</div>
                <div className="mtd">
                  {m.frequency || "OD"}
                  {m.timing ? ` · ${m.timing}` : ""}
                </div>
                <div>{m.indication && <span className="mfor">{m.indication}</span>}</div>
                <div />
              </div>
            ))}

          {activeMeds.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No active medications
            </div>
          )}

          <div className="noticebar pri" style={{ marginTop: 10 }}>
            <span>📞</span>
            <span className="ni pri">
              Koi problem ho? Gini Health se contact karein: +91 8146320100 (WhatsApp available)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

export default VisitMedCard;
