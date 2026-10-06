export const MEDICINE_TYPES = [
  "CAP",
  "CHEWING GUMS",
  "CRM",
  "DISKETTE",
  "DROP(ext)",
  "DROP(oral)",
  "DRP",
  "ENEMA",
  "EXP",
  "FACE WASH",
  "GARGLE",
  "GEL",
  "GEN",
  "GRA",
  "INHAL.SOLU",
  "INHALER",
  "INJ",
  "INJ(insulin)",
  "INSULIN PEN",
  "IUD",
  "JELLY",
  "LIQ",
  "LOT",
  "LOZENGES",
  "NASAL SPRAY",
  "OIL",
  "OIN",
  "OTHER",
  "PATCH",
  "PELLETS",
  "PESSARY",
  "POW",
  "POW(ext)",
  "POW(oral)",
  "RESP SOLUTION",
  "RESPULES",
  "ROTACAP",
  "SAC",
  "SHAMPOO",
  "SOA",
  "SOL",
  "SPRAY",
  "STRIP",
  "SUPPOSITORY",
  "SURG. ITEM",
  "SUS",
  "SYP",
  "TAB",
  "TOOTHPASTE",
  "VACCINE",
  "VAG RING",
  "VAG.CAP",
  "VAG.TAB",
];

const FROM_FORM = {
  tablet: "TAB",
  capsule: "CAP",
  injection: "INJ",
  syrup: "SYP",
  suspension: "SUS",
  drops: "DRP",
  ointment: "OIN",
  cream: "CRM",
  gel: "GEL",
  lotion: "LOT",
  spray: "SPRAY",
  inhaler: "INHALER",
  sachet: "SAC",
  powder: "POW",
  patch: "PATCH",
  suppository: "SUPPOSITORY",
  pessary: "PESSARY",
};

const FROM_PREFIX = {
  tab: "TAB",
  tablet: "TAB",
  cap: "CAP",
  capsule: "CAP",
  inj: "INJ",
  injection: "INJ",
  syp: "SYP",
  syrup: "SYP",
  susp: "SUS",
  sus: "SUS",
  drop: "DRP",
  drops: "DRP",
  oint: "OIN",
  ointment: "OIN",
  cream: "CRM",
  crm: "CRM",
  gel: "GEL",
  lotion: "LOT",
  lot: "LOT",
  spray: "SPRAY",
  inhaler: "INHALER",
  sachet: "SAC",
  sac: "SAC",
  powder: "POW",
  pow: "POW",
  patch: "PATCH",
};

const byUpper = new Map(MEDICINE_TYPES.map((type) => [type.toUpperCase(), type]));

export function medicineTypeFor({ form = null, name = "" } = {}) {
  const saved = String(form || "").trim();
  if (saved) {
    const known = byUpper.get(saved.toUpperCase()) || FROM_FORM[saved.toLowerCase()];
    if (known) return known;
  }
  const first = String(name || "")
    .trim()
    .split(/[\s.]+/)[0]
    ?.toLowerCase();
  return (first && FROM_PREFIX[first]) || "";
}
