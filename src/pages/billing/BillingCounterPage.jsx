import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useArrivals } from "../../queries/hooks/useGiniflowReception";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import {
  useDeskSettings,
  useOpenDraft,
  usePatientSchemeList,
  useRereadBill,
  useVisitBills,
  useVisitNotPriced,
} from "../../queries/hooks/useBilling";
import LiveBadge from "../../components/giniflow/LiveBadge";
import PatientHeader from "../../components/billing/counter/PatientHeader";
import PreviousBills from "../../components/billing/counter/PreviousBills";
import BillLinesTable from "../../components/billing/counter/BillLinesTable";
import NotPricedTests from "../../components/billing/counter/NotPricedTests";
import AddItems from "../../components/billing/counter/AddItems";
import DiscountCodeBox from "../../components/billing/counter/DiscountCodeBox";
import TotalsAndPayment from "../../components/billing/counter/TotalsAndPayment";
import BillActions from "../../components/billing/counter/BillActions";
import DuesList from "../../components/billing/counter/DuesList";
import ShiftPanel from "../../components/billing/counter/ShiftPanel";
import { errorOf } from "../../components/billing/format";
import "../../styles/giniflow-station.css";
import "./billingCounter.css";

const TABS = {
  bill: { key: "bill", label: "Bill" },
  dues: { key: "dues", label: "Dues" },
  shift: { key: "shift", label: "Shift" },
};

function VisitRow({ row, active, onPick }) {
  return (
    <button
      type="button"
      className={`sq-item${active ? " active" : ""}`}
      onClick={() => onPick(row.visitId)}
    >
      <div className="si-name">{row.name}</div>
      <div className="si-meta">
        {row.age}
        {(row.sex || "")[0] || ""} · {row.fileNo || "—"} · {row.statusLabel}
      </div>
    </button>
  );
}

