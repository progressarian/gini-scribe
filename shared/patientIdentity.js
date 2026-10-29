export const GOVT_ID_TYPES = ["Passport", "Driver's License", "Voter ID", "PAN Card"];

export const REGISTRATION_FILE_KINDS = {
  id_proof: { docType: "id_proof", title: "ID proof", column: "id_doc_id" },
  scheme_card: { docType: "scheme_card", title: "Category card", column: "scheme_card_doc_id" },
};

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 7, 6, 8, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const verhoeffValid = (digits) => {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => {
    c = D[c][P[i % 8][Number(ch)]];
  });
  return c === 0;
};

export const aadhaarDigits = (v) => String(v ?? "").replace(/\D/g, "");

export const formatAadhaar = (v) =>
  aadhaarDigits(v)
    .slice(0, 12)
    .replace(/(\d{4})(?=\d)/g, "$1 ");

export const isValidAadhaar = (v) => {
  const d = aadhaarDigits(v);
  return d.length === 12 && /^[2-9]/.test(d) && verhoeffValid(d);
};

const filled = (v) => String(v ?? "").trim() !== "";

export const AADHAAR_HINT = "Enter the 12-digit Aadhaar number.";
export const AADHAAR_CHECK_HINT = "This Aadhaar number isn't valid. Check the digits.";

const CARD_ALWAYS = ["cghs"];

export const schemeNeedsCard = (code, parentCode, requiresRef) =>
  Boolean(code) &&
  (Boolean(requiresRef) || CARD_ALWAYS.includes(code) || CARD_ALWAYS.includes(parentCode));

const aadhaarProblem = (v) => (aadhaarDigits(v).length === 12 ? AADHAAR_CHECK_HINT : AADHAAR_HINT);

const compact = (v) =>
  String(v ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");

const GOVT_ID_RULES = {
  Passport: {
    test: (v) => /^[A-Z0-9]{6,12}$/.test(compact(v)),
    hint: "Enter the passport number (6–12 letters and digits).",
  },
  "Driver's License": {
    test: (v) => /^[A-Z]{2}[A-Z0-9]{8,14}$/.test(compact(v)),
    hint: "Enter the licence number, e.g. PB10 20190012345.",
  },
  "Voter ID": {
    test: (v) => /^[A-Z]{3}[0-9]{7}$/.test(compact(v)),
    hint: "Enter the 10-character Voter ID, e.g. ABC1234567.",
  },
  "PAN Card": {
    test: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(compact(v)),
    hint: "Enter the 10-character PAN, e.g. ABCDE1234F.",
  },
};

export const CARD_HINT = "Enter the card number (4–30 letters, digits, / or -).";

export const isValidCardNumber = (v) => /^[A-Za-z0-9/ -]{4,30}$/.test(String(v ?? "").trim());

export const govtIdHint = (type) => GOVT_ID_RULES[type]?.hint || "Enter the ID number.";

export const isValidGovtId = (type, v) => Boolean(GOVT_ID_RULES[type]?.test(v));

export const cleanGovtId = (v) =>
  String(v ?? "")
    .trim()
    .toUpperCase();

export function identityProblems(p, { requiresCard = false, useOtherId = false } = {}) {
  const problems = {};
  if (filled(p.scheme_code)) {
    if (requiresCard && !filled(p.scheme_ref)) problems.scheme_ref = "Enter the card number.";
    else if (requiresCard && !isValidCardNumber(p.scheme_ref)) problems.scheme_ref = CARD_HINT;
    if (filled(p.aadhaar) && !isValidAadhaar(p.aadhaar))
      problems.aadhaar = aadhaarProblem(p.aadhaar);
    return problems;
  }
  if (useOtherId || (!filled(p.aadhaar) && filled(p.govt_id))) {
    if (!GOVT_ID_TYPES.includes(p.govt_id_type)) problems.govt_id_type = "Choose the ID type.";
    if (!filled(p.govt_id)) problems.govt_id = "Enter the ID number.";
    else if (GOVT_ID_TYPES.includes(p.govt_id_type) && !isValidGovtId(p.govt_id_type, p.govt_id))
      problems.govt_id = govtIdHint(p.govt_id_type);
    return problems;
  }
  if (!filled(p.aadhaar))
    problems.aadhaar = "Aadhaar is required for General patients, or use another govt ID.";
  else if (!isValidAadhaar(p.aadhaar)) problems.aadhaar = aadhaarProblem(p.aadhaar);
  return problems;
}
