// ── Data mapping helpers — HealthRay → Gini Scribe ──────────────────────────

export function calcAge(birthDateStr) {
  if (!birthDateStr) return null;
  const [dd, mm, yyyy] = birthDateStr.split("-").map(Number);
  if (!dd || !mm || !yyyy) return null;
  const born = new Date(yyyy, mm - 1, dd);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  if (
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())
  ) {
    age--;
  }
  return age > 0 ? age : null;
}

export function buildName(fm) {
  if (!fm) return "Unknown";
  const parts = [fm.first_name, fm.middle_name, fm.last_name].filter(
    (p) => p && p !== "None" && p !== "." && p !== null,
  );
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "Unknown";
  return joined.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function mapGender(gender) {
  if (!gender) return null;
  const g = gender.toLowerCase();
  if (g === "male") return "Male";
  if (g === "female") return "Female";
  return "Other";
}

export function mapVisitType(reason) {
  if (!reason) return "OPD";
  const r = reason.toLowerCase();
  if (r.includes("follow")) return "Follow-Up";
  if (r.includes("new") || r.includes("first")) return "New Patient";
  if (r.includes("online") || r.includes("tele")) return "Tele";
  return "OPD";
}

// HealthRay status → our appointments.status
//   Checkout / Completed → completed (prescription printed; doctor finished)
//   Engaged              → in_visit (doctor is currently seeing the patient)
//   Waiting              → checkedin (patient has arrived and is waiting)
//   Cancelled / NoShow   → cancelled / no_show
//   Anything else        → scheduled
export function mapStatus(rayStatus) {
  if (!rayStatus) return "scheduled";
  const s = rayStatus.toLowerCase();
  if (s === "checkout" || s === "completed") return "completed";
  if (s === "engaged" || s === "in_visit" || s === "in-progress") return "in_visit";
  if (s === "waiting") return "checkedin";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "no_show" || s === "noshow") return "no_show";
  return "scheduled";
}

export function extractTimeSlot(appDateTime) {
  if (!appDateTime) return null;
  const d = new Date(appDateTime);
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours().toString().padStart(2, "0");
  const m = ist.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function toISTDate(dateStr) {
  if (!dateStr) return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
  const d = new Date(dateStr);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split("T")[0];
}

// ── Map HealthRay record type → our frontend doc_type ───────────────────────
export function mapRecordType(recordType, fileName) {
  const rt = (recordType || "").toLowerCase();
  const fn = (fileName || "").toLowerCase();

  if (rt.includes("prescription") || rt.includes("rx")) return "prescription";
  if (rt.includes("lab report")) return "blood";
  if (rt.includes("x-ray") || rt.includes("xray")) return "xray";

  if (fn.includes("ecg")) return "ecg";
  if (fn.includes("echo")) return "echo";
  if (fn.includes("mri")) return "mri";
  if (fn.includes("ultrasound") || fn.includes("usg")) return "ultrasound";
  if (fn.includes("abi")) return "abi";
  if (fn.includes("vpt")) return "vpt";
  if (fn.includes("blood") || fn.includes("lab") || fn.includes("report")) return "blood";

  return "other";
}

// ── Map AI-parsed labs → biomarker keys for Labs tab ────────────────────────
const LAB_KEY_MAP = [
  ["hba1c", ["hba1c", "hb a1c", "hba1"]],
  ["fg", ["fbg", "fasting glucose", "fasting blood glucose", "fbs", "fasting sugar"]],
  ["ldl", ["ldl"]],
  ["tg", ["triglycerides", "tg"]],
  ["uacr", ["uacr", "urine acr", "urine albumin creatinine", "albumin creatinine ratio"]],
  ["creatinine", ["creatinine", "creat"]],
  ["tsh", ["tsh"]],
  ["hb", ["hemoglobin", "haemoglobin"]],
  ["bpSys", ["bp systolic"]],
  ["bpDia", ["bp diastolic"]],
];

export function mapLabsToBiomarkers(labs, biomarkers) {
  for (const lab of labs) {
    const testLower = (lab.test || "").toLowerCase().trim();
    for (const [bioKey, aliases] of LAB_KEY_MAP) {
      const matched = aliases.some((a) => {
        if (testLower === a) return true;
        if (a.length <= 3) return testLower === a;
        return testLower.includes(a);
      });
      if (matched && lab.value) {
        const val = parseFloat(lab.value);
        if (!isNaN(val)) biomarkers[bioKey] = val;
        break;
      }
    }
  }
}

// ── Build compliance JSONB from parsed clinical data ────────────────────────
export function buildCompliance(parsedClinical, healthrayMedications, healthrayAdvice) {
  const compliance = {};

  if (healthrayMedications.length > 0) {
    compliance.notes = healthrayMedications
      .map((m, i) => {
        const parts = [`${i + 1}. ${m.name}`];
        if (m.dose) parts.push(m.dose);
        if (m.frequency) parts.push(m.frequency);
        if (m.timing) parts.push(m.timing);
        if (m.is_new) parts.push("(NEW)");
        return parts.join(" — ");
      })
      .join("\n");
  }

  // Stopped/changed medications
  const prevMeds = parsedClinical?.previous_medications || [];
  if (prevMeds.length > 0) {
    compliance.missed = prevMeds
      .map((m) => {
        const parts = [m.name];
        if (m.dose) parts.push(m.dose);
        if (m.status) parts.push(`[${m.status}]`);
        if (m.reason) parts.push(`— ${m.reason}`);
        return parts.join(" ");
      })
      .join(", ");
  }

  // Lifestyle
  const lifestyle = parsedClinical?.lifestyle || {};
  if (lifestyle.diet) compliance.diet = lifestyle.diet;
  else if (healthrayAdvice) compliance.diet = healthrayAdvice;
  if (lifestyle.exercise) compliance.exercise = lifestyle.exercise;

  // Stress: combine stress level + smoking/alcohol into one field
  const stressParts = [];
  if (lifestyle.stress) stressParts.push(lifestyle.stress);
  if (lifestyle.smoking) stressParts.push(`Smoking: ${lifestyle.smoking}`);
  if (lifestyle.alcohol) stressParts.push(`Alcohol: ${lifestyle.alcohol}`);
  if (stressParts.length > 0) compliance.stress = stressParts.join(" | ");

  // Symptoms for OPD coordinator prep
  const parsedSymptoms = parsedClinical?.symptoms || [];
  if (parsedSymptoms.length > 0) {
    compliance.symptoms = parsedSymptoms.map((s) => s.name);
  }

  return compliance;
}
