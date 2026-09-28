import { test, expect } from "@playwright/test";

const { amountInWords, numberInWords, rupeesInWords } =
  await import("../../../server/services/billing/amountInWords.js");

const rupees = (value) => Math.round(value * 100);

test.describe("P4-23 amount in words", () => {
  test("1. rupee amounts read in the Indian system, with paise only when there are any", () => {
    const cases = [
      [0, "Rupees Zero Only"],
      [1, "Rupees One Only"],
      [99, "Rupees Ninety Nine Only"],
      [100.5, "Rupees One Hundred and Fifty Paise Only"],
      [2550, "Rupees Two Thousand Five Hundred Fifty Only"],
      [100000, "Rupees One Lakh Only"],
      [
        1234567.89,
        "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only",
      ],
    ];
    for (const [value, words] of cases) expect(amountInWords(rupees(value))).toBe(words);
  });

  test("2. crores, teens, round tens, bare paise and a negative amount", () => {
    expect(amountInWords(rupees(10000000))).toBe("Rupees One Crore Only");
    expect(amountInWords(rupees(123456789))).toBe(
      "Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only",
    );
    expect(amountInWords(rupees(1015))).toBe("Rupees One Thousand Fifteen Only");
    expect(amountInWords(rupees(90))).toBe("Rupees Ninety Only");
    expect(amountInWords(5)).toBe("Rupees Zero and Five Paise Only");
    expect(amountInWords(-rupees(250))).toBe("Minus Rupees Two Hundred Fifty Only");
    expect(amountInWords(null)).toBe("Rupees Zero Only");
    expect(numberInWords(100100)).toBe("One Lakh One Hundred");
  });
  test("3. the printed form puts the currency after the number, as the bill does", () => {
    expect(rupeesInWords(rupees(1000))).toBe("One Thousand Rupees Only");
    expect(rupeesInWords(rupees(0))).toBe("Zero Rupees Only");
    expect(rupeesInWords(rupees(100.5))).toBe("One Hundred Rupees and Fifty Paise Only");
    expect(rupeesInWords(rupees(1234567.89))).toBe(
      "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Eighty Nine Paise Only",
    );
  });
});
