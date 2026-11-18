import { toPaise } from "./pharmacyMoney.js";

const BASIS = 10000;

const roundDiv = (numerator, denominator) =>
  Math.floor((2 * numerator + denominator) / (2 * denominator));

const basisPoints = (pct) => Math.round(Number(pct || 0) * 100);

const unitsAmount = (packAmountPaise, qtyUnits, packSize) =>
  roundDiv(packAmountPaise * qtyUnits, packSize);

const halfOnTop = (amount, bp) => roundDiv(amount * bp, 2 * BASIS);

const halfInside = (amount, bp) => roundDiv(amount * bp, 2 * (BASIS + bp));

export function inclusivePackRate({
  packSaleRate,
  packMrp,
  gstRatePct,
  saleRateIncludesGst = false,
}) {
  const gross = toPaise(packSaleRate);
  const total = saleRateIncludesGst ? gross : gross + 2 * halfOnTop(gross, basisPoints(gstRatePct));
  return Math.min(total, toPaise(packMrp));
}

export function pricePharmacyLine({
  packSaleRate,
  packMrp,
  packSize,
  qtyUnits,
  gstRatePct,
  saleRateIncludesGst = false,
  gstFolded = false,
}) {
  const units = Number(qtyUnits);
  const size = Number(packSize);
  const bp = basisPoints(gstRatePct);
  const gross = unitsAmount(toPaise(packSaleRate), units, size);
  const mrpAmount = unitsAmount(toPaise(packMrp), units, size);

  let half = saleRateIncludesGst ? halfInside(gross, bp) : halfOnTop(gross, bp);
  let taxable = saleRateIncludesGst ? gross - 2 * half : gross;
  let total = taxable + 2 * half;
  const mrpCapped = total > mrpAmount;
  if (mrpCapped) {
    total = mrpAmount;
    half = halfInside(total, bp);
    taxable = total - 2 * half;
  }

  if (gstFolded) {
    return {
      gross,
      mrpAmount,
      mrpCapped,
      taxRatePct: 0,
      taxable: total,
      cgst: 0,
      sgst: 0,
      foldedGst: 2 * half,
      total,
    };
  }
  return {
    gross,
    mrpAmount,
    mrpCapped,
    taxRatePct: Number(gstRatePct || 0),
    taxable,
    cgst: half,
    sgst: half,
    foldedGst: 0,
    total,
  };
}

export function pharmacyBillTotals(lines) {
  const sum = lines.reduce(
    (acc, line) => ({
      gross: acc.gross + line.gross,
      taxable: acc.taxable + line.taxable,
      cgst: acc.cgst + line.cgst,
      sgst: acc.sgst + line.sgst,
      foldedGst: acc.foldedGst + line.foldedGst,
      total: acc.total + line.total,
    }),
    { gross: 0, taxable: 0, cgst: 0, sgst: 0, foldedGst: 0, total: 0 },
  );
  const net = Math.floor((sum.total + 50) / 100) * 100;
  return { ...sum, roundOff: net - sum.total, net };
}

const portion = (amountPaise, units, of) => roundDiv(amountPaise * units, of);

export function pharmacyReturnAmounts(line, bill, alreadyReturned, units) {
  const qty = Number(line.qty_units);
  const upto = (field, n) => portion(toPaise(line[field] ?? 0), n, qty);
  const part = (field) => upto(field, alreadyReturned + units) - upto(field, alreadyReturned);
  const total = part("total");
  const half = part("cgst");
  const folded = part("folded_gst");
  return {
    gross: part("gross_amount"),
    mrpAmount: part("mrp_amount"),
    total,
    cgst: half,
    sgst: half,
    foldedGst: folded,
    taxable: total - 2 * half,
    discount: 0,
    billDiscount: 0,
    mrpCapped: Boolean(line.mrp_capped),
    taxRatePct: Number(line.tax_rate_pct ?? 0),
  };
}

export function shareOut(amount, weights) {
  const whole = weights.reduce((sum, w) => sum + w, 0);
  if (!whole || !amount) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / whole);
  const shares = raw.map(Math.floor);
  let left = amount - shares.reduce((sum, s) => sum + s, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (!left) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

export function applyDiscounts(lines, { kind = null, value = 0 } = {}) {
  const afterLine = lines.map(({ price, discountPct }) => {
    const discount = roundDiv(price.total * basisPoints(discountPct), 100 * 100);
    return { discount, amount: price.total - discount };
  });
  const base = afterLine.map((l) => l.amount);
  const shares =
    kind === "percent"
      ? base.map((amount) => roundDiv(amount * basisPoints(value), 100 * 100))
      : kind === "amount"
        ? shareOut(
            Math.min(
              toPaise(value),
              base.reduce((s, a) => s + a, 0),
            ),
            base,
          )
        : base.map(() => 0);
  return lines.map(({ price, gstRatePct, gstFolded }, i) => {
    const discount = afterLine[i].discount;
    const billDiscount = shares[i];
    if (!discount && !billDiscount) return { ...price, discount: 0, billDiscount: 0 };
    const total = afterLine[i].amount - billDiscount;
    const half = halfInside(total, basisPoints(gstRatePct));
    return gstFolded
      ? {
          ...price,
          discount,
          billDiscount,
          total,
          taxable: total,
          cgst: 0,
          sgst: 0,
          foldedGst: 2 * half,
        }
      : {
          ...price,
          discount,
          billDiscount,
          total,
          taxable: total - 2 * half,
          cgst: half,
          sgst: half,
        };
  });
}

export const discountOf = (lines) =>
  lines.reduce((sum, l) => sum + (l.discount ?? 0) + (l.billDiscount ?? 0), 0);

export const undiscountedOf = (lines) =>
  lines.reduce((sum, l) => sum + l.total + (l.discount ?? 0) + (l.billDiscount ?? 0), 0);
