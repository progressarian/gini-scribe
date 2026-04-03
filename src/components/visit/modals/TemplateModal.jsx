import { memo, useCallback, useState } from "react";

const TEMPLATES = {
  insulin_titration: {
    title: "Insulin Titration Guide",
    emoji: "📌",
    content: [
      {
        heading: "Fasting Blood Sugar (FBS) Based Titration",
        items: [
          "FBS > 180 mg/dL → Increase dose by 4 units",
          "FBS 130–180 mg/dL → Increase dose by 2 units",
          "FBS 100–130 mg/dL → No change (maintain current dose)",
          "FBS 70–100 mg/dL → Decrease dose by 2 units",
          "FBS < 70 mg/dL → Decrease dose by 4 units & contact doctor",
        ],
      },
      {
        heading: "Important Instructions",
        items: [
          "Check your fasting sugar every morning before breakfast",
          "Adjust dose every 3 days based on above chart",
          "Always keep sugar/glucose tablets with you",
          "If sugar drops below 70 — eat 3 glucose tablets immediately",
          "Do not skip meals after taking insulin",
          "Store insulin in refrigerator (2–8°C), never freeze",
        ],
      },
      {
        heading: "When to Call Doctor",
        items: [
          "Blood sugar stays above 250 mg/dL for 2 days",
          "Blood sugar drops below 70 mg/dL more than once a week",
          "You feel dizzy, shaky, or confused",
          "You are unwell, vomiting, or unable to eat",
        ],
      },
      {
        heading: "Fasting Blood Sugar (FBS) Based Titration",
        items: [
          "FBS > 180 mg/dL → Increase dose by 4 units",
          "FBS 130–180 mg/dL → Increase dose by 2 units",
          "FBS 100–130 mg/dL → No change (maintain current dose)",
          "FBS 70–100 mg/dL → Decrease dose by 2 units",
          "FBS < 70 mg/dL → Decrease dose by 4 units & contact doctor",
        ],
      },
      {
        heading: "Important Instructions",
        items: [
          "Check your fasting sugar every morning before breakfast",
          "Adjust dose every 3 days based on above chart",
          "Always keep sugar/glucose tablets with you",
          "If sugar drops below 70 — eat 3 glucose tablets immediately",
          "Do not skip meals after taking insulin",
          "Store insulin in refrigerator (2–8°C), never freeze",
        ],
      },
      {
        heading: "When to Call Doctor",
        items: [
          "Blood sugar stays above 250 mg/dL for 2 days",
          "Blood sugar drops below 70 mg/dL more than once a week",
          "You feel dizzy, shaky, or confused",
          "You are unwell, vomiting, or unable to eat",
        ],
      },
    ],
  },
  diet_1000kcal: {
    title: "1000 kcal Diet Plan",
    emoji: "🥗",
    content: [
      {
        heading: "Early Morning (6:00–7:00 AM)",
        items: ["1 glass warm water with lemon (no sugar)", "5 soaked almonds + 1 walnut"],
      },
      {
        heading: "Breakfast (8:00–9:00 AM)",
        items: [
          "Option A: 1 moong dal cheela + mint chutney",
          "Option B: 1 besan cheela + 1/2 cup curd",
          "Option C: 1 egg white omelette (2 whites) + 1 multigrain roti",
        ],
      },
      {
        heading: "Mid-Morning (11:00 AM)",
        items: ["1 small fruit (apple/guava/pear) OR 1 cup buttermilk"],
      },
      {
        heading: "Lunch (1:00–2:00 PM)",
        items: [
          "1 small multigrain roti + 1 bowl dal + 1 bowl sabzi (non-starchy)",
          "1 small bowl salad (cucumber, tomato, onion)",
          "Avoid: rice, potato, arbi, white bread",
        ],
      },
      {
        heading: "Evening Snack (4:00–5:00 PM)",
        items: ["1 cup green tea (no sugar) + 1 small handful of roasted chana"],
      },
      {
        heading: "Dinner (7:00–8:00 PM)",
        items: [
          "1 bowl vegetable soup + 1 small multigrain roti + 1 bowl sabzi",
          "OR: 1 bowl dal khichdi with vegetables",
          "Finish dinner by 8 PM — no eating after dinner",
        ],
      },
      {
        heading: "General Rules",
        items: [
          "Drink 8–10 glasses of water daily",
          "No sugar, jaggery, honey, or sweetened drinks",
          "No fruit juices — eat whole fruits only",
          "Use only 2 teaspoons oil per day for cooking",
          "Walk 30 minutes after dinner",
        ],
      },
    ],
  },
  mounjaro_guide: {
    title: "Mounjaro (Tirzepatide) Injection Guide",
    emoji: "💉",
    content: [
      {
        heading: "How to Inject",
        items: [
          "Inject once weekly on the same day each week",
          "Inject in your stomach (abdomen), thigh, or upper arm",
          "Rotate injection site each week — do not inject in same spot",
          "Clean the area with alcohol swab before injecting",
          "Remove pen cap → Place flat on skin → Press and hold button → Count to 10 → Remove",
        ],
      },
      {
        heading: "Dose Schedule",
        items: [
          "Weeks 1–4: 2.5 mg (starting dose)",
          "Weeks 5–8: 5 mg",
          "Doctor may increase further based on response",
          "Never increase dose on your own",
        ],
      },
      {
        heading: "Storage",
        items: [
          "Store in refrigerator (2–8°C) before first use",
          "After first use, can keep at room temperature (up to 30°C) for 21 days",
          "Do not freeze. Do not use if frozen",
          "Protect from direct sunlight",
        ],
      },
      {
        heading: "Common Side Effects (Usually Temporary)",
        items: [
          "Nausea — eat smaller, more frequent meals",
          "Decreased appetite — this is expected and helps with weight loss",
          "Diarrhea or constipation — drink plenty of water",
          "Stomach pain — avoid spicy and fatty foods",
        ],
      },
      {
        heading: "When to Call Doctor",
        items: [
          "Severe stomach pain that does not go away",
          "Signs of low blood sugar (shaking, sweating, confusion)",
          "Allergic reaction (rash, swelling, difficulty breathing)",
          "Persistent vomiting for more than 24 hours",
        ],
      },
    ],
  },
  blood_sugar_log: {
    title: "Blood Sugar Log Sheet",
    emoji: "🩸",
    content: [
      {
        heading: "Instructions",
        items: [
          "Check blood sugar at the times marked by your doctor",
          "Write the reading in the correct column",
          "Bring this sheet to every doctor visit",
        ],
      },
      {
        heading: "When to Check",
        items: [
          "Fasting (before breakfast) — most important",
          "2 hours after lunch",
          "Before dinner (if advised)",
          "Bedtime (if advised)",
        ],
      },
      {
        heading: "Target Ranges",
        items: [
          "Fasting: 80–130 mg/dL",
          "2 hours after meal: Less than 180 mg/dL",
          "HbA1c target: Less than 7%",
        ],
      },
      {
        heading: "What to Record",
        items: [
          "Date and time of reading",
          "Blood sugar value (mg/dL)",
          "Meal details (what you ate before the reading)",
          "Any symptoms (dizziness, shakiness, blurred vision)",
          "Medications taken / missed",
        ],
      },
    ],
  },
  fasting_lab: {
    title: "Fasting Lab Instructions",
    emoji: "📋",
    content: [
      {
        heading: "Before the Test",
        items: [
          "Do not eat or drink anything (except plain water) for 10–12 hours",
          "Last meal should be by 8:00–9:00 PM the night before",
          "You may drink plain water — stay hydrated",
          "Do NOT drink tea, coffee, milk, or juice in the morning",
        ],
      },
      {
        heading: "Medications",
        items: [
          "Take your blood pressure and heart medicines as usual with water",
          "Do NOT take diabetes medicines or insulin before the test",
          "Bring your medicines with you — take them after blood is drawn",
        ],
      },
      {
        heading: "On the Day of Test",
        items: [
          "Come to the lab between 7:00–9:00 AM",
          "Wear loose sleeves for easy blood draw",
          "Carry your doctor's prescription / lab order",
          "Carry your previous reports if available",
        ],
      },
      {
        heading: "After the Test",
        items: [
          "Eat your breakfast and take your medicines",
          "Reports are usually ready in 24–48 hours",
          "Collect reports and bring them to your next doctor visit",
        ],
      },
    ],
  },
};

