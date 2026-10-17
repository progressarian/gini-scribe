export const NURSE_RAPID_TESTS = ["blood sugar"];

export const isNurseRapidTest = (name) =>
  NURSE_RAPID_TESTS.includes(
    String(name || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase(),
  );
