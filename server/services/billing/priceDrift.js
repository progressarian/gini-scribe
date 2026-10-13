import { paise } from "../../../shared/labPayment.js";

const money = (amount) =>
  `₹${(amount / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const lineMoved = (line, now) =>
  paise(line.patient_payable) !== now.patient_payable ||
  paise(line.claim_amount) !== now.claim ||
  paise(line.rate) !== now.rate ||
  (line.payment_rule_id ?? null) !== (now.payment_rule_id ?? null);

async function rulesNamed(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, name, is_active FROM category_payment_rules WHERE id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function reasonsFor(line, now, rules) {
  const reasons = [];
  if (paise(line.rate) !== now.rate) {
    reasons.push(`Rate ${money(paise(line.rate))} → ${money(now.rate)}`);
  }
  const was = line.payment_rule_id ?? null;
  const is = now.payment_rule_id ?? null;
  if (was !== is) {
    const old = rules.get(was);
    if (old) {
      reasons.push(
        `"${old.name}" ${old.is_active ? "no longer applies" : "was switched off in Settings"}`,
      );
    } else if (was) {
      reasons.push("Its payment rule was deleted in Settings");
    }
    if (is) reasons.push(`Now "${now.payment_rule_name ?? rules.get(is)?.name}"`);
    else reasons.push("The patient now pays the full amount");
  }
  if (paise(line.discount) !== now.discount) {
    reasons.push(`Discount ${money(paise(line.discount))} → ${money(now.discount)}`);
  }
  return reasons.length ? reasons : ["Recalculated with today's settings"];
}

export async function priceChanges(db, bill, lines, priced) {
  const moved = lines
    .map((line, index) => ({ line, now: priced.lines[index] }))
    .filter(({ line, now }) => now && lineMoved(line, now));
  const before = { payable: paise(bill.patient_payable), claim: paise(bill.claim_amount) };
  const after = { payable: priced.totals.payable, claim: priced.totals.claim };
  if (!moved.length && before.payable === after.payable && before.claim === after.claim) {
    return null;
  }
  const rules = await rulesNamed(db, [
    ...new Set(
      moved.flatMap(({ line, now }) => [line.payment_rule_id, now.payment_rule_id]).filter(Boolean),
    ),
  ]);
  return {
    before,
    after,
    lines: moved.map(({ line, now }) => ({
      id: line.id,
      name: line.bill_name,
      before: paise(line.patient_payable),
      after: now.patient_payable,
      reasons: reasonsFor(line, now, rules),
    })),
  };
}

export const priceChangeText = (changes) =>
  `Prices changed in Settings since this bill was worked out — the patient now pays ${money(changes.after.payable)} (was ${money(changes.before.payable)}). Check the bill, then finalise again`;

export const takenAboveText = (taken, payable) =>
  `${money(taken)} has already been taken, which is more than the ${money(payable)} this bill now comes to — the bill was left as it is`;
