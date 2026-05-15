import { MED_COLORS } from "./helpers";
import {
  TIME_SLOTS,
  getTimeSlots,
  getTimeSlot,
  formatWhenToTake,
} from "../../config/medicationTimings";

// Mirror of the slot color tokens used by VisitMedCard's CSS variables so the
// printed window (which doesn't inherit the app's CSS) shows the same chips.
const SLOT_COLORS = {
  fasting: { fg: "#0ea5e9", bg: "#f0f9ff", border: false },
  before_breakfast: { fg: "#4466f5", bg: "#eef1fe", border: false },
  after_breakfast: { fg: "#f59e0b", bg: "#fffbeb", border: false },
  before_lunch: { fg: "#6b7280", bg: "#eef0f6", border: true },
  after_lunch: { fg: "#12b981", bg: "#edfaf5", border: false },
  before_dinner: { fg: "#6b7280", bg: "#eef0f6", border: true },
  after_dinner: { fg: "#6b7280", bg: "#eef0f6", border: true },
  at_bedtime: { fg: "#8b5cf6", bg: "#f5f3ff", border: false },
  sos_only: { fg: "#f59e0b", bg: "#fffbeb", border: false },
  any_time: { fg: "#6b7280", bg: "#eef0f6", border: true },
};

export { TIME_SLOTS, getTimeSlots, getTimeSlot };

// Build the grouping used by the printable HTML and by the in-tab renderer.
// Child/support meds (those with a parent_medication_id) are excluded — the
// card only lists primary medicines.
export function groupMedsBySlot(activeMeds) {
  const grouped = {};
  const meds = (activeMeds || []).filter((m) => !m?.parent_medication_id);
  meds.forEach((m, i) => {
    const slots = getTimeSlots(m);
    slots.forEach((slot) => {
      if (!grouped[slot]) grouped[slot] = [];
      grouped[slot].push({ ...m, _idx: i });
    });
  });
  const slotsWithMeds = TIME_SLOTS.filter((s) => grouped[s.key]?.length > 0);
  return { grouped, slotsWithMeds };
}

export function buildMedCardPrintHTML(patient, grouped, slotsWithMeds, activeMeds) {
  // Strip child/support meds so the printed card matches the in-app view.
  activeMeds = (activeMeds || []).filter((m) => !m?.parent_medication_id);
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // Re-derive groupings from activeMeds so callers that pass `null` for the
  // slot args (or stale ones) still get the correct layout. Index assignment
  // mirrors VisitMedCard's `indexedMeds` so the colored dot per medicine
  // matches between the screen and the print.
  const indexed = activeMeds.map((m, i) => ({ ...m, _idx: i }));
  const reGrouped = {};
  indexed.forEach((m) => {
    getTimeSlots(m).forEach((slotKey) => {
      (reGrouped[slotKey] ||= []).push(m);
    });
  });
  const orderedSlots = TIME_SLOTS.filter((s) => reGrouped[s.key]?.length > 0);

  const renderMedRow = (m) => {
    const dotColor = MED_COLORS[m._idx % MED_COLORS.length];
    const wt = formatWhenToTake(m.when_to_take);
    const timingTail = wt || m.timing || "";
    const composition = m.composition || (m.notes ? String(m.notes).trim() : "");
    return `
      <div style="display:grid;grid-template-columns:1.6fr .7fr 1.1fr 1fr;gap:10px;align-items:center;padding:6px 4px;border-bottom:1px solid #eef1f5">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <span style="flex:0 0 auto;display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor}"></span>
          <div style="min-width:0">
            <div style="font-size:12px;font-weight:600;color:#1a2332;line-height:1.3">${m.name || ""}</div>
            ${composition ? `<div style="font-size:10px;color:#6b7280;line-height:1.3">${composition}</div>` : ""}
          </div>
        </div>
        <div style="font-size:12px;color:#1a2332">${m.dose || "1 tablet"}</div>
        <div style="font-size:12px;color:#1a2332">${m.frequency || "OD"}${timingTail ? ` · ${timingTail}` : ""}${m.instructions ? `<div style="font-size:10px;color:#6b7280;margin-top:2px">${m.instructions}</div>` : ""}</div>
        <div style="font-size:11px;color:#374151">${m.indication ? `<span style="display:inline-block;background:#eef1fe;color:#4466f5;font-weight:600;padding:2px 8px;border-radius:999px">${m.indication}</span>` : ""}</div>
      </div>`;
  };

  let medsHTML = "";

  if (orderedSlots.length > 0) {
    orderedSlots.forEach((slot) => {
      const sc = SLOT_COLORS[slot.key] || { fg: "#6b7280", bg: "#eef0f6", border: true };
      medsHTML += `<div style="margin-bottom:12px">
        <div style="display:inline-block;font-size:10px;font-weight:700;color:${sc.fg};background:${sc.bg};text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;padding:5px 10px;border-radius:6px${sc.border ? ";border:1px solid #e4e9f2" : ""}">${slot.emoji} ${slot.label}</div>
        ${reGrouped[slot.key].map(renderMedRow).join("")}
      </div>`;
    });
  } else if (indexed.length > 0) {
    medsHTML = indexed.map(renderMedRow).join("");
  } else {
    medsHTML = `<div style="text-align:center;color:#6b7280;padding:20px;font-size:13px">No active medications</div>`;
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

  ${
    activeMeds.length > 1
      ? `<div style="font-size:13px;font-weight:600;color:#3d4f63;margin-bottom:14px">
    ${patient.name} ji, apni dawaiyan roz iss tarah leni hain:
  </div>`
      : ""
  }

  ${medsHTML}

  <div style="margin-top:20px;padding:10px 14px;background:#e6f6f4;border-radius:8px;border:1px solid rgba(0,158,140,.22);font-size:12px;color:#009e8c;display:flex;align-items:center;gap:8px">
    <span>📞</span>
    <span>Koi problem ho? Gini Health se contact karein: +91 8146320100 (WhatsApp available)</span>
  </div>
</div>
</body></html>`;
}

// High-level print entry. MUST be called synchronously inside a user-gesture click
// handler (window.open is popup-blocked otherwise). delayMs controls how long we
// wait before triggering win.print() — bump to 700 when chaining with a sibling
// print dialog so fonts/images have time to settle.
export function printMedCard(patient, activeMeds, delayMs = 300) {
  const { grouped, slotsWithMeds } = groupMedsBySlot(activeMeds);
  const html = buildMedCardPrintHTML(patient, grouped, slotsWithMeds, activeMeds);
  const win = window.open("", "_blank");
  if (!win) return null;
  win.document.write(html);
  win.document.close();
  setTimeout(() => {
    win.focus();
    win.print();
  }, delayMs);
  return win;
}
