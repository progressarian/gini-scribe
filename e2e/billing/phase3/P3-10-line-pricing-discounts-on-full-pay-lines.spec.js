import { test, expect } from "@playwright/test";

const { applyDiscounts } = await import("../../../server/services/billing/lineDiscounts.js");

let nextId = 1;
const rule = (fields) => ({
  id: nextId++,
  code: null,
  name: `Rule ${nextId}`,
  method: "auto",
  max_discount: null,
  priority: 100,
  stackable: false,
  applies_per: "line",
  ...fields,
});
const steps = (result) => result.applied.map((a) => [a.name, a.amount]);

test.describe("P3-10 · Line pricing: discounts on full-pay lines", () => {
  test("1. plan example: CC50 −500 beats age −100 under best_only", () => {
    const age = rule({ name: "Age 70+", kind: "percent", value: "10.00", priority: 1 });
    const cc50 = rule({ name: "CC50", code: "CC50", method: "code", kind: "percent", value: 50 });
    const best = applyDiscounts({ actual: 100000, rules: [age, cc50], stacking: "best_only" });
    expect(best).toEqual({
      discount: 50000,
      applied: [
        { rule_id: cc50.id, code: "CC50", name: "CC50", kind: "percent", value: 50, amount: 50000 },
      ],
    });
    const perRule = applyDiscounts({ actual: 100000, rules: [age, cc50], stacking: "per_rule" });
    expect(steps(perRule)).toEqual([["CC50", 50000]]);
    expect(perRule.discount).toBe(50000);
  });

  test("2. per_rule: largest non-stackable first, then stackables in priority order on what remains", () => {
    const rules = [
      rule({ name: "Flat 150", kind: "flat", value: 150 }),
      rule({ name: "Pct 20", kind: "percent", value: 20 }),
      rule({ name: "Flat 500 stack", kind: "flat", value: 500, stackable: true, priority: 2 }),
      rule({ name: "Pct 10 stack", kind: "percent", value: 10, stackable: true, priority: 1 }),
    ];
    const perRule = applyDiscounts({ actual: 100000, rules, stacking: "per_rule" });
    expect(steps(perRule)).toEqual([
      ["Pct 20", 20000],
      ["Pct 10 stack", 8000],
      ["Flat 500 stack", 50000],
    ]);
    expect(perRule.discount).toBe(78000);

    const swapped = rules.map((r) => (r.name === "Flat 500 stack" ? { ...r, priority: 0 } : r));
    const swappedResult = applyDiscounts({ actual: 100000, rules: swapped, stacking: "per_rule" });
    expect(steps(swappedResult)).toEqual([
      ["Pct 20", 20000],
      ["Flat 500 stack", 50000],
      ["Pct 10 stack", 3000],
    ]);
    expect(swappedResult.discount).toBe(73000);

    const best = applyDiscounts({ actual: 100000, rules, stacking: "best_only" });
    expect(steps(best)).toEqual([["Flat 500 stack", 50000]]);
  });

  test("3. per_rule with only stackable rules: they stack in order on what remains", () => {
    const rules = [
      rule({ name: "A", kind: "percent", value: 10, stackable: true, priority: 1 }),
      rule({ name: "B", kind: "percent", value: 10, stackable: true, priority: 2 }),
    ];
    const result = applyDiscounts({ actual: 100000, rules, stacking: "per_rule" });
    expect(steps(result)).toEqual([
      ["A", 10000],
      ["B", 9000],
    ]);
    expect(result.discount).toBe(19000);
  });

  test("4. max_discount caps a percent rule", () => {
    const capped = rule({
      name: "Half, max 200",
      kind: "percent",
      value: 50,
      max_discount: "200.00",
    });
    const flat = rule({ name: "Flat 300", kind: "flat", value: 300 });
    expect(
      steps(applyDiscounts({ actual: 100000, rules: [capped], stacking: "best_only" })),
    ).toEqual([["Half, max 200", 20000]]);
    expect(
      steps(applyDiscounts({ actual: 100000, rules: [capped, flat], stacking: "best_only" })),
    ).toEqual([["Flat 300", 30000]]);
    const small = applyDiscounts({ actual: 30000, rules: [capped], stacking: "best_only" });
    expect(small.discount).toBe(15000);
  });

  test("5. a flat discount larger than the line takes the whole line and no more", () => {
    const flat = rule({ name: "Flat 500", kind: "flat", value: 500 });
    const stack = rule({ name: "Stack 10", kind: "percent", value: 10, stackable: true });
    expect(applyDiscounts({ actual: 25000, rules: [flat], stacking: "best_only" }).discount).toBe(
      25000,
    );
    const perRule = applyDiscounts({ actual: 25000, rules: [flat, stack], stacking: "per_rule" });
    expect(steps(perRule)).toEqual([["Flat 500", 25000]]);
    expect(perRule.discount).toBe(25000);
  });

  test("6. fixed price is per unit and multiplies by quantity", () => {
    const fixed = rule({ name: "Fixed 200", kind: "fixed_price", value: "200.00" });
    expect(
      applyDiscounts({ actual: 75000, quantity: 3, rules: [fixed], stacking: "best_only" }),
    ).toMatchObject({
      discount: 15000,
      applied: [{ amount: 15000, kind: "fixed_price", value: 200 }],
    });
    expect(applyDiscounts({ actual: 25000, rules: [fixed], stacking: "best_only" }).discount).toBe(
      5000,
    );
    expect(
      applyDiscounts({ actual: 50000, quantity: 3, rules: [fixed], stacking: "best_only" }),
    ).toEqual({ discount: 0, applied: [] });
    const free = rule({ name: "Free", kind: "fixed_price", value: 0 });
    expect(
      applyDiscounts({ actual: 75000, quantity: 3, rules: [free], stacking: "per_rule" }).discount,
    ).toBe(75000);
  });

  test("7. ties go to the lower priority number, then the lower id", () => {
    const late = { ...rule({ name: "Late", kind: "flat", value: 100, priority: 5 }), id: 9 };
    const early = { ...rule({ name: "Early", kind: "flat", value: 100, priority: 2 }), id: 12 };
    expect(
      steps(applyDiscounts({ actual: 100000, rules: [late, early], stacking: "best_only" })),
    ).toEqual([["Early", 10000]]);
    const high = { ...rule({ name: "High id", kind: "flat", value: 100, priority: 3 }), id: 7 };
    const low = { ...rule({ name: "Low id", kind: "flat", value: 100, priority: 3 }), id: 4 };
    expect(
      steps(applyDiscounts({ actual: 100000, rules: [high, low], stacking: "best_only" })),
    ).toEqual([["Low id", 10000]]);
    expect(
      steps(applyDiscounts({ actual: 100000, rules: [high, low], stacking: "per_rule" })),
    ).toEqual([["Low id", 10000]]);
  });

  test("8. no rules means no discount", () => {
    expect(applyDiscounts({ actual: 100000, rules: [], stacking: "best_only" })).toEqual({
      discount: 0,
      applied: [],
    });
    expect(
      applyDiscounts({
        actual: 0,
        rules: [rule({ kind: "flat", value: 10 })],
        stacking: "per_rule",
      }),
    ).toEqual({
      discount: 0,
      applied: [],
    });
  });

  test("9. percent rounds to the paisa, half up", () => {
    const third = rule({ name: "33.33%", kind: "percent", value: "33.33" });
    expect(applyDiscounts({ actual: 9999, rules: [third], stacking: "best_only" }).discount).toBe(
      3333,
    );
    const eighth = rule({ name: "12.5%", kind: "percent", value: 12.5 });
    expect(applyDiscounts({ actual: 100, rules: [eighth], stacking: "best_only" }).discount).toBe(
      13,
    );
    expect(applyDiscounts({ actual: 99, rules: [eighth], stacking: "best_only" }).discount).toBe(
      12,
    );
    const half = rule({ name: "50%", kind: "percent", value: 50 });
    expect(applyDiscounts({ actual: 1, rules: [half], stacking: "best_only" }).discount).toBe(1);
    const seven = rule({ name: "7%", kind: "percent", value: 7, stackable: true });
    const result = applyDiscounts({ actual: 12345, rules: [third, seven], stacking: "per_rule" });
    expect(steps(result)).toEqual([
      ["33.33%", 4115],
      ["7%", 576],
    ]);
  });

  test("10. the total discount never exceeds the actual amount", () => {
    const rules = [
      rule({ name: "Big", kind: "percent", value: 90 }),
      rule({ name: "S1", kind: "flat", value: 50, stackable: true, priority: 1 }),
      rule({ name: "S2", kind: "percent", value: 100, stackable: true, priority: 2 }),
      rule({ name: "S3", kind: "flat", value: 5, stackable: true, priority: 3 }),
    ];
    const result = applyDiscounts({ actual: 10000, rules, stacking: "per_rule" });
    expect(steps(result)).toEqual([
      ["Big", 9000],
      ["S1", 1000],
    ]);
    expect(result.discount).toBe(10000);
    const sum = result.applied.reduce((total, a) => total + a.amount, 0);
    expect(sum).toBe(result.discount);
  });

  test("11. bill-level rules are left for the bill and ignored on a line", () => {
    const bill = rule({ name: "Whole bill", kind: "flat", value: 900, applies_per: "bill" });
    const line = rule({ name: "Line", kind: "flat", value: 100 });
    expect(
      steps(applyDiscounts({ actual: 100000, rules: [bill, line], stacking: "best_only" })),
    ).toEqual([["Line", 10000]]);
    expect(applyDiscounts({ actual: 100000, rules: [bill], stacking: "per_rule" }).discount).toBe(
      0,
    );
  });

  test("12. bad input is refused with a 400", () => {
    const flat = rule({ kind: "flat", value: 10 });
    const bad = [
      { actual: 10.5, rules: [], stacking: "best_only" },
      { actual: -1, rules: [], stacking: "best_only" },
      { actual: "100", rules: [], stacking: "best_only" },
      { actual: 100, rules: [], stacking: "stack_all" },
      { actual: 100, rules: null, stacking: "per_rule" },
      { actual: 100, quantity: 0, rules: [], stacking: "per_rule" },
      { actual: 100, rules: [rule({ kind: "bogus", value: 1 })], stacking: "per_rule" },
      { actual: 100, rules: [rule({ kind: "flat", value: "abc" })], stacking: "per_rule" },
    ];
    for (const input of bad) {
      let error = null;
      try {
        applyDiscounts(input);
      } catch (e) {
        error = e;
      }
      expect(error?.status, JSON.stringify(input)).toBe(400);
    }
    expect(applyDiscounts({ actual: 100, rules: [flat], stacking: "per_rule" }).discount).toBe(100);
  });
  test("13. percent stays exact to the paisa on the largest line", () => {
    const nearlyAll = rule({ name: "99.99%", kind: "percent", value: "99.99" });
    expect(
      applyDiscounts({ actual: 999999995001, rules: [nearlyAll], stacking: "best_only" }).discount,
    ).toBe(999899995001);
    const third = rule({ name: "33.33%", kind: "percent", value: "33.33" });
    expect(
      applyDiscounts({ actual: 999999999999, rules: [third], stacking: "best_only" }).discount,
    ).toBe(333300000000);
  });

  test("14. the same rule given twice counts once", () => {
    const stack = rule({ name: "Stack 10", kind: "flat", value: 10, stackable: true });
    const again = { ...stack };
    const perRule = applyDiscounts({ actual: 10000, rules: [stack, again], stacking: "per_rule" });
    expect(steps(perRule)).toEqual([["Stack 10", 1000]]);
    expect(perRule.discount).toBe(1000);
    const pct = rule({ name: "Pct 10", kind: "percent", value: 10, stackable: true });
    expect(
      steps(applyDiscounts({ actual: 10000, rules: [pct, { ...pct }], stacking: "per_rule" })),
    ).toEqual([["Pct 10", 1000]]);
  });

  test("15. a broken rule row is refused, not silently skipped or misread", () => {
    const bad = [
      rule({ kind: "percent", value: 10, max_discount: "abc" }),
      rule({ kind: "percent", value: 10, max_discount: -5 }),
      rule({ kind: "percent", value: 150 }),
      rule({ kind: "flat", value: null }),
      rule({ kind: "flat", value: "" }),
      rule({ kind: "flat", value: true }),
      rule({ kind: "flat", value: 10, priority: "soon" }),
      rule({ kind: "flat", value: -10 }),
    ];
    for (const broken of bad) {
      let error = null;
      try {
        applyDiscounts({ actual: 10000, rules: [broken], stacking: "best_only" });
      } catch (e) {
        error = e;
      }
      expect(error?.status, JSON.stringify(broken)).toBe(400);
      expect(error.message).toContain(broken.name);
    }
    const fine = rule({ kind: "percent", value: "100.00", max_discount: "0.50", priority: "3" });
    expect(applyDiscounts({ actual: 10000, rules: [fine], stacking: "best_only" }).discount).toBe(
      50,
    );
  });

  test("16. a smaller non-stackable applies when the largest takes nothing on this line", () => {
    const fixed = rule({ name: "Fixed 500", kind: "fixed_price", value: 500, priority: 1 });
    const flat = rule({ name: "Flat 10", kind: "flat", value: 10, priority: 2 });
    const stack = rule({ name: "Stack 5%", kind: "percent", value: 5, stackable: true });
    const result = applyDiscounts({
      actual: 10000,
      rules: [fixed, flat, stack],
      stacking: "per_rule",
    });
    expect(steps(result)).toEqual([
      ["Flat 10", 1000],
      ["Stack 5%", 450],
    ]);
    expect(result.discount).toBe(1450);
  });

  test("17. the same rules in any order give the same answer", () => {
    const rules = [
      rule({ name: "P1", kind: "flat", value: 100, priority: 2 }),
      rule({ name: "P2", kind: "percent", value: 10, priority: 1 }),
      rule({ name: "S1", kind: "percent", value: 5, stackable: true, priority: 3 }),
      rule({ name: "S2", kind: "flat", value: 20, stackable: true, priority: 3 }),
    ];
    for (const stacking of ["best_only", "per_rule"]) {
      const forward = applyDiscounts({ actual: 100000, rules, stacking });
      const backward = applyDiscounts({ actual: 100000, rules: [...rules].reverse(), stacking });
      expect(backward).toEqual(forward);
    }
  });
});
