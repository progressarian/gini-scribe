const NON_TESTS = new Set(["age", "patient age", "sex", "gender", "name", "patient name"]);

export const isNonTest = (name) =>
  NON_TESTS.has(
    String(name ?? "")
      .trim()
      .toLowerCase(),
  );

export const nonTestPredicate = (expr) =>
  `lower(btrim(${expr})) NOT IN (${[...NON_TESTS].map((n) => `'${n}'`).join(", ")})`;
