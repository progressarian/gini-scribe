import { allergyKnown } from "./giniflowAllergy.js";

export const HISTORY_TEXT_FIELDS = [
  { id: "complaints", label: "C/O (chief complaints)", printLabel: "C/O" },
  { id: "past_medical", label: "Past medical history", printLabel: "Past medical" },
  { id: "past_surgical", label: "Past surgical history", printLabel: "Past surgical" },
  { id: "family", label: "Family history", printLabel: "Family" },
  { id: "smoking", label: "Smoking", printLabel: "Smoking" },
  { id: "alcohol", label: "Alcohol", printLabel: "Alcohol" },
  { id: "previous_medications", label: "Previous medications", printLabel: "Previous medications" },
];

export const HISTORY_YES_NO_FIELDS = [
  { id: "covid", label: "COVID", printLabel: "COVID" },
  {
    id: "covid_vaccination",
    label: "COVID vaccination",
    printLabel: "COVID vaccination",
    showsWhen: { field: "covid", answer: "yes" },
  },
];

export const historyFieldApplies = (field, history = {}) =>
  !field.showsWhen || history[field.showsWhen.field]?.answer === field.showsWhen.answer;

export function withoutHiddenHistory(history = {}) {
  const out = { ...history };
  for (const f of HISTORY_YES_NO_FIELDS) if (!historyFieldApplies(f, out)) delete out[f.id];
  return out;
}

export const YES_NO = ["yes", "no"];

export const EXAM_FINDING_STATES = [
  { id: "normal", label: "Normal" },
  { id: "present", label: "Present" },
];

export const ACANTHOSIS_GRADES = ["0", "1", "2", "3", "4"];

export const JVP_VALUES = [
  { id: "not_raised", label: "Not raised" },
  { id: "raised", label: "Raised" },
];

const finding = (id, label) => ({ id, label, kind: "finding" });

export const EXAM_REGIONS = [
  {
    id: "head_neck",
    label: "Head & Neck",
    items: [
      finding("androgenic_alopecia", "Androgenic alopecia"),
      finding("frontotemporal_recession", "Frontotemporal recession"),
      finding("xanthelasma", "Xanthelasma"),
      finding("xanthoma", "Xanthoma"),
      finding("madarosis", "Madarosis"),
      finding("pallor", "Pallor"),
      finding("icterus", "Icterus"),
      finding("arcus", "Arcus"),
      finding("dental_hygiene", "Dental hygiene"),
      finding("double_chin", "Double chin"),
      { id: "acanthosis", label: "Acanthosis", kind: "grade" },
      finding("skin_tags", "Skin tags"),
      finding("bl_carotids", "B/L carotids"),
      { id: "jvp", label: "JVP", kind: "jvp" },
      finding("lymphadenopathy", "Lymphadenopathy"),
      finding("abnormal_mass", "Abnormal mass / growth"),
      finding("ear_lobule_crease", "Ear lobule crease"),
    ],
  },
  {
    id: "upper_limbs",
    label: "Upper limbs",
    items: [
      finding("dupuytren", "Dupuytren's contracture"),
      finding("nails", "Nails"),
      finding("lipoma", "Lipoma"),
      finding("neurofibroma", "Neurofibroma"),
      finding("cysts", "Cysts"),
      finding("pulse", "Pulse"),
    ],
  },
  {
    id: "chest_abdomen",
    label: "Chest & Abdomen",
    items: [
      finding("gynaecomastia", "Gynaecomastia"),
      finding("spleen", "Spleen"),
      finding("rectus_divarication", "Rectus divarication"),
      finding("fatty_liver", "Fatty liver"),
      finding("hernia", "Hernia"),
    ],
  },
  {
    id: "neck_back",
    label: "Neck & Back",
    items: [
      { id: "acanthosis", label: "Acanthosis", kind: "grade" },
      finding("skin_tags", "Skin tags"),
      finding("goitre", "Goitre"),
    ],
  },
  {
    id: "lower_limbs",
    label: "Lower limbs",
    items: [
      finding("pedal_edema", "Pedal edema"),
      finding("pedal_pulses", "Pedal pulses"),
      finding("nails", "Nails"),
      finding("arch_of_foot", "Arch of foot"),
      finding("reflexes", "Reflexes"),
    ],
  },
];

export const WORKUP_TEXT_MAX = 2000;
export const WORKUP_NOTE_MAX = 300;

const isAbnormal = (item, entry) => {
  if (!entry) return false;
  if (item.kind === "grade") return entry.value != null && entry.value !== "0";
  if (item.kind === "jvp") return entry.value === "raised";
  return entry.state === "present";
};

const isExamined = (item, entry) => {
  if (!entry) return false;
  if (item.kind === "finding") return EXAM_FINDING_STATES.some((s) => s.id === entry.state);
  return entry.value != null && entry.value !== "";
};

const describe = (item, entry) => {
  const note = String(entry.note || "").trim();
  let text = item.label;
  if (item.kind === "grade") text = `${item.label} gr ${entry.value}`;
  if (item.kind === "jvp") text = `JVP ${entry.value === "raised" ? "raised" : "not raised"}`;
  return note ? `${text} (${note})` : text;
};

export function summariseExam(exam = {}) {
  const lines = [];
  let examined = 0;
  let normal = 0;
  for (const region of EXAM_REGIONS) {
    const regionExam = exam[region.id] || {};
    const shown = [];
    for (const item of region.items) {
      const entry = regionExam[item.id];
      if (!isExamined(item, entry)) continue;
      examined += 1;
      if (isAbnormal(item, entry) || item.kind !== "finding") shown.push(describe(item, entry));
      else normal += 1;
    }
    if (shown.length) lines.push({ region: region.label, findings: shown });
  }
  return { lines, examined, restNormal: normal > 0 };
}

export function countRegion(region, regionExam = {}) {
  let abnormal = 0;
  let normal = 0;
  for (const item of region.items) {
    const entry = regionExam[item.id];
    if (!isExamined(item, entry)) continue;
    if (isAbnormal(item, entry)) abnormal += 1;
    else normal += 1;
  }
  return { abnormal, normal };
}

const HISTORY_PRINT_ORDER = [
  "complaints",
  "past_medical",
  "past_surgical",
  "family",
  "covid",
  "covid_vaccination",
  "smoking",
  "alcohol",
  "allergies",
  "previous_medications",
];

const textOf = (value) => String(value ?? "").trim();

const yesNoText = (entry) => {
  const answer = YES_NO.includes(entry?.answer) ? (entry.answer === "yes" ? "Yes" : "No") : "";
  return [answer, textOf(entry?.note)].filter(Boolean).join(" — ");
};

const allergyText = (allergy) => {
  if (allergyKnown(allergy)) return `Known — ${textOf(allergy.allergy_note) || "not named"}`;
  if (allergy?.allergy_status === "none_known") return "None known";
  return "Not asked";
};

export function summariseHistory(history = {}, allergy = null) {
  const fields = [...HISTORY_TEXT_FIELDS, ...HISTORY_YES_NO_FIELDS];
  const lines = [];
  for (const id of HISTORY_PRINT_ORDER) {
    if (id === "allergies") {
      lines.push({ label: "Allergies", value: allergyText(allergy) });
      continue;
    }
    const field = fields.find((f) => f.id === id);
    const isYesNo = HISTORY_YES_NO_FIELDS.includes(field);
    if (isYesNo && !historyFieldApplies(field, history)) continue;
    const value = isYesNo ? yesNoText(history[id]) : textOf(history[id]);
    if (value) lines.push({ label: field.printLabel, value });
  }
  return lines;
}