function buildTemplatePrintHTML(template, patient) {
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  let sectionsHTML = "";
  for (const section of template.content) {
    sectionsHTML += `<div style="margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;color:#1a2332;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #eef1f5">${section.heading}</div>
      <ul style="font-size:12px;color:#3d4f63;padding-left:20px;line-height:2;margin:0">
        ${section.items.map((item) => `<li>${item}</li>`).join("")}
      </ul>
    </div>`;
  }

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${template.title} — ${patient.name}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #1a2332; line-height: 1.5; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head><body>
<div style="max-width:700px;margin:0 auto">
  <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #009e8c;padding-bottom:12px;margin-bottom:16px">
    <div>
      <div style="font-size:22px;font-weight:700;color:#009e8c;letter-spacing:-.5px">Gini Health</div>
      <div style="font-size:11px;color:#6b7d90">${template.emoji} ${template.title}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:13px;font-weight:600">${patient.name}</div>
      <div style="font-size:11px;color:#6b7d90">${patient.age ? patient.age + "Y" : ""}${patient.sex ? " · " + patient.sex : ""}${patient.file_no ? " · ID #" + patient.file_no : ""}</div>
      <div style="font-size:10px;color:#6b7d90">Date: ${today}</div>
    </div>
  </div>
  ${sectionsHTML}
  <div style="margin-top:20px;padding:10px 14px;background:#e6f6f4;border-radius:8px;border:1px solid rgba(0,158,140,.22);font-size:12px;color:#009e8c;display:flex;align-items:center;gap:8px">
    <span>📞</span>
    <span>Koi problem ho? Gini Health se contact karein: +91 8146320100 (WhatsApp available)</span>
  </div>
</div>
</body></html>`;
}

function buildTemplateWhatsAppText(template) {
  const lines = [`*${template.emoji} ${template.title}*`];
  for (const section of template.content) {
    lines.push(`\n*${section.heading}*`);
    section.items.forEach((item) => lines.push(`• ${item}`));
  }
  lines.push(`\n— Gini Health\nContact: +91 8146320100`);
  return lines.join("\n");
}

const TEMPLATE_META = {
  insulin_titration: {
    dot: "#3b82f6",
    desc: "Dose adjustment rules based on fasting & post-meal blood sugar",
  },
  mounjaro_guide: {
    dot: "#8b5cf6",
    desc: "Injection sites, technique, weekly rotation, side effect management",
  },
  diet_1000kcal: { dot: "#22c55e", desc: "Meal plan with 60g protein, food list in Hindi/Punjabi" },
  blood_sugar_log: {
    dot: "#ef4444",
    desc: "Daily log sheet for fasting, post-meal and bedtime readings",
  },
  fasting_lab: { dot: "#f97316", desc: "Off meds 24h, nothing after 10 PM, sample 8–9 AM" },
};

const TemplateModal = memo(function TemplateModal({ templateKey, patient, onClose }) {
  // All hooks must come before any conditional return
  const [activeKey, setActiveKey] = useState(templateKey || null);

  const template = activeKey ? TEMPLATES[activeKey] : null;

  const handlePrint = useCallback(() => {
    if (!template) return;
    const html = buildTemplatePrintHTML(template, patient);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      win.focus();
      win.print();
    }, 300);
  }, [template, patient]);

  const handleWhatsApp = useCallback(() => {
    if (!template) return;
    const text = encodeURIComponent(buildTemplateWhatsAppText(template));
    const phone = (patient.phone || patient.mobile || "").replace(/\D/g, "");
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, "_blank");
  }, [template, patient]);

  // Picker view — no template selected yet
  if (!template) {
    return (
      <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="mbox" style={{ maxWidth: 480 }}>
          <div className="mttl">📋 Add Template</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "2px 0 10px" }}>
            {Object.entries(TEMPLATES).map(([key, tpl]) => {
              const meta = TEMPLATE_META[key] || {};
              return (
                <button
                  key={key}
                  onClick={() => setActiveKey(key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--rs)",
                    cursor: "pointer",
                    textAlign: "left",
                    width: "100%",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--primary)";
                    e.currentTarget.style.background = "var(--pri-lt)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.background = "var(--card)";
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: meta.dot || "var(--t3)",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                      {tpl.emoji} {tpl.title}
                    </div>
                    {meta.desc && (
                      <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>
                        {meta.desc}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="macts">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Detail view — specific template selected
  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ maxWidth: 600, maxHeight: "80vh", overflow: "auto" }}>
        <div className="mttl" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!templateKey && (
            <button
              className="btn"
              onClick={() => setActiveKey(null)}
              style={{ fontSize: 11, padding: "2px 10px" }}
            >
              ← Back
            </button>
          )}
          {template.emoji} {template.title}
        </div>
        {template.content.map((section, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "var(--text)",
                marginBottom: 4,
                paddingBottom: 4,
                borderBottom: "1px solid var(--border)",
              }}
            >
              {section.heading}
            </div>
            <ul
              style={{
                fontSize: 12,
                color: "var(--t2)",
                paddingLeft: 20,
                lineHeight: 1.9,
                margin: 0,
              }}
            >
              {section.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
        <div className="macts">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn" onClick={handleWhatsApp}>
            📱 Send via WhatsApp
          </button>
          <button className="btn-p" onClick={handlePrint}>
            🖨 Print
          </button>
        </div>
      </div>
    </div>
  );
});

export { TEMPLATES };
export default TemplateModal;
