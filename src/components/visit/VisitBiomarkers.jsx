import { memo, useMemo } from "react";
import { BiomarkerCard, getLabVal, getLabHist, fmtDate } from "./helpers";

const VisitBiomarkers = memo(function VisitBiomarkers({
  labResults,
  labHistory,
  vitals,
  flags,
  onOpenAI,
  onAddLab,
}) {
  const today = new Date().toISOString().split("T")[0];
  const latestV = vitals?.[0];
  const prevV = vitals?.[1];

  // Memoize lab lookups
  const markers = useMemo(() => {
    const hba1cH = getLabHist(labHistory, "HbA1c");
    const hba1cFirst = hba1cH.length > 0 ? hba1cH[0] : null;
    const hba1c = getLabVal(labResults, "HbA1c");
    const fbs = getLabVal(labResults, "FBS");
    const fbsH = getLabHist(labHistory, "FBS");
    const ldl = getLabVal(labResults, "LDL");
    const ldlH = getLabHist(labHistory, "LDL");
    const tsh = getLabVal(labResults, "TSH");
    const tshH = getLabHist(labHistory, "TSH");
    const tg = getLabVal(labResults, "TG");
    const tgH = getLabHist(labHistory, "TG");
    const cr = getLabVal(labResults, "Creatinine");
    const crH = getLabHist(labHistory, "Creatinine");
    const egfr = getLabVal(labResults, "eGFR");
    const hb = getLabVal(labResults, "Haemoglobin");
    const hbH = getLabHist(labHistory, "Haemoglobin");

    // Weight history as objects with date so sparkline can show dates
    const weightH =
      vitals
        ?.map((v) => (v.weight ? { result: v.weight, date: v.recorded_at } : null))
        .filter(Boolean)
        .reverse() || [];

    return {
      hba1c,
      hba1cH,
      hba1cFirst,
      fbs,
      fbsH,
      ldl,
      ldlH,
      tsh,
      tshH,
      tg,
      tgH,
      cr,
      crH,
      egfr,
      hb,
      hbH,
      weightH,
    };
  }, [labResults, labHistory, vitals]);

  const {
    hba1c,
    hba1cH,
    hba1cFirst,
    fbs,
    fbsH,
    ldl,
    ldlH,
    tsh,
    tshH,
    tg,
    tgH,
    cr,
    crH,
    egfr,
    hb,
    hbH,
    weightH,
  } = markers;

  return (
    <div className="sc" id="biomarkers">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-b">📊</div>Biomarkers &amp; Lab Values
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 500 }}>
            Updated: {fmtDate(today)}
          </span>
          <button className="bx bx-p" onClick={onAddLab}>+ Add Value</button>
        </div>
      </div>
      <div className="scb">
        <div className="subsec">Diabetes Markers</div>
        <div className="bmg">
          <BiomarkerCard
            label="HbA1c"
            value={hba1c?.result}
            unit="%"
            trend={
              hba1cFirst
                ? `${hba1c?.result < hba1cFirst.result ? "▼" : "▲"} From ${hba1cFirst.result}%`
                : null
            }
            trendDir={hba1c?.result <= 7 ? "good" : hba1c?.result <= 8 ? "warn" : "bad"}
            goal="<7.0%"
            history={hba1cH}
          />
          <BiomarkerCard
            label="Fasting Blood Sugar"
            value={fbs?.result}
            unit="mg/dL"
            trend={
              fbsH.length > 1
                ? `${fbs?.result < fbsH[0]?.result ? "▼" : "▲"} From ${fbsH[0]?.result}`
                : null
            }
            trendDir={fbs?.result <= 100 ? "good" : fbs?.result <= 126 ? "warn" : "bad"}
            goal="<100"
            history={fbsH}
          />
          <BiomarkerCard
            label="LDL Cholesterol"
            value={ldl?.result}
            unit="mg/dL"
            trend={ldl?.result <= 70 ? "✓ At goal" : "→ Above target"}
            trendDir={ldl?.result <= 70 ? "good" : "warn"}
            goal="<70"
            history={ldlH}
          />
          <BiomarkerCard
            label="TSH (Thyroid)"
            value={tsh?.result}
            unit="µIU/mL"
            trend={tsh?.result > 4.5 ? "↑ Elevated" : "✓ Normal"}
            trendDir={tsh?.result > 4.5 ? "bad" : "good"}
            goal="<4.5"
            history={tshH}
          />
        </div>

        <div className="subsec" style={{ marginTop: 4 }}>
          Lipids / Kidney / Body
        </div>
        <div className="bmg">
          <BiomarkerCard
            label="Triglycerides"
            value={tg?.result}
            unit="mg/dL"
            trend={tg?.result > 150 ? "→ Borderline" : "✓ Normal"}
            trendDir={tg?.result > 150 ? "warn" : "good"}
            goal="<150"
            history={tgH}
          />
          <BiomarkerCard
            label="Creatinine / eGFR"
            value={cr?.result}
            unit="mg/dL"
            trend={egfr ? `eGFR ${egfr.result}` : cr?.result <= 1.2 ? "✓ Normal" : "↑ Review"}
            trendDir={cr?.result <= 1.2 ? "good" : "bad"}
            goal="<1.2"
            goalLabel="Normal"
            history={crH}
          />
          <BiomarkerCard
            label="Haemoglobin"
            value={hb?.result}
            unit="g/dL"
            trend={hb?.result < 13 ? "→ Borderline low" : "✓ Normal"}
            trendDir={hb?.result < 13 ? "warn" : "good"}
            goal="13–17"
            goalLabel="Normal"
            history={hbH}
          />
          {latestV?.weight && (
            <BiomarkerCard
              label="Weight"
              value={latestV.weight}
              unit="kg"
              trend={
                prevV?.weight
                  ? `${latestV.weight > prevV.weight ? "↑" : "▼"} ${Math.abs(latestV.weight - prevV.weight).toFixed(1)} kg change`
                  : null
              }
              trendDir={prevV?.weight && latestV.weight > prevV.weight ? "warn" : "good"}
              goal="<90 kg"
              goalLabel="Target"
              history={weightH}
            />
          )}
        </div>

        {flags.length > 0 && (
          <div className="noticebar amb">
            <span>⚠️</span>
            <span className="ni amb">
              {flags.map((f) => f.text).join(". ")}.{" "}
              <a
                href="#"
                style={{ fontWeight: 700, color: "var(--amber)" }}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenAI();
                }}
              >
                Ask Gini AI →
              </a>
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

export default VisitBiomarkers;
