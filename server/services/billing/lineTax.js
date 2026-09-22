import { httpError } from "./transaction.js";
import { cleanFlag, MONEY_MAX, readNumber } from "./common.js";
import { paise } from "../../../shared/labPayment.js";

const BASIS = 10000n;
const RATE_MESSAGE = "Tax rate must be a number from 0 to 100 per cent, with at most 2 decimals";

const roundDiv = (numerator, denominator) =>
  Number((2n * numerator + denominator) / (2n * denominator));

function cleanNet(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(400, "Net amount must be whole paise, 0 or more");
  }
  return value;
}

function basisPoints(taxCode) {
  const rate = typeof taxCode === "object" ? readNumber(taxCode.rate_pct, RATE_MESSAGE) : undefined;
  if (rate === undefined || rate < 0 || rate > 100 || Number(rate.toFixed(2)) !== rate) {
    throw httpError(400, RATE_MESSAGE);
  }
  return { rate, bp: BigInt(Math.round(rate * 100)) };
}

function fitsOneLine(line) {
  if (line.total > paise(MONEY_MAX)) {
    throw httpError(400, "This line's total with tax is too large for one bill line");
  }
  return line;
}

const untaxed = (net) => ({
  tax_code_id: null,
  tax_code: null,
  sac_hsn: null,
  tax_rate: 0,
  taxable: net,
  cgst: 0,
  sgst: 0,
  tax: 0,
  total: net,
});

export function lineTax({ net, taxCode = null, gstEnabled = false, priceIncludesTax = false }) {
  const amount = cleanNet(net);
  const charging = cleanFlag(gstEnabled, "GST");
  const inclusive = cleanFlag(priceIncludesTax, "Price includes tax");
  if (!charging || !taxCode) return fitsOneLine(untaxed(amount));
  const { rate, bp } = basisPoints(taxCode);
  const half = inclusive
    ? roundDiv(BigInt(amount) * bp, 2n * (BASIS + bp))
    : roundDiv(BigInt(amount) * bp, 2n * BASIS);
  const taxable = inclusive ? amount - 2 * half : amount;
  return fitsOneLine({
    tax_code_id: taxCode.id ?? null,
    tax_code: taxCode.code ?? null,
    sac_hsn: taxCode.sac_hsn ?? null,
    tax_rate: rate,
    taxable,
    cgst: half,
    sgst: half,
    tax: 2 * half,
    total: taxable + 2 * half,
  });
}
