export const SPECIALTIES = [
  {
    name: "Endocrinology",
    aliases: [
      "endocrinology",
      "endocrinologist",
      "endocrine",
      "endo",
      "dm endo",
      "diabetology",
      "diabetologist",
    ],
  },
  { name: "Cardiology", aliases: ["cardiology", "cardiologist", "cardiac", "cardio", "heart"] },
  { name: "Nephrology", aliases: ["nephrology", "nephrologist", "nephro", "kidney", "renal"] },
  {
    name: "Ophthalmology",
    aliases: ["ophthalmology", "ophthalmologist", "ophthal", "eye", "retina", "retinal"],
  },
  { name: "Neurology", aliases: ["neurology", "neurologist", "neuro"] },
  {
    name: "Gastroenterology",
    aliases: [
      "gastroenterology",
      "gastroenterologist",
      "gastro",
      "hepatology",
      "hepatologist",
      "liver",
    ],
  },
  {
    name: "Orthopaedics",
    aliases: ["orthopaedics", "orthopedics", "orthopaedic", "orthopedic", "ortho", "bone", "joint"],
  },
  { name: "Dermatology", aliases: ["dermatology", "dermatologist", "derma", "skin"] },
  {
    name: "Gynaecology",
    aliases: [
      "gynaecology",
      "gynecology",
      "gynaecologist",
      "gynecologist",
      "gynae",
      "gyne",
      "obstetrics",
      "obg",
      "obgyn",
    ],
  },
  {
    name: "Psychiatry",
    aliases: ["psychiatry", "psychiatrist", "psychologist", "psychology", "mental health"],
  },
  {
    name: "Pulmonology",
    aliases: ["pulmonology", "pulmonologist", "pulmo", "chest", "respiratory"],
  },
  {
    name: "Dietetics",
    aliases: ["dietitian", "dietician", "dietetics", "diet", "nutritionist", "nutrition"],
  },
  { name: "Physiotherapy", aliases: ["physiotherapy", "physiotherapist", "physio"] },
  { name: "Podiatry", aliases: ["podiatry", "podiatrist", "diabetic foot", "foot care", "foot"] },
  { name: "ENT", aliases: ["ent", "otorhinolaryngology", "otolaryngology"] },
  { name: "Urology", aliases: ["urology", "urologist", "uro"] },
  { name: "Dental", aliases: ["dental", "dentist", "dentistry"] },
  { name: "Rheumatology", aliases: ["rheumatology", "rheumatologist", "rheumat"] },
  { name: "Oncology", aliases: ["oncology", "oncologist", "cancer"] },
  {
    name: "Paediatrics",
    aliases: ["paediatrics", "pediatrics", "paediatrician", "pediatrician", "child"],
  },
  { name: "Vascular Surgery", aliases: ["vascular surgery", "vascular surgeon", "vascular"] },
  {
    name: "General Surgery",
    aliases: ["general surgery", "general surgeon", "surgery", "surgeon"],
  },
  {
    name: "General Medicine",
    aliases: [
      "general medicine",
      "internal medicine",
      "physician",
      "medicine",
      "general physician",
    ],
  },
];

const words = (text) =>
  ` ${String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

const ALIASES = SPECIALTIES.flatMap((s) =>
  s.aliases.map((alias) => ({ alias, name: s.name })),
).sort((a, b) => b.alias.length - a.alias.length);

export function specialtyOf(text) {
  const said = words(text);
  if (said.trim() === "") return null;
  const hit = ALIASES.find(({ alias }) => said.includes(` ${alias} `));
  return hit ? hit.name : null;
}
