export const docCategories = [
  { id: "prescription", label: "💊 Prescription", color: "#2563eb" },
  { id: "blood_test", label: "🩸 Blood Test", color: "#dc2626" },
  { id: "thyroid", label: "🦋 Thyroid", color: "#7c3aed" },
  { id: "lipid", label: "🫀 Lipid Profile", color: "#f59e0b" },
  { id: "kidney", label: "🫘 Kidney Fn", color: "#059669" },
  { id: "hba1c", label: "📊 HbA1c", color: "#e11d48" },
  { id: "urine", label: "🧪 Urine", color: "#ca8a04" },
  { id: "xray", label: "🩻 X-Ray", color: "#475569" },
  { id: "usg", label: "📡 Ultrasound", color: "#6366f1" },
  { id: "mri", label: "🧲 MRI / CT", color: "#4f46e5" },
  { id: "dexa", label: "🦴 DEXA", color: "#78716c" },
  { id: "ecg", label: "💓 ECG/Echo", color: "#be123c" },
  { id: "ncs", label: "⚡ NCS/EMG", color: "#0369a1" },
  { id: "eye", label: "👁️ Eye/Fundus", color: "#15803d" },
  { id: "other", label: "📄 Other", color: "#64748b" },
];

export const fDate = (d) => {
  try {
    const s = String(d || "");
    const dt = s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s);
    return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch (e) {
    return "";
  }
};
