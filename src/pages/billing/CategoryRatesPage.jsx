import { useState } from "react";
import { useBillingCategories, useBillingRateGrid } from "../../queries/hooks/useBillingMaster";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";

const SOURCE_LABEL = { own: "Own", parent: "From parent", base: "Base price" };

export default function CategoryRatesPage() {
  const { data: tree = [] } = useBillingCategories({ activeOnly: true });
  const categories = tree.flatMap((top) => [top, ...top.sub_categories]);
  const [code, setCode] = useState("");
  const { data: grid, isLoading, isError } = useBillingRateGrid(code);

  return (
    <div className="flow-root fset">
      <div className="flow-card">
        <div className="fset__cardhead">
          <div className="flow-sec-title">Category rates</div>
        </div>
        <div className="fset__cardsub">
          What each category pays for each service. A sub-category uses its parent's rate unless it
          has its own.
        </div>
        <div className="fset__addrow">
          <label htmlFor="rate-category">Category</label>
          <select
            id="rate-category"
            className="jb-assign"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          >
            <option value="">Choose a category</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.display_label}
              </option>
            ))}
          </select>
        </div>
        {!code ? null : isError ? (
          <div className="fset__cardsub">Could not load the rates.</div>
        ) : isLoading || !grid ? (
          <div className="fset__cardsub">Loading…</div>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table" style={{ border: "none" }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ width: 110 }}>Base price</th>
                  <th style={{ width: 110 }}>Rate</th>
                  <th style={{ width: 120 }}>Bill code</th>
                  <th style={{ width: 120 }}>From</th>
                </tr>
              </thead>
              <tbody>
                {grid.items.map((item) => (
                  <tr key={item.service_item_id}>
                    <td>{item.name}</td>
                    <td>{item.base_price}</td>
                    <td>{item.rate}</td>
                    <td>{item.bill_code ?? "—"}</td>
                    <td>{SOURCE_LABEL[item.rate_source]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
