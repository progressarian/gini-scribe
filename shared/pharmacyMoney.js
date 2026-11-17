export const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
export const toRupees = (paise) => (paise / 100).toFixed(2);

export function purchaseLineAmounts({ qty_packs, purchase_rate, discount_pct, gst_rate_pct }) {
  const gross = Number(qty_packs || 0) * toPaise(purchase_rate);
  const discount = Math.round((gross * Number(discount_pct || 0)) / 100);
  const taxable = gross - discount;
  const gst = Math.round((taxable * Number(gst_rate_pct || 0)) / 100);
  return { gross, discount, taxable, gst, total: taxable + gst };
}

export function purchaseTotals(lines) {
  return lines.reduce(
    (sum, line) => {
      const a = purchaseLineAmounts(line);
      return {
        discount: sum.discount + a.discount,
        taxable: sum.taxable + a.taxable,
        gst: sum.gst + a.gst,
        total: sum.total + a.total,
      };
    },
    { discount: 0, taxable: 0, gst: 0, total: 0 },
  );
}

export const receivedUnits = (line, packSize) =>
  (Number(line.qty_packs || 0) + Number(line.free_packs || 0)) * Number(packSize || 1);
