import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import {
  useCounterPatients,
  useDiscardDraft,
  useOpenDraft,
  usePatientSchemeList,
  useRereadBill,
  useSaveDraft,
  useVisitBills,
  useVisitNotPriced,
} from "../../../queries/hooks/useBilling";
import PatientList, { counterRows } from "./PatientList";
import PatientHeader from "./PatientHeader";
import PreviousBills from "./PreviousBills";
import BillLinesTable from "./BillLinesTable";
import NotPricedTests from "./NotPricedTests";
import AddItems from "./AddItems";
import ConsultationSuggestion from "./ConsultationSuggestion";
import LabCaseTests from "./LabCaseTests";
import DiscountCodeBox from "./DiscountCodeBox";
import TotalsAndPayment from "./TotalsAndPayment";
import BillActions from "./BillActions";
import DuesList from "./DuesList";
import EarlierDues from "./EarlierDues";
import ShiftPanel from "./ShiftPanel";
import LeaveDraftDialog from "./LeaveDraftDialog";
import { dropStaleForms, useSavedForm } from "./useSavedForm";
import { BILL_FORM, BILL_FORM_PREFIX, SHIFT_FORM_PREFIX, billFormKey } from "./counterForm";
import { errorOf } from "../format";
import "../../../styles/giniflow-station.css";
import "../../../pages/billing/billingCounter.css";

export const DESK_TABS = {
  bill: { key: "bill", label: "Bill", tabId: "bc-tab-bill", panelId: "bc-panel-bill" },
  dues: { key: "dues", label: "Dues", tabId: "bc-tab-dues", panelId: "bc-panel-dues" },
  shift: { key: "shift", label: "Shift", tabId: "bc-tab-shift", panelId: "bc-panel-shift" },
};

const LIST_WIDTH = { min: 220, max: 560, initial: 300, step: 16, key: "billing.counter.listWidth" };

const clampWidth = (value) => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, value));

function savedWidth() {
  try {
    const saved = Number(localStorage.getItem(LIST_WIDTH.key));
    return saved ? clampWidth(saved) : LIST_WIDTH.initial;
  } catch {
    return LIST_WIDTH.initial;
  }
}

function useListWidth() {
  const [width, setWidth] = useState(savedWidth);
  const change = useCallback((next) => {
    const value = clampWidth(Math.round(next));
    setWidth(value);
    try {
      localStorage.setItem(LIST_WIDTH.key, String(value));
    } catch {
      return;
    }
  }, []);
  return [width, change];
}

function Resizer({ width, onChange }) {
  const drag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev) => onChange(startWidth + ev.clientX - startX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("bc-resizing");
    };
    document.body.classList.add("bc-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const keys = {
    ArrowLeft: () => onChange(width - LIST_WIDTH.step),
    ArrowRight: () => onChange(width + LIST_WIDTH.step),
    Home: () => onChange(LIST_WIDTH.min),
    End: () => onChange(LIST_WIDTH.max),
  };
  return (
    <div
      className="bc-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the patient list"
      aria-valuemin={LIST_WIDTH.min}
      aria-valuemax={LIST_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={drag}
      onDoubleClick={() => onChange(LIST_WIDTH.initial)}
      onKeyDown={(e) => {
        if (!keys[e.key]) return;
        e.preventDefault();
        keys[e.key]();
      }}
    >
      <span className="bc-resizer__grip" aria-hidden="true" />
    </div>
  );
}

const openedFrom = (location) => {
  const params = new URLSearchParams(location.search);
  return `${params.get("visit") ?? ""}|${params.get("bill") ?? ""}`;
};

function useLeaveGuard(bill) {
  const [baseline, setBaseline] = useState(null);
  const [leaving, setLeaving] = useState(null);
  const saveDraft = useSaveDraft();
  const discardDraft = useDiscardDraft();
  const isDraft = bill?.status === "draft";
  const edited = isDraft && baseline !== null && bill.version !== baseline;
  const holding = isDraft && (edited || !bill.saved);
  const held = useRef(false);
  held.current = holding;

  useEffect(() => {
    setBaseline(bill ? bill.version : null);
  }, [bill?.id, bill?.saved_at]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      held.current && openedFrom(currentLocation) !== openedFrom(nextLocation),
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (edited) {
      setLeaving({ busy: false, error: null });
      return;
    }
    discardDraft.mutate({ billId: bill.id, visitId: bill.visit_id });
    blocker.proceed();
  }, [blocker.state]);

  useEffect(() => {
    if (!edited) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);

  const settle = (mutation, message) => async () => {
    setLeaving({ busy: true, error: null });
    try {
      await mutation.mutateAsync({ billId: bill.id, visitId: bill.visit_id });
      setLeaving(null);
      blocker.proceed?.();
    } catch (e) {
      setLeaving({ busy: false, error: errorOf(e, message) });
    }
  };

  const dialog = leaving && (
    <LeaveDraftDialog
      saved={bill?.saved}
      busy={leaving.busy}
      error={leaving.error}
      onSave={settle(saveDraft, "This draft could not be saved")}
      onDiscard={settle(discardDraft, "This draft could not be discarded")}
      onStay={() => {
        setLeaving(null);
        blocker.reset?.();
      }}
    />
  );

  const followReread = (before, after) =>
    setBaseline((current) => (current === before.version ? after.version : current));

  return { dialog, followReread };
}

