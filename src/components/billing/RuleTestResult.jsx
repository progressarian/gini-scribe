import { METHOD_LABEL, paise } from "./discountText";

const signed = (amount) =>
  amount < 0 ? `−${paise(-amount)}` : amount > 0 ? `+${paise(amount)}` : paise(0);

const FROM_PAYABLE = "patient_payable";

const TOTALS = [
  ["actual", "Actual"],
  ["discount", "Line discounts"],
  ["bill_discount", "Bill discounts"],
  ["tax", "Tax"],
  ["patient_payable", "Patient pays"],
  ["claim", "Claim"],
  ["adjustment", "Adjustment"],
];

const stepText = (step) =>
  `${step.name}${step.code ? ` (${step.code})` : ""} −${paise(step.amount)}${step.taken_from === FROM_PAYABLE ? " off what the patient pays" : ""}`;

function appliedRules(result) {
  const byRule = new Map();
  for (const line of result.lines) {
    for (const step of [...line.discounts, ...line.bill_discounts]) {
      const seen = byRule.get(step.rule_id) ?? {
        rule_id: step.rule_id,
        name: step.name,
        code: step.code,
        method: step.method,
        amount: 0,
        lines: new Set(),
      };
      seen.amount += step.amount;
      seen.lines.add(line.line_no);
      byRule.set(step.rule_id, seen);
    }
  }
  for (const code of result.applied_codes) {
    if (!byRule.has(code.rule_id)) {
      byRule.set(code.rule_id, {
        rule_id: code.rule_id,
        name: code.name,
        code: code.code,
        method: "code",
        amount: code.amount,
        lines: new Set(),
      });
    }
  }
  return [...byRule.values()];
}

export default function RuleTestResult({ result, stale = false }) {
  const applied = appliedRules(result);
  const categoryName = result.category?.display_label ?? "General";
  return (
    <div
      className={`disc-result${stale ? " disc-result--stale" : ""}`}
      aria-label="Test result"
      role="region"
    >
      <p className="disc-result__head">
        Priced as <strong>{categoryName}</strong>
        {result.payer_name ? ` · claim to ${result.payer_name}` : ""} · {result.date}
      </p>
      {result.warnings?.length ? (
        <ul className="disc-result__warnings" aria-label="Warnings">
          {result.warnings.map((w) => (
            <li key={typeof w === "string" ? w : JSON.stringify(w)}>
              {typeof w === "string" ? w : (w.message ?? JSON.stringify(w))}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="fset__scroll fset__scroll--wide">
        <table className="flow-table" aria-label="Priced lines">
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th>Qty</th>
              <th>Actual</th>
              <th>Discount</th>
              <th>Tax</th>
              <th>Patient pays</th>
              <th>Claim</th>
              <th>Adjustment</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((line) => (
              <tr key={line.line_no}>
                <td>{line.line_no}</td>
                <td>
                  {line.bill_name}
                  <div className="flow-muted bill-items__sub">
                    {line.payment_rule_name
                      ? `${line.payment_rule_name}: ${line.payment_rule_text}`
                      : "Patient pays in full"}
                  </div>
                  {[...line.discounts, ...line.bill_discounts].map((step, i) => (
                    <div key={`${step.rule_id}-${i}`} className="bill-items__sub disc-result__step">
                      {stepText(step)}
                    </div>
                  ))}
                </td>
                <td>{line.quantity}</td>
                <td>{paise(line.actual)}</td>
                <td>{paise(line.discount)}</td>
                <td>{paise(line.tax)}</td>
                <td>{paise(line.patient_payable)}</td>
                <td>{paise(line.claim)}</td>
                <td>{paise(line.adjustment)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="disc-result__lists">
        <section aria-label="Discounts that applied">
          <h3 className="disc-result__title">Discounts that applied</h3>
          {applied.length ? (
            <ul>
              {applied.map((rule) => (
                <li key={rule.rule_id}>
                  {rule.name}
                  {rule.code ? ` (${rule.code})` : ""} · {METHOD_LABEL[rule.method] ?? "Rule"} · −
                  {paise(rule.amount)}
                  {rule.lines.size
                    ? ` · line${rule.lines.size > 1 ? "s" : ""} ${[...rule.lines].join(", ")}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fset__hint">None.</p>
          )}
        </section>
        <section aria-label="Codes refused">
          <h3 className="disc-result__title">Codes refused</h3>
          {result.refused_codes.length ? (
            <ul>
              {result.refused_codes.map((refused) => (
                <li key={refused.code}>
                  <strong>{refused.code}</strong> — {refused.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fset__hint">None.</p>
          )}
        </section>
      </div>

      <dl className="disc-result__totals" aria-label="Totals">
        {TOTALS.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{paise(result.totals[key])}</dd>
          </div>
        ))}
        <div>
          <dt>Round-off</dt>
          <dd>{signed(result.totals.round_off)}</dd>
        </div>
        <div className="disc-result__payable">
          <dt>Payable</dt>
          <dd>{paise(result.totals.payable)}</dd>
        </div>
      </dl>
    </div>
  );
}