export default function BillingCounterPage() {
  const [params, setParams] = useSearchParams();
  const visitId = params.get("visit") || "";
  const patientId = params.get("patient") || "";
  const billId = params.get("bill") || "";
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [bill, setBill] = useState(null);
  const [error, setError] = useState(null);
  const [payLater, setPayLater] = useState(false);
  const [tab, setTab] = useState(TABS.bill.key);
  const [duePatient, setDuePatient] = useState(null);
  const opened = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const live = useGiniflowLive();
  const { data, isLoading } = useArrivals(undefined, debounced);
  const openDraft = useOpenDraft();
  const reread = useRereadBill();
  const { data: settings } = useDeskSettings();
  const { data: visitBills } = useVisitBills(visitId);
  const { data: notPriced } = useVisitNotPriced(visitId);
  const { data: schemes } = usePatientSchemeList();

  const expected = data?.expected || [];
  const onFloor = data?.onFloor || [];
  const rows = useMemo(() => [...expected, ...onFloor], [expected, onFloor]);
  const selected = rows.find((row) => row.visitId === visitId) || null;

  const pick = (id) => {
    setTab(TABS.bill.key);
    setDuePatient(null);
    setParams(id ? { visit: id } : {});
  };

  const takePaymentOn = (due) => {
    setTab(TABS.bill.key);
    setDuePatient({ name: due.patient.name, fileNo: due.patient.file_no });
    setParams({ ...(due.visit_id ? { visit: due.visit_id } : {}), bill: due.bill_id });
  };

  useEffect(() => {
    if (!patientId || visitId) return;
    const match = rows.find((row) => String(row.patientId) === patientId);
    if (match) setParams({ visit: match.visitId }, { replace: true });
  }, [patientId, visitId, rows, setParams]);

  useEffect(() => {
    const wanted = billId ? `bill:${billId}` : visitId ? `visit:${visitId}` : "";
    if (!wanted) {
      opened.current = null;
      setBill(null);
      setPayLater(false);
      return;
    }
    if (opened.current === wanted) return;
    opened.current = wanted;
    setBill(null);
    setError(null);
    setPayLater(false);
    const handlers = {
      onSuccess: setBill,
      onError: (e) => setError(errorOf(e, "This bill could not be opened")),
    };
    if (billId) reread.mutate({ billId }, handlers);
    else openDraft.mutate({ visitId }, handlers);
  }, [visitId, billId]);

  const duesOn = Boolean(settings?.allow_pay_later);
  const tabs = [TABS.bill, ...(duesOn ? [TABS.dues] : []), TABS.shift];
  const activeTab = tab === TABS.dues.key && !duesOn ? TABS.bill.key : tab;
  const earlier = (visitBills || []).filter((b) => b.id !== bill?.id);
  const missing = patientId && !visitId && rows.length > 0;

  return (
    <div className="gf">
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--tl-l)", color: "var(--tl)" }}>
          🧾 Billing Counter
        </div>
        <div className="rail-right">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name, file no, phone…"
            aria-label="Search today's patients"
            onChange={(e) => setSearch(e.target.value)}
          />
          <LiveBadge live={live} className="tr-live" />
          <a className="tr-back" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          <div className="ar-split">
            <div className="ar-col">
              <div className="grp-lbl grp-lbl-sp">
                Expected<span className="grp-split">{expected.length}</span>
              </div>
              {isLoading && <div className="empty-note">Loading…</div>}
              {!isLoading && !expected.length && <div className="empty-note">Nobody expected.</div>}
              {expected.map((row) => (
                <VisitRow
                  key={row.visitId}
                  row={row}
                  active={row.visitId === visitId}
                  onPick={pick}
                />
              ))}

              <div className="grp-lbl grp-sub">
                On the floor<span className="grp-split">{onFloor.length}</span>
              </div>
              {!onFloor.length && <div className="empty-note">Nobody on the floor.</div>}
              {onFloor.map((row) => (
                <VisitRow
                  key={row.visitId}
                  row={row}
                  active={row.visitId === visitId}
                  onPick={pick}
                />
              ))}
            </div>

            <div className="bc-detail">
              <div className="bc-tabs" role="tablist" aria-label="Billing counter">
                {tabs.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    role="tab"
                    id={`bc-tab-${entry.key}`}
                    aria-controls={`bc-panel-${entry.key}`}
                    aria-selected={activeTab === entry.key}
                    className={`st-btn${activeTab === entry.key ? " st-btn-grn" : " st-btn-g"}`}
                    onClick={() => setTab(entry.key)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>

              {activeTab === TABS.bill.key && (
                <div
                  className="bc-panel"
                  role="tabpanel"
                  id="bc-panel-bill"
                  aria-labelledby="bc-tab-bill"
                >
                  {missing && (
                    <div className="empty-note">That patient has no visit on the floor today.</div>
                  )}
                  {!visitId && !billId && !missing && (
                    <div className="empty-note">Choose a patient to see their bills.</div>
                  )}
                  {error && <div className="bc-err">{error}</div>}
                  {(visitId || billId) && !bill && !error && (
                    <div className="empty-note">Opening the bill…</div>
                  )}
                  {bill && (
                    <>
                      <PatientHeader
                        patient={selected || duePatient}
                        bill={bill}
                        needsCategory={bill.needs_category}
                        suggestions={bill.suggestions}
                        onBill={setBill}
                      />
                      <PreviousBills bills={earlier} />
                      <BillLinesTable bill={bill} onBill={setBill} />
                      <AddItems bill={bill} onBill={setBill} />
                      <NotPricedTests tests={notPriced} />
                      <DiscountCodeBox bill={bill} onBill={setBill} />
                      <TotalsAndPayment
                        bill={bill}
                        onBill={setBill}
                        schemes={schemes || []}
                        payLater={payLater}
                        onPayLater={setPayLater}
                      />
                      <BillActions
                        bill={bill}
                        onBill={setBill}
                        schemes={schemes || []}
                        payLater={payLater}
                      />
                    </>
                  )}
                </div>
              )}

              {activeTab === TABS.dues.key && (
                <div
                  className="bc-panel"
                  role="tabpanel"
                  id="bc-panel-dues"
                  aria-labelledby="bc-tab-dues"
                >
                  <DuesList onTakePayment={takePaymentOn} />
                </div>
              )}

              {activeTab === TABS.shift.key && (
                <div
                  className="bc-panel"
                  role="tabpanel"
                  id="bc-panel-shift"
                  aria-labelledby="bc-tab-shift"
                >
                  <ShiftPanel />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