function Panel({ tab, children }) {
  return (
    <div className="bc-panel" role="tabpanel" id={tab.panelId} aria-labelledby={tab.tabId}>
      {children}
    </div>
  );
}

export default function BillingDesk({ tab, visitId, patientId, billId, sentPatient, onOpen }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [bill, setBill] = useState(null);
  const [error, setError] = useState(null);
  const [duePatient, setDuePatient] = useState(null);
  const [fresh, setFresh] = useState(0);
  const [needsSub, setNeedsSub] = useState(false);
  const [removedDoctor, setRemovedDoctor] = useState(null);
  const [listOpen, setListOpen] = useState(!visitId && !billId);
  const opened = useRef(null);
  const [listWidth, setListWidth] = useListWidth();
  const form = useSavedForm(billFormKey(bill?.id), BILL_FORM);
  const leave = useLeaveGuard(bill);
  const payLater = form.value.payLater;
  const setPayLater = (on) => form.set("payLater", on);

  useEffect(() => {
    dropStaleForms(BILL_FORM_PREFIX);
    dropStaleForms(SHIFT_FORM_PREFIX);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useCounterPatients(debounced.trim());
  const openDraft = useOpenDraft();
  const reread = useRereadBill();
  const { data: visitBills } = useVisitBills(visitId);
  const { data: notPriced } = useVisitNotPriced(visitId);
  const { data: schemes } = usePatientSchemeList();

  const rows = useMemo(() => counterRows(data), [data]);
  const selected = rows.find((row) => row.visitId === visitId) || null;

  const pick = (id) => {
    setDuePatient(null);
    setListOpen(false);
    if (id && id === visitId && !billId) setFresh((n) => n + 1);
    onOpen(id ? { visit: id } : {});
  };

  const openEarlier = (earlierBill) => {
    setDuePatient(selected);
    onOpen({ visit: visitId, bill: earlierBill.id });
  };

  const reopenVisit = (id) => {
    setDuePatient(null);
    setFresh((n) => n + 1);
    onOpen(id ? { visit: id } : {});
  };

  const openVisitDraft = () => reopenVisit(visitId);

  const takePaymentOn = (due) => {
    setDuePatient({ name: due.patient.name, fileNo: due.patient.file_no });
    onOpen({ ...(due.visit_id ? { visit: due.visit_id } : {}), bill: due.bill_id });
  };

  useEffect(() => {
    if (!patientId || visitId) return;
    const match = rows.find((row) => String(row.patientId) === patientId);
    if (match) onOpen({ visit: match.visitId }, { replace: true });
  }, [patientId, visitId, rows, onOpen]);

  useEffect(() => {
    const wanted = billId ? `bill:${billId}` : visitId ? `visit:${visitId}:${fresh}` : "";
    if (!wanted) {
      opened.current = null;
      setBill(null);
      return;
    }
    if (opened.current === wanted) return;
    opened.current = wanted;
    setBill(null);
    setError(null);
    setNeedsSub(false);
    setRemovedDoctor(null);
    const handlers = {
      onSuccess: (found) => {
        if (opened.current !== wanted) return;
        setNeedsSub(Boolean(found?.needs_category));
        setRemovedDoctor(found?.removed_doctor ?? null);
        setBill(found);
      },
      onError: (e) => {
        if (opened.current === wanted) setError(errorOf(e, "This bill could not be opened"));
      },
    };
    if (billId) reread.mutate({ billId }, handlers);
    else openDraft.mutate({ visitId }, handlers);
  }, [visitId, billId, fresh]);

  useEffect(() => {
    if (!bill || bill.status !== "draft" || reread.isPending) return;
    const listed = (visitBills || []).find((b) => b.id === bill.id);
    if (!listed || listed.version <= bill.version) return;
    reread.mutate(
      { billId: bill.id },
      {
        onSuccess: (found) => {
          if (bill.id === found.id && found.version >= bill.version) {
            leave.followReread(bill, found);
          }
          setBill((current) =>
            current?.id === found.id && found.version >= current.version ? found : current,
          );
        },
      },
    );
  }, [visitBills]);

  const earlier = (visitBills || []).filter((b) => b.id !== bill?.id);
  const newerDraft = bill && bill.status !== "draft" && earlier.some((b) => b.status === "draft");
  const startAgain = bill?.status === "cancelled" && !newerDraft;
  const needsCategory = needsSub && !bill?.category;
  const missing = patientId && !visitId && rows.length > 0;
  const showList = tab === DESK_TABS.bill.key;

  return (
    <div
      className={`bc-layout${showList ? "" : " bc-layout--solo"}`}
      style={{ "--bc-list": `${listWidth}px` }}
    >
      {leave.dialog}
      {showList ? (
        <>
          <aside className="bc-list" aria-label="Today's patients">
            <div className="bc-list__head">
              <div className="bc-list__title">
                Patients<span className="bc-count">{rows.length}</span>
              </div>
              <button
                type="button"
                className="bc-list__toggle"
                aria-expanded={listOpen}
                aria-controls="bc-list-panel"
                onClick={() => setListOpen((open) => !open)}
              >
                Patients · {rows.length}
                <span aria-hidden="true">{listOpen ? "▴" : "▾"}</span>
              </button>
              <input
                className="bc-list__search"
                type="search"
                value={search}
                placeholder="Search name, file no, phone…"
                aria-label="Search today's patients"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setListOpen(true);
                }}
              />
            </div>
            <div
              id="bc-list-panel"
              className={`bc-list__panel${listOpen ? "" : " bc-list__panel--shut"}`}
            >
              <PatientList
                data={data}
                isLoading={isLoading}
                visitId={visitId}
                searching={debounced.trim().length >= 2}
                onPick={pick}
              />
            </div>
          </aside>

          <Resizer width={listWidth} onChange={setListWidth} />
        </>
      ) : null}

      <div className="bc-main">
        <div className="bc-detail">
          {tab === DESK_TABS.bill.key && (
            <Panel tab={DESK_TABS.bill}>
              {missing && (
                <div className="bc-empty">That patient has no visit on the floor today.</div>
              )}
              {!visitId && !billId && !missing && (
                <div className="bc-empty">
                  <strong>No patient chosen</strong>
                  Pick a patient from the list to open their bill.
                </div>
              )}
              {error && <div className="bc-err">{error}</div>}
              {(visitId || billId) && !bill && !error && (
                <div className="bc-empty">Opening the bill…</div>
              )}
              {newerDraft && (
                <div className="bc-hint" role="status">
                  A new draft bill is open on this visit.{" "}
                  <button type="button" className="st-btn st-btn-blu" onClick={openVisitDraft}>
                    Open the new draft bill
                  </button>
                </div>
              )}
              {startAgain && (
                <div className="bc-hint" role="status">
                  This bill was cancelled.{" "}
                  <button type="button" className="st-btn st-btn-blu" onClick={openVisitDraft}>
                    Start a new bill for this visit
                  </button>
                </div>
              )}
              {bill && removedDoctor && (
                <div className="bc-hint" role="status">
                  {removedDoctor.name} was removed, so this visit has no consultation fee.
                </div>
              )}
              {bill && (
                <>
                  <EarlierDues
                    patientId={bill.patient_id}
                    visitId={visitId}
                    billId={bill.id}
                    onTakePayment={takePaymentOn}
                  />
                  <PatientHeader
                    patient={selected || duePatient || sentPatient}
                    bill={bill}
                    needsCategory={needsCategory}
                    suggestions={bill.suggestions}
                    onBill={setBill}
                    onClose={() => pick(null)}
                    form={form}
                  />
                  <div className="bc-bill">
                    <div className="bc-bill__work">
                      <PreviousBills bills={earlier} onOpen={openEarlier} />
                      <BillLinesTable bill={bill} onBill={setBill} form={form} />
                      <ConsultationSuggestion
                        key={bill.id}
                        bill={bill}
                        onBill={setBill}
                        needsCategory={needsCategory}
                      />
                      <LabCaseTests
                        key={`lab-${bill.id}`}
                        bill={bill}
                        onBill={setBill}
                        needsCategory={needsCategory}
                      />
                      <AddItems bill={bill} onBill={setBill} form={form} />
                      <NotPricedTests tests={notPriced} />
                      <DiscountCodeBox bill={bill} onBill={setBill} form={form} />
                    </div>
                    <div className="bc-bill__summary">
                      <TotalsAndPayment
                        bill={bill}
                        onBill={setBill}
                        schemes={schemes || []}
                        payLater={payLater}
                        onPayLater={setPayLater}
                        form={form}
                      />
                      <BillActions
                        bill={bill}
                        onBill={setBill}
                        onDeleted={() => reopenVisit(bill.visit_id)}
                        schemes={schemes || []}
                        payLater={payLater}
                        needsCategory={needsCategory}
                        form={form}
                      />
                    </div>
                  </div>
                </>
              )}
            </Panel>
          )}

          {tab === DESK_TABS.dues.key && (
            <Panel tab={DESK_TABS.dues}>
              <DuesList onTakePayment={takePaymentOn} />
            </Panel>
          )}

          {tab === DESK_TABS.shift.key && (
            <Panel tab={DESK_TABS.shift}>
              <ShiftPanel />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
