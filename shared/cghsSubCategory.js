export const CGHS_PENSIONER_AGE = 70;

export const CGHS = {
  parent: "cghs",
  pensioner: "cghs_pensioner",
  referral: "cghs_referral",
  paid: "cghs_paid",
};

const STARTS_AUTOMATICALLY = new Set([CGHS.parent, CGHS.paid, CGHS.referral]);
const FOLLOWS_REFERRAL = new Set([CGHS.paid, CGHS.referral]);

export const startingCghsSub = (code, age) => {
  if (!STARTS_AUTOMATICALLY.has(code)) return null;
  return Number.isInteger(age) && age >= CGHS_PENSIONER_AGE ? CGHS.pensioner : CGHS.paid;
};

export const cghsSubForReferral = (code, hasReferral) =>
  FOLLOWS_REFERRAL.has(code) ? (hasReferral ? CGHS.referral : CGHS.paid) : null;
