import { memo, useMemo } from "react";
import { BiomarkerCard, getLabVal, getLabHist, fmtDate } from "./helpers";

const VisitBiomarkers = memo(function VisitBiomarkers({
  labResults,
  labHistory,
  vitals,
  flags,
  onOpenAI,
  onAddLab,
  onPasteBiomarkers,
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
    const insulin = getLabVal(labResults, "Insulin");
    const fbsForHoma = getLabVal(labResults, "FBS");
    const homaIrLab = getLabVal(labResults, "HOMA-IR");
    // Auto-calculate HOMA-IR = (Fasting Insulin × FBS) / 405 if not directly available
    const homaIrCalc =
      !homaIrLab && insulin?.result && fbsForHoma?.result
        ? { result: Math.round(((insulin.result * fbsForHoma.result) / 405) * 10) / 10, unit: "IR" }
        : null;
    const homaIr = homaIrLab || homaIrCalc;
    const homaIrH = getLabHist(labHistory, "HOMA-IR");

    // Vitals-based history (oldest-first for sparklines)
    const vitalHist = (key) =>
      (vitals || [])
        .map((v) => (v[key] ? { result: v[key], date: v.recorded_at } : null))
        .filter(Boolean)
        .reverse();

    // BP history as combined readings (e.g., "140/90")
    const bpH = (vitals || [])
      .filter((v) => v.bp_sys && v.bp_dia)
      .map((v) => ({
        result: parseFloat(v.bp_sys),
        dia: parseFloat(v.bp_dia),
        date: v.recorded_at,
        display: `${v.bp_sys}/${v.bp_dia}`,
      }))
      .reverse();

    // Weight: prefer vitals table, fall back to lab_results canonical_name='Weight'
    const weightLab = getLabVal(labResults, "Weight");
    const weightLabH = getLabHist(labHistory, "Weight");
    const vitalWeightH = vitalHist("weight");
    const weightH = vitalWeightH.length > 0 ? vitalWeightH : weightLabH;

    // Waist: prefer vitals table, fall back to lab_results
    const waistLab = getLabVal(labResults, "Waist");
    const vitalWaistH = vitalHist("waist");

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
      homaIr,
      homaIrH,
      homaIrCalc,
      weightLab,
      weightH,
      bodyFatH: vitalHist("body_fat"),
      waistLab,
      waistH: vitalWaistH.length > 0 ? vitalWaistH : getLabHist(labHistory, "Waist"),
      bpH,
      pulseH: vitalHist("pulse"),
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
    homaIr,
    homaIrH,
    homaIrCalc,
    weightLab,
    weightH,
    bodyFatH,
    waistLab,
    waistH,
    bpH,
    pulseH,
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
          <button
            className="bx"
            onClick={onPasteBiomarkers}
            title="Paste clinical text from HealthRay to extract biomarkers"
          >
            📋 Paste
          </button>
          <button className="bx bx-p" onClick={onAddLab}>
            + Add Value
          </button>
        </div>
      </div>
      <div className="scb">
        {/* ── DIABETES MARKERS ── */}
        <div className="subsec">Diabetes Markers</div>
        <div className="bmg">
          <BiomarkerCard
            label="HbA1c"
            value={hba1c?.result}
            unit="%"
            target={7}
            trend={
              hba1cH.length > 1
                ? `${hba1c?.result < hba1cH[hba1cH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(hba1c?.result - hba1cH[hba1cH.length - 2]?.result).toFixed(1)}% from ${fmtDate(hba1cH[hba1cH.length - 2]?.date)}`
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
            target={100}
            trend={
              fbsH.length > 1
                ? `${fbs?.result < fbsH[fbsH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(fbs?.result - fbsH[fbsH.length - 2]?.result).toFixed(0)} from ${fmtDate(fbsH[fbsH.length - 2]?.date)}`
                : null
            }
            trendDir={fbs?.result <= 100 ? "good" : fbs?.result <= 126 ? "warn" : "bad"}
            goal="<100"
            history={fbsH}
          />
          <BiomarkerCard
            label="No Hypoglycemia"
            value={fbs?.result < 70 ? "⚠ Low" : "✓ None"}
            unit=""
            valueColor={fbs?.result < 70 ? "var(--red)" : "#12b981"}
            trend={fbs?.result < 70 ? "Hypoglycemia detected" : "No GMI reported"}
            trendDir={fbs?.result < 70 ? "bad" : "good"}
            goal="Safe"
            goalLabel="Status"
            history={[]}
          />
          <BiomarkerCard
            label={homaIrCalc ? "HOMA-IR (calc.)" : "HOMA-IR"}
            value={homaIr?.result}
            unit="IR"
            trend={
              homaIr?.result > 2.5
                ? "↑ Insulin resistant"
                : homaIr?.result
                  ? "✓ Normal"
                  : "Add Fasting Insulin to calculate"
            }
            trendDir={homaIr?.result > 2.5 ? "bad" : homaIr?.result ? "good" : "ok"}
            goal="<2.5"
            goalLabel="Normal"
            history={homaIrH}
          />
        </div>

        {/* ── VITAL SIGNS / CARDIOVASCULAR ── */}
        {(latestV?.bp_sys || latestV?.pulse) && (
          <>
            <div className="subsec" style={{ marginTop: 4 }}>
              Vital Signs / Cardiovascular
            </div>
            <div className="bmg">
              {latestV?.bp_sys && latestV?.bp_dia && (
                <BiomarkerCard
                  label="Blood Pressure"
                  value={`${latestV.bp_sys}/${latestV.bp_dia}`}
                  unit="mmHg"
                  trend={
                    bpH.length > 1
                      ? `${latestV.bp_sys >= 140 || latestV.bp_dia >= 90 ? "↑ Elevated" : "✓ Normal"} from ${bpH[0]?.display}`
                      : latestV.bp_sys >= 140 || latestV.bp_dia >= 90
                        ? "↑ Elevated"
                        : "✓ Normal"
                  }
                  trendDir={latestV.bp_sys >= 140 || latestV.bp_dia >= 90 ? "bad" : "good"}
                  goal="<140/90"
                  goalLabel="Target"
                  history={bpH}
                />
              )}
              {latestV?.pulse && (
                <BiomarkerCard
                  label="Heart Rate"
                  value={latestV.pulse}
                  unit="bpm"
                  trend={
                    pulseH.length > 1
                      ? `${latestV.pulse > 90 ? "↑" : "✓"} From ${pulseH[0]?.result} bpm`
                      : null
                  }
                  trendDir={latestV.pulse > 90 ? "warn" : "good"}
                  goal="60–100"
                  goalLabel="Normal"
                  history={pulseH}
                />
              )}
            </div>
          </>
        )}

        {/* ── LIPIDS / KIDNEY / THYROID ── */}
        <div className="subsec" style={{ marginTop: 4 }}>
          Lipids / Kidney / Thyroid
        </div>
        <div className="bmg">
          <BiomarkerCard
            label="LDL Cholesterol"
            value={ldl?.result}
            unit="mg/dL"
            target={70}
            trend={
              ldlH.length > 1
                ? `${ldl?.result < ldlH[ldlH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(ldl?.result - ldlH[ldlH.length - 2]?.result).toFixed(0)} from ${fmtDate(ldlH[ldlH.length - 2]?.date)}`
                : ldl?.result <= 70
                  ? "✓ At goal"
                  : "→ Above target"
            }
            trendDir={ldl?.result <= 70 ? "good" : "warn"}
            goal="<70"
            history={ldlH}
          />
          <BiomarkerCard
            label="Triglycerides"
            value={tg?.result}
            unit="mg/dL"
            target={150}
            trend={
              tgH.length > 1
                ? `${tg?.result < tgH[tgH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(tg?.result - tgH[tgH.length - 2]?.result).toFixed(0)} from ${fmtDate(tgH[tgH.length - 2]?.date)}`
                : tg?.result > 150
                  ? "→ Borderline"
                  : "✓ Normal"
            }
            trendDir={tg?.result > 150 ? "warn" : "good"}
            goal="<150"
            history={tgH}
          />
          <BiomarkerCard
            label="Creatinine / eGFR"
            value={cr?.result}
            unit="mg/dL"
            target={1.2}
            trend={
              crH.length > 1
                ? `${cr?.result < crH[crH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(cr?.result - crH[crH.length - 2]?.result).toFixed(2)} from ${fmtDate(crH[crH.length - 2]?.date)}`
                : egfr
                  ? `✓ eGFR ${egfr.result}`
                  : cr?.result <= 1.2
                    ? "✓ Normal"
                    : "↑ Review"
            }
            trendDir={cr?.result <= 1.2 ? "good" : "bad"}
            goal="<1.2"
            goalLabel="Normal"
            history={crH}
          />
          <BiomarkerCard
            label="TSH (Thyroid)"
            value={tsh?.result}
            unit="µIU/mL"
            target={4.5}
            trend={
              tshH.length > 1
                ? `${tsh?.result < tshH[tshH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(tsh?.result - tshH[tshH.length - 2]?.result).toFixed(2)} from ${fmtDate(tshH[tshH.length - 2]?.date)}`
                : tsh?.result > 4.5
                  ? "↑ Elevated (needs review)"
                  : "✓ Normal"
            }
            trendDir={tsh?.result > 4.5 ? "bad" : "good"}
            goal="<4.5"
            history={tshH}
          />
        </div>

        {/* ── BODY COMPOSITION / HAEMATOLOGY ── */}
        <div className="subsec" style={{ marginTop: 4 }}>
          Body Composition / Haematology
        </div>
        <div className="bmg">
          {(latestV?.weight || weightLab) &&
            (() => {
              const wVal = latestV?.weight ?? weightLab?.result;
              const wPrev = prevV?.weight ?? weightH?.[weightH.length - 2]?.result;
              const wPrevDate = prevV?.recorded_at ?? weightH?.[weightH.length - 2]?.date;
              return (
                <BiomarkerCard
                  label="Weight"
                  value={wVal}
                  unit="kg"
                  trend={
                    wPrev
                      ? `${wVal > wPrev ? "↑" : "▼"} ${Math.abs(wVal - wPrev).toFixed(1)} kg since ${fmtDate(wPrevDate)}`
                      : null
                  }
                  trendDir={wPrev && wVal > wPrev ? "warn" : "good"}
                  goal="<90 kg"
                  goalLabel="Target"
                  history={weightH}
                />
              );
            })()}
          {latestV?.body_fat && (
            <BiomarkerCard
              label="Body Fat %"
              value={latestV.body_fat}
              unit="%"
              trend={
                bodyFatH.length > 1
                  ? `${latestV.body_fat > bodyFatH[0]?.result ? "▲" : "▼"} From ${bodyFatH[0]?.result}%`
                  : null
              }
              trendDir={latestV.body_fat > 25 ? "warn" : "good"}
              goal="<25%"
              goalLabel="Target"
              history={bodyFatH}
            />
          )}
          <BiomarkerCard
            label="Haemoglobin"
            value={hb?.result}
            unit="g/dL"
            target={13}
            lowerBetter={false}
            trend={
              hbH.length > 1
                ? `${hb?.result < hbH[hbH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(hb?.result - hbH[hbH.length - 2]?.result).toFixed(1)} from ${fmtDate(hbH[hbH.length - 2]?.date)}`
                : hb?.result < 13
                  ? "→ Borderline low"
                  : "✓ Normal"
            }
            trendDir={hb?.result < 13 ? "warn" : "good"}
            goal="13–17"
            goalLabel="Normal"
            history={hbH}
          />
          {(latestV?.waist || waistLab) && (
            <BiomarkerCard
              label="Waist Circumference"
              value={latestV?.waist ?? waistLab?.result}
              unit="cm"
              trend={
                waistH.length > 1
                  ? `${(latestV?.waist ?? waistLab?.result) > waistH[waistH.length - 2]?.result ? "▲" : "▼"} ${Math.abs((latestV?.waist ?? waistLab?.result) - waistH[waistH.length - 2]?.result).toFixed(1)} cm from ${fmtDate(waistH[waistH.length - 2]?.date)}`
                  : null
              }
              trendDir={(latestV?.waist ?? waistLab?.result) > 90 ? "warn" : "good"}
              goal="<90 cm"
              goalLabel="Target"
              history={waistH}
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
