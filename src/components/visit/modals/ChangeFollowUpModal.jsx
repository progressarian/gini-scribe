import { memo, useState } from "react";

const PRESETS = [
  { label: "Tomorrow", days: 1 },
  { label: "1 Week", days: 7 },
  { label: "2 Weeks", days: 14 },
  { label: "4 Weeks", days: 28 },
  { label: "6 Weeks", days: 42 },
  { label: "8 Weeks", days: 56 },
  { label: "10 Weeks", days: 70 },
  { label: "12 Weeks", days: 84 },
  { label: "3 Months", days: 91 },
  { label: "6 Months", days: 182 },
];

const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
};

const ChangeFollowUpModal = memo(function ChangeFollowUpModal({ currentDate, onClose, onSubmit }) {
  const [date, setDate] = useState(currentDate || "");
  const [notes, setNotes] = useState("");
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving || !date) return;
    setSaving(true);
    try {
      await onSubmit({ date, notes });
    } finally {
      setSaving(false);
    }
  };

  const handlePresetClick = (preset) => {
    const newDate = addDays(preset.days);
    setDate(newDate);
    setSelectedPreset(preset.label);
  };

  const handleDateChange = (e) => {
    setDate(e.target.value);
    setSelectedPreset(null);
  };

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <style>{`@keyframes cfu-spin { to { transform: rotate(360deg); } }`}</style>
      <div className="mbox">
        <div className="mttl">📅 Schedule Follow-up</div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 8 }}>
            Quick Select:
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => handlePresetClick(preset)}
                style={{
                  padding: "6px 12px",
                  border:
                    selectedPreset === preset.label ? "1.5px solid #3b82f6" : "1px solid #cbd5e1",
                  borderRadius: 6,
                  background: selectedPreset === preset.label ? "#eff6ff" : "#ffffff",
                  color: selectedPreset === preset.label ? "#3b82f6" : "#475569",
                  fontSize: 13,
                  fontWeight: selectedPreset === preset.label ? 600 : 500,
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mf">
          <label className="ml">Follow-up Date *</label>
          <input className="mi" type="date" value={date} onChange={handleDateChange} />
        </div>
        <div className="mf">
          <label className="ml">Notes (optional)</label>
          <textarea
            className="mta"
            style={{ minHeight: 55 }}
            placeholder="e.g. Repeat labs before visit..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-p" disabled={!date || saving} onClick={handleSave}>
            {saving ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: "2px solid rgba(255,255,255,0.4)",
                    borderTopColor: "#ffffff",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "cfu-spin 0.7s linear infinite",
                  }}
                />
                Saving...
              </span>
            ) : (
              "Save Date"
            )}
          </button>
        </div>
      </div>
    </div>
  );
});

export default ChangeFollowUpModal;
