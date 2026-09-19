import { useBillingSettings, useBillSeries } from "../../queries/hooks/useBillingMaster";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";

const STACKING_LABEL = { best_only: "Best discount only", per_rule: "Per rule" };

export default function BillingSettingsPage() {
  const { data: settings, isLoading, isError } = useBillingSettings();
  const { data: series = [] } = useBillSeries();

  return (
    <div className="flow-root fset">
      <div className="flow-card">
        <div className="fset__cardhead">
          <div className="flow-sec-title">Billing settings</div>
        </div>
        {isError ? (
          <div className="fset__cardsub">Could not load the billing settings.</div>
        ) : isLoading || !settings ? (
          <div className="fset__cardsub">Loading…</div>
        ) : (
          <table className="flow-table" style={{ border: "none" }}>
            <tbody>
              <tr>
                <th style={{ width: 220 }}>Discount stacking</th>
                <td>{STACKING_LABEL[settings.discount_stacking]}</td>
              </tr>
              <tr>
                <th>Pay later</th>
                <td>{settings.allow_pay_later ? "Allowed" : "Not allowed"}</td>
              </tr>
              <tr>
                <th>GST</th>
                <td>{settings.gst_enabled ? `On · ${settings.gstin}` : "Off"}</td>
              </tr>
              <tr>
                <th>Number series</th>
                <td>
                  {series.map((s) => `${s.series} ${s.fy}: ${s.next_number}`).join(" · ") ||
                    "None yet"}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
