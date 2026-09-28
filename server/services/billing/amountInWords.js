const ONES = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const UNITS = [
  [10000000, "Crore"],
  [100000, "Lakh"],
  [1000, "Thousand"],
  [100, "Hundred"],
];

function belowHundred(number) {
  if (number < 20) return ONES[number];
  const rest = number % 10;
  return rest ? `${TENS[Math.floor(number / 10)]} ${ONES[rest]}` : TENS[number / 10];
}

export function numberInWords(number) {
  const whole = Math.floor(Math.abs(Number(number) || 0));
  if (whole < 100) return belowHundred(whole);
  for (const [size, name] of UNITS) {
    if (whole >= size) {
      const head = numberInWords(Math.floor(whole / size));
      const rest = whole % size;
      return rest ? `${head} ${name} ${numberInWords(rest)}` : `${head} ${name}`;
    }
  }
  return belowHundred(whole);
}

export function amountInWords(paise) {
  const value = Math.round(Number(paise) || 0);
  const sign = value < 0 ? "Minus " : "";
  const rupees = Math.floor(Math.abs(value) / 100);
  const cents = Math.abs(value) % 100;
  const paiseText = cents ? ` and ${numberInWords(cents)} Paise` : "";
  return `${sign}Rupees ${numberInWords(rupees)}${paiseText} Only`;
}

export function rupeesInWords(paise) {
  const value = Math.round(Number(paise) || 0);
  const sign = value < 0 ? "Minus " : "";
  const rupees = Math.floor(Math.abs(value) / 100);
  const cents = Math.abs(value) % 100;
  const paiseText = cents ? ` and ${numberInWords(cents)} Paise` : "";
  return `${sign}${numberInWords(rupees)} Rupees${paiseText} Only`;
}
