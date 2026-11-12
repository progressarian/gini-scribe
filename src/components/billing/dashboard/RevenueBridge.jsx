import { SERIES } from "../../crm/progress/progressText";
import { money, shareOf } from "./dashboardText";

function stepsOf(total) {
  return [
    { key: "rules", label: "Discount rules", amount: -total.rule_discount },
    {
      key: "category",
      label: "Category rates (CGHS, senior citizen…)",
      amount: -total.category_reduction,
    },
    { key: "written_off", label: "Written off", amount: -total.adjustment },
    { key: "claim", label: "CGHS / scheme claim", amount: -total.claim },
    { key: "tax", label: "Tax and round-off", amount: total.tax + total.round_off },
  ].filter((step) => step.amount);
}

export default function RevenueBridge({ data }) {
  const total = data.total;
  const steps = stepsOf(total);
  const largest = Math.max(1, ...steps.map((step) => Math.abs(step.amount)));
  const kept = total.charges_total ? total.net_revenue / total.charges_total : 0;
  const empty = !total.charges_total && !total.net_revenue;
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-bridge">
      <div className="fset__cardhead">
        <h2 id="bdash-bridge" className="flow-sec-title">
          From charges to net revenue
        </h2>
      </div>
      {empty ? (
        <div className="bill-allclear">No billed visits in this range.</div>
      ) : (
        <>
          <div
            className="bdash-meter"
            role="img"
            aria-label={`Net revenue is ${shareOf(total.net_revenue, total.charges_total)} of charges`}
          >
            <span
              className="bdash-meter__fill"
              style={{ width: `${Math.min(100, Math.max(0, kept * 100))}%`, background: SERIES[0] }}
            />
          </div>
          <table className="bdash-bridge" aria-label="From charges to net revenue">
            <tbody>
              <tr className="bdash-bridge__total">
                <th scope="row">Charges at base price</th>
                <td className="bdash-bridge__bar" />
                <td className="brep-num">{money(total.charges_total)}</td>
                <td className="bdash-muted brep-num">100%</td>
              </tr>
              {steps.map((step) => (
                <tr key={step.key}>
                  <th scope="row">{step.label}</th>
                  <td className="bdash-bridge__bar">
                    <span
                      style={{
                        width: `${(100 * Math.abs(step.amount)) / largest}%`,
                        background: step.amount < 0 ? SERIES[1] : SERIES[2],
                      }}
                    />
                  </td>
                  <td className="brep-num">
                    {step.amount < 0 ? "−" : "+"}
                    {money(Math.abs(step.amount))}
                  </td>
                  <td className="bdash-muted brep-num">
                    {shareOf(Math.abs(step.amount), total.charges_total)}
                  </td>
                </tr>
              ))}
              <tr className="bdash-bridge__total">
                <th scope="row">Net revenue</th>
                <td className="bdash-bridge__bar" />
                <td className="brep-num">{money(total.net_revenue)}</td>
                <td className="bdash-muted brep-num">
                  {shareOf(total.net_revenue, total.charges_total)}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
