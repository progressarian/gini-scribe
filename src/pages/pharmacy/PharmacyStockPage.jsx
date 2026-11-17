import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasAnyCapability, hasCapability } from "../../../shared/permissions";
import BatchStockPanel from "../../components/pharmacy/BatchStockPanel";
import DarpanStockPanel from "../../components/pharmacy/DarpanStockPanel";
import StockListPanel from "../../components/pharmacy/StockListPanel";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const TABS = [
  { key: "batches", label: "Batch stock" },
  { key: "list", label: "Stock list" },
  { key: "darpan", label: "DARPAN report" },
];

export default function PharmacyStockPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "batches";
  const tabRefs = useRef({});
  const withCost = hasAnyCapability(role, [
    CAPABILITIES.PHARMACY_PURCHASE,
    CAPABILITIES.PHARMACY_MASTER,
  ]);
  const canAdjust = hasCapability(role, CAPABILITIES.PHARMACY_STOCK_ADJUST);

  const select = (key) => {
    setParams(key === "batches" ? {} : { tab: key }, { replace: true });
    tabRefs.current[key]?.focus();
  };

  const onKeyDown = (e) => {
    const i = TABS.findIndex((t) => t.key === tab);
    if (e.key === "ArrowRight") select(TABS[(i + 1) % TABS.length].key);
    if (e.key === "ArrowLeft") select(TABS[(i - 1 + TABS.length) % TABS.length].key);
  };

  return (
    <div className="flow-root fset bill-ui phs">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy stock</h1>
          <p className="phs-sub">
            Batch, expiry and rack for every medicine, by location. The DARPAN report stays
            available while both systems run side by side.
          </p>
        </div>
      </header>

      <div className="bst-tabs" role="tablist" aria-label="Stock views" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`bst-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`bst-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            className={`bst-tab${tab === t.key ? " on" : ""}`}
            onClick={() => select(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`bst-panel-${tab}`} aria-labelledby={`bst-tab-${tab}`}>
        {tab === "batches" ? (
          <BatchStockPanel withCost={withCost} canAdjust={canAdjust} />
        ) : tab === "list" ? (
          <StockListPanel withCost={withCost} />
        ) : (
          <DarpanStockPanel />
        )}
      </div>
    </div>
  );
}
