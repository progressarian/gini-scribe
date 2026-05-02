import { memo, useMemo } from "react";
import {
  BiomarkerCard,
  getLabVal,
  getLabValFromLatest,
  getLabHist,
  getMergedFbsHist,
  fmtDate,
  fmtDateShort,
  isSameDate,
} from "./helpers";
import ChangesPopover from "./ChangesPopover";

const VisitBiomarkers = memo(function VisitBiomarkers({
  labResults,
  labLatest,
  labHistory,
  vitals,
  activeDx,
  flags,
  onOpenAI,
  onAddLab,
  onEditLab,
}) {
  // The merged vitals array contains clinic rows (full panel) plus Genie app
  // self-logs that are sparse (BP-only, weight-only, rbs-only, etc.). Taking
  // vitals[0] would hide every other field whenever the most recent row is a
  // single-field app log. Coalesce field-wise instead: per field, pick the
  // most-recent non-null across all rows; prevV picks the second most-recent.
  const { latestV, prevV } = useMemo(() => {
    const rows = vitals || [];
    if (rows.length === 0) return { latestV: undefined, prevV: undefined };
    const FIELDS = [
      "bp_sys",
      "bp_dia",
      "pulse",
      "temp",
      "spo2",
      "weight",
      "height",
      "bmi",
      "rbs",
      "waist",
      "body_fat",
      "muscle_mass",
      "meal_type",
      "reading_time",
    ];
    const build = (depth) => {
      // Anchor to the truly latest row (clinic or app); the editor downstream
      // routes patient_app rows through PATCH /app-vitals so editing the
      // latest reading works regardless of source.
      const anchor = rows[0];
      const out = {
        id: anchor?.id,
        recorded_at: anchor?.recorded_at,
        consultation_id: anchor?.consultation_id,
        source: anchor?.source,
      };
      for (const f of FIELDS) {
        let hits = 0;
        out[f] = null;
        for (const r of rows) {
          if (r && r[f] != null && r[f] !== "") {
            if (hits === depth) {
              out[f] = r[f];
              break;
            }
            hits += 1;
          }
        }
      }
      return out;
    };
    return { latestV: build(0), prevV: build(1) };
  }, [vitals]);

  // Memoize lab lookups
  const markers = useMemo(() => {
    const hba1cH = getLabHist(labHistory, "HbA1c");
    const hba1cFirst = hba1cH.length > 0 ? hba1cH[0] : null;
    const hba1c = getLabValFromLatest(labLatest, "HbA1c");
    const fbsLab = getLabValFromLatest(labLatest, "FBS");
    // Merged FBS stream (lab_results + patient fasting finger-sticks) lives
    // in helpers.jsx so the sidebar's "Latest FBS" pill cannot drift from
    // this trend card.
    const fbsH = getMergedFbsHist(labHistory, vitals);
    const fbs = fbsH.length > 0 ? fbsH[fbsH.length - 1] : fbsLab;
    const ldl = getLabValFromLatest(labLatest, "LDL");
    const ldlH = getLabHist(labHistory, "LDL");
    const tsh = getLabValFromLatest(labLatest, "TSH");
    const tshH = getLabHist(labHistory, "TSH");
    const tg = getLabValFromLatest(labLatest, "TG");
    const tgH = getLabHist(labHistory, "TG");
    const cr = getLabValFromLatest(labLatest, "Creatinine");
    const crH = getLabHist(labHistory, "Creatinine");
    const egfr = getLabValFromLatest(labLatest, "eGFR");
    const egfrH = getLabHist(labHistory, "eGFR");
    const hb = getLabValFromLatest(labLatest, "Haemoglobin");
    const hbH = getLabHist(labHistory, "Haemoglobin");
    const insulin = getLabValFromLatest(labLatest, "Insulin");
    const fbsForHoma = getLabValFromLatest(labLatest, "FBS");
    const homaIrLab = getLabValFromLatest(labLatest, "HOMA-IR");
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
    const weightLab = getLabValFromLatest(labLatest, "Weight");
    const weightLabH = getLabHist(labHistory, "Weight");
    const vitalWeightH = vitalHist("weight");
    const weightH = vitalWeightH.length > 0 ? vitalWeightH : weightLabH;

    // Waist: prefer vitals table, fall back to lab_results
    const waistLab = getLabValFromLatest(labLatest, "Waist");
    const vitalWaistH = vitalHist("waist");

    // UACR — from lab results
    const uacr = getLabValFromLatest(labLatest, "UACR");
    const uacrH = getLabHist(labHistory, "UACR");

    // BMI & Muscle Mass — from vitals table
    const bmiH = vitalHist("bmi");
    const muscleMassH = vitalHist("muscle_mass");

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
      egfrH,
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
      uacr,
      uacrH,
      bmiH,
      muscleMassH,
      bpH,
      pulseH: vitalHist("pulse"),
    };
  }, [labLatest, labHistory, vitals]);

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
    egfrH,
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
    uacr,
    uacrH,
    bmiH,
    muscleMassH,
    bpH,
    pulseH,
  } = markers;

  // ── Severity helpers ──────────────────────────────────────────────
  // Maps a numeric value against a per-marker rule into a severity ordinal:
  //   2 = bad / out-of-range, 1 = warn / borderline, 0 = good / at-target,
  //  -1 = no data (so it sorts last).
  // Mirrors the trendDir thresholds already used per BiomarkerCard below so
  // section ordering and the cards' own colours stay in lock-step.
  const sev = (label, ...args) => {
    const num = (x) => (x == null || x === "" ? NaN : Number(x));
    const v = num(args[0]);
    if (Number.isNaN(v)) return -1;
    switch (label) {
      case "HbA1c":
        return v <= 7 ? 0 : v <= 8 ? 1 : 2;
      case "FBS":
        return v <= 100 ? 0 : v <= 126 ? 1 : 2;
      case "LDL":
        return v <= 70 ? 0 : v <= 130 ? 1 : 2;
      case "TG":
        return v <= 150 ? 0 : v <= 200 ? 1 : 2;
      case "TSH":
        return v >= 0.5 && v <= 4.5 ? 0 : v <= 6 || v < 0.5 ? 1 : 2;
      case "eGFR":
        return v >= 90 ? 0 : v >= 60 ? 1 : 2;
      case "Creatinine":
        return v <= 1.2 ? 0 : v <= 1.5 ? 1 : 2;
      case "UACR":
        return v < 30 ? 0 : v < 300 ? 1 : 2;
      case "BP": {
        const dia = num(args[1]);
        if (Number.isNaN(dia)) return -1;
        if (v < 140 && dia < 90) return 0;
        if (v < 160 && dia < 100) return 1;
        return 2;
      }
      case "Hb":
        return v >= 13 ? 0 : v >= 10 ? 1 : 2;
      case "BMI":
        return v >= 18.5 && v < 25 ? 0 : v >= 25 && v < 30 ? 1 : v < 18.5 || v >= 30 ? 2 : 0;
      case "BodyFat":
        return v < 25 ? 0 : v < 30 ? 1 : 2;
      case "Waist":
        return v < 90 ? 0 : v < 102 ? 1 : 2;
      case "HOMA":
        return v < 2.5 ? 0 : v < 4 ? 1 : 2;
      default:
        return -1;
    }
  };

  // Aggregate severity of a section = highest individual marker severity.
  // Sections with no data fall back to -1 so they sink to the bottom.
  const sectionScore = (...sevs) => Math.max(-1, ...sevs.filter((s) => s != null));

  // ── Diagnosis-relevance boost ───────────────────────────────────
  // Doctors triage by "what does this patient have, and what looks bad for
  // those conditions". We tag each clinical section with the diagnoses it
  // tracks; if the patient has a matching active diagnosis, we add a small
  // boost (+2) to that section's score so it outranks a same-severity
  // section the patient doesn't have a condition for.
  //
  // The match is keyword-based against diagnosis_id + label so we don't
  // depend on a fixed coding system — works for ICD-10, snomed, free-text,
  // or healthray IDs alike. Only diagnoses that are still active count
  // (resolved conditions stop driving order).
  const diagnosisBoost = useMemo(() => {
    const SECTION_KEYWORDS = {
      diabetes: ["diabetes", "dm1", "dm2", "t1dm", "t2dm", "prediabetes", "hyperglycemia"],
      vitals: ["hypertension", "htn", "hypertensive", "cad", "coronary", "ihd", "cvd", "cva"],
      renal: ["ckd", "kidney", "renal", "nephropathy", "nephritis", "uacr", "albuminuria"],
      lipids: ["dyslipid", "hyperlipid", "cholesterol", "lipid", "atherosclero"],
      thyroid: ["thyroid", "hypothyroid", "hyperthyroid", "hashimoto", "graves", "goiter"],
      body: [
        "obesity",
        "obese",
        "overweight",
        "adiposity",
        "nafld",
        "masld",
        "fatty liver",
        "metabolic syndrome",
        "sarcopen",
      ],
    };
    const dxText = (activeDx || [])
      .filter((d) => d && d.is_active !== false)
      .map((d) => `${d.diagnosis_id || ""} ${d.label || ""}`.toLowerCase())
      .join(" | ");
    const out = {};
    for (const [section, words] of Object.entries(SECTION_KEYWORDS)) {
      out[section] = words.some((w) => dxText.includes(w)) ? 2 : 0;
    }
    return out;
  }, [activeDx]);

  const biomarkerSummary = useMemo(() => {
    if (!labLatest) return null;
    const entries = [];
    for (const [testName, v] of Object.entries(labLatest)) {
      if (v?.date)
        entries.push({
          name: testName,
          date: v.date,
          result: v.result,
          unit: v.unit,
          flag: v.flag,
        });
    }
    if (!entries.length) return null;

    entries.sort((a, b) => (b.date > a.date ? 1 : -1));
    const latestDate = entries[0].date;

    const updatedTests = entries
      .filter((e) => isSameDate(e.date, latestDate))
      .map((e) => {
        const hist = labHistory?.[e.name] || [];
        const prev = hist.find((h) => !isSameDate(h.date, latestDate));
        return { ...e, prev: prev?.result ?? null };
      })
      // Worst-first: bad markers surface ahead of warn / good in the popover
      // so the doctor reads the most critical change before the rest.
      .sort((a, b) => sev(b.name, b.result) - sev(a.name, a.result));

    const fmtChange = (e) => {
      if (e.prev != null && String(e.prev) !== String(e.result)) {
        const a = parseFloat(e.result);
        const b = parseFloat(e.prev);
        const arrow = !isNaN(a) && !isNaN(b) ? (a < b ? " ↓" : a > b ? " ↑" : "") : "";
        return `${e.name} ${e.prev}→${e.result}${arrow}`;
      }
      return `${e.name} ${e.result}`;
    };

    let text;
    if (updatedTests.length <= 2) {
      text = updatedTests.map(fmtChange).join(", ");
    } else {
      text =
        updatedTests.slice(0, 2).map(fmtChange).join(", ") + ` +${updatedTests.length - 2} more`;
    }

    const added = updatedTests
      .filter((e) => e.prev == null)
      .map((e) => ({
        name: e.name,
        diff: [`${e.result}${e.unit ? " " + e.unit : ""}`],
      }));
    const changed = updatedTests
      .filter((e) => e.prev != null && String(e.prev) !== String(e.result))
      .map((e) => ({
        name: e.name,
        diff: [`${e.prev} → ${e.result}${e.unit ? " " + e.unit : ""}`],
      }));

    return { text, date: latestDate, added, changed };
  }, [labLatest, labHistory]);

  return (
    <div className="sc" id="biomarkers">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-b">📊</div>Biomarkers &amp; Lab Values
          {biomarkerSummary && (
            <ChangesPopover
              date={biomarkerSummary.date}
              label={`${biomarkerSummary.text} — ${fmtDateShort(biomarkerSummary.date)}`}
              added={biomarkerSummary.added}
              changed={biomarkerSummary.changed}
            />
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {onEditLab && (labResults || []).length > 0 && (
            <button
              className="bx"
              title="Edit the most recent lab result"
              onClick={() => {
                const latest = [...(labResults || [])]
                  .filter((r) => r && r.id)
                  .sort((a, b) => {
                    const ta = a.test_date ? new Date(a.test_date).getTime() : 0;
                    const tb = b.test_date ? new Date(b.test_date).getTime() : 0;
                    if (tb !== ta) return tb - ta;
                    return (b.id || 0) - (a.id || 0);
                  })[0];
                if (latest) onEditLab(latest);
              }}
            >
              ✎ Edit Latest
            </button>
          )}
          <button className="bx bx-p" onClick={onAddLab}>
            + Add Value
          </button>
        </div>
      </div>
      <div className="scb">
        {(() => {
          // Build each clinical group as an entry { score, jsx }, then render
          // them sorted by severity (highest first) so the doctor sees the
          // most concerning panel at the top of the section without scrolling.
          const sections = [];

          // ── DIABETES MARKERS ──
          sections.push({
            key: "diabetes",
            score: sectionScore(
              sev("HbA1c", hba1c?.result),
              sev("FBS", fbs?.result),
              sev("HOMA", homaIr?.result),
            ),
            jsx: (
              <div key="diabetes">
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
              </div>
            ),
          });

          // ── VITAL SIGNS / CARDIOVASCULAR ──
          if (latestV?.bp_sys || latestV?.pulse) {
            sections.push({
              key: "vitals",
              score: sectionScore(
                latestV?.bp_sys && latestV?.bp_dia ? sev("BP", latestV.bp_sys, latestV.bp_dia) : -1,
              ),
              jsx: (
                <div key="vitals">
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
                </div>
              ),
            });
          }

          // ── KIDNEY / RENAL FUNCTION ──
          sections.push({
            key: "renal",
            score: sectionScore(
              sev("eGFR", egfr?.result),
              sev("Creatinine", cr?.result),
              sev("UACR", uacr?.result),
            ),
            jsx: (
              <div key="renal">
                <div className="subsec" style={{ marginTop: 4 }}>
                  Renal Function (RFT + UACR)
                </div>
                <div className="bmg">
                  {/* eGFR card — primary kidney biomarker, matches the patient app
              which logs and displays eGFR. Pulled from labLatest/labHistory
              so doctor-entered + patient-self-logged + Healthray-imported
              all roll into one trend (single lab_results stream). */}
                  <BiomarkerCard
                    label="eGFR (Kidney)"
                    value={egfr?.result}
                    unit="mL/min"
                    target={90}
                    lowerBetter={false}
                    trend={
                      egfrH.length > 1
                        ? `${egfr?.result > egfrH[egfrH.length - 2]?.result ? "▲" : "▼"} ${Math.abs(egfr?.result - egfrH[egfrH.length - 2]?.result).toFixed(0)} from ${fmtDate(egfrH[egfrH.length - 2]?.date)}`
                        : egfr?.result >= 90
                          ? "✓ Normal"
                          : egfr?.result >= 60
                            ? "→ Mildly reduced"
                            : "↑ Review"
                    }
                    trendDir={egfr?.result >= 90 ? "good" : egfr?.result >= 60 ? "warn" : "bad"}
                    goal="≥90"
                    goalLabel="Normal"
                    history={egfrH}
                  />
                  {/* Creatinine card — kept alongside eGFR for clinicians who track
              both. Hidden if no Creatinine data exists. */}
                  {cr?.result != null && (
                    <BiomarkerCard
                      label="Creatinine"
                      value={cr?.result}
                      unit="mg/dL"
                      target={1.2}
                      trend={
                        crH.length > 1
                          ? `${cr?.result < crH[crH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(cr?.result - crH[crH.length - 2]?.result).toFixed(2)} from ${fmtDate(crH[crH.length - 2]?.date)}`
                          : cr?.result <= 1.2
                            ? "✓ Normal"
                            : "↑ Review"
                      }
                      trendDir={cr?.result <= 1.2 ? "good" : "bad"}
                      goal="<1.2"
                      goalLabel="Normal"
                      history={crH}
                    />
                  )}
                  {uacr?.result != null && (
                    <BiomarkerCard
                      label="UACR"
                      value={uacr.result}
                      unit={uacr.unit || "mg/g"}
                      target={30}
                      trend={
                        uacrH.length > 1
                          ? `${uacr.result < uacrH[uacrH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(uacr.result - uacrH[uacrH.length - 2]?.result).toFixed(1)} from ${fmtDate(uacrH[uacrH.length - 2]?.date)}`
                          : uacr.result < 30
                            ? "✓ Normal"
                            : uacr.result < 300
                              ? "→ Microalbuminuria"
                              : "↑ Macroalbuminuria"
                      }
                      trendDir={uacr.result < 30 ? "good" : uacr.result < 300 ? "warn" : "bad"}
                      goal="<30"
                      goalLabel="Normal"
                      history={uacrH}
                    />
                  )}
                </div>
              </div>
            ),
          });

          // ── LIPIDS ──
          sections.push({
            key: "lipids",
            score: sectionScore(sev("LDL", ldl?.result), sev("TG", tg?.result)),
            jsx: (
              <div key="lipids">
                <div className="subsec" style={{ marginTop: 4 }}>
                  Lipid Profile
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
                </div>
              </div>
            ),
          });

          // ── THYROID ──
          sections.push({
            key: "thyroid",
            score: sectionScore(sev("TSH", tsh?.result)),
            jsx: (
              <div key="thyroid">
                <div className="subsec" style={{ marginTop: 4 }}>
                  Thyroid
                </div>
                <div className="bmg">
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
              </div>
            ),
          });

          // ── BODY COMPOSITION / HAEMATOLOGY ──
          sections.push({
            key: "body",
            score: sectionScore(
              sev("Hb", hb?.result),
              latestV?.body_fat ? sev("BodyFat", latestV.body_fat) : -1,
              latestV?.bmi ? sev("BMI", latestV.bmi) : -1,
              latestV?.waist || waistLab ? sev("Waist", latestV?.waist ?? waistLab?.result) : -1,
            ),
            jsx: (
              <div key="body">
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
                  {latestV?.bmi && (
                    <BiomarkerCard
                      label="BMI"
                      value={latestV.bmi}
                      unit="kg/m²"
                      trend={
                        bmiH.length > 1
                          ? `${latestV.bmi > bmiH[bmiH.length - 2]?.result ? "▲" : "▼"} ${Math.abs(latestV.bmi - bmiH[bmiH.length - 2]?.result).toFixed(1)} from ${fmtDate(bmiH[bmiH.length - 2]?.date)}`
                          : latestV.bmi >= 25
                            ? "→ Overweight"
                            : latestV.bmi < 18.5
                              ? "↓ Underweight"
                              : "✓ Normal"
                      }
                      trendDir={latestV.bmi >= 25 || latestV.bmi < 18.5 ? "warn" : "good"}
                      goal="18.5–24.9"
                      goalLabel="Normal"
                      history={bmiH}
                    />
                  )}
                  {latestV?.muscle_mass && (
                    <BiomarkerCard
                      label="Muscle Mass"
                      value={latestV.muscle_mass}
                      unit="kg"
                      lowerBetter={false}
                      trend={
                        muscleMassH.length > 1
                          ? `${latestV.muscle_mass < muscleMassH[muscleMassH.length - 2]?.result ? "▼" : "▲"} ${Math.abs(latestV.muscle_mass - muscleMassH[muscleMassH.length - 2]?.result).toFixed(1)} kg from ${fmtDate(muscleMassH[muscleMassH.length - 2]?.date)}`
                          : null
                      }
                      trendDir="good"
                      goalLabel="Track"
                      history={muscleMassH}
                    />
                  )}
                </div>
              </div>
            ),
          });

          // Final ranking: severity + diagnosis-relevance boost. The boost
          // only applies when the section has data of its own (score > -1)
          // so we never resurrect an empty panel just because the patient
          // carries a related diagnosis. Stable sort preserves the original
          // clinical order when totals tie.
          const ranked = sections
            .map((s, i) => {
              const boost = s.score > -1 ? diagnosisBoost[s.key] || 0 : 0;
              return { ...s, total: s.score + boost, idx: i };
            })
            .sort((a, b) => b.total - a.total || a.idx - b.idx);

          return ranked.map((s) => s.jsx);
        })()}

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
