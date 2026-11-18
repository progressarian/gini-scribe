import { useEffect, useLayoutEffect, useRef } from "react";
import { ClipboardList, History } from "lucide-react";
import FormField from "../../components/ui/FormField";
import Pagination from "../../components/ui/Pagination";
import PillGroup from "../../components/pharmacy/Pills";
import { DateInput } from "../../components/pharmacy/Fields";
import RxPatientPane from "../../components/pharmacy/rx/RxPatientPane";
import FlowStatus from "../../components/pharmacy/rx/FlowStatus";
import { inr, localDate, showDate } from "../../components/pharmacy/format";
import { useRxQueue } from "../../queries/hooks/usePharmacyPrescriptions";
import { usePharmacyLive } from "../../queries/hooks/usePharmacyLive";
import useUrlState, { asNumber, useUrlSearch } from "../../hooks/useUrlState";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";
import "./pharmacyRx.css";

const CATEGORIES = [
  { key: "ready", label: "Ready at counter" },
  { key: "coming", label: "On the way" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

const EMPTY = {
  ready: "Nobody is waiting at the pharmacy right now.",
  coming: "Nobody on the way with a prescription.",
  done: "Nobody has finished at the pharmacy yet.",
  all: "No prescriptions for this day.",
};
const PAGE_SIZE = 25;

function Progress({ row }) {
  const given = row.given + row.partial;
  const pct = row.total ? Math.round((given / row.total) * 100) : 0;
  return (
    <span className="prx-progress">
      <span className="prx-progress__text">
        {given
          ? `${given} of ${row.total} given today`
          : `${row.total} ${row.total === 1 ? "medicine" : "medicines"} · none given yet`}
      </span>
      <span
        className="prx-progress__bar"
        role="progressbar"
        aria-label="Medicines given today"
        aria-valuemin={0}
        aria-valuemax={row.total}
        aria-valuenow={given}
      >
        <span className="prx-progress__fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function BillBadge({ row }) {
  if (row.has_final) {
    return Number(row.due) > 0 ? (
      <span className="bill-status phs-badge phs-badge--review">Due {inr(row.due)}</span>
    ) : (
      <span className="bill-status phs-badge prx-badge--paid">Billed</span>
    );
  }
  if (row.has_draft) return <span className="bill-status phs-badge">Draft</span>;
  return null;
}

export default function PharmacyPrescriptionsPage() {
  const [date, setDate] = useUrlState("date", localDate());
  const [category, setCategory] = useUrlState("category", "ready");
  const [page, setPage] = useUrlState("page", 1, asNumber);
  const [patientId, setPatientId] = useUrlState("patient", "");
  const { search, setSearch, q } = useUrlSearch("q", () => setPage(1));
  usePharmacyLive();
  const detailRef = useRef(null);
  const layoutRef = useRef(null);

  useLayoutEffect(() => {
    const fit = () => {
      const layout = layoutRef.current;
      if (!layout) return;
      if (window.matchMedia("(max-width: 960px)").matches) {
        layout.style.height = "";
        return;
      }
      const top = layout.getBoundingClientRect().top + window.scrollY;
      layout.style.height = `${Math.max(window.innerHeight - top - 16, 420)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    if (!patientId || !window.matchMedia?.("(max-width: 960px)").matches) return;
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [patientId]);

  const query = useRxQueue({
    date,
    category,
    ...(q ? { q } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const rows = query.data?.rows ?? [];

  return (
    <div className="flow-root fset bill-ui phs phb prx">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Prescriptions</h1>
          <p className="phs-sub">
            Patients our doctors prescribed for. Add their medicines to the bill and collect payment
            here.
          </p>
        </div>
      </header>

      <div ref={layoutRef} className="prx-layout">
        <section className="flow-card prx-list" aria-labelledby="prx-list-title">
          <div className="fset__cardhead">
            <h2 id="prx-list-title" className="flow-sec-title">
              Patients
            </h2>
            <span className="fset__count">{query.data?.total ?? 0}</span>
          </div>
          <div className="prx-filters">
            <FormField label="Date">
              <DateInput
                value={date}
                maxDate={localDate()}
                onChange={(value) => {
                  setDate(value);
                  setPage(1);
                  setPatientId("");
                }}
              />
            </FormField>
            <FormField label="Search">
              <input
                type="search"
                className="jb-assign"
                placeholder="Name, file number or mobile"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </FormField>
            <PillGroup
              label="Show patients"
              value={category}
              options={CATEGORIES.map((c) => ({
                ...c,
                label: query.data ? `${c.label} (${query.data.categories[c.key]})` : c.label,
              }))}
              onChange={(key) => {
                setCategory(key);
                setPage(1);
              }}
            />
          </div>

          {query.isError ? (
            <div className="phs-empty" role="alert">
              <p>Unable to load prescriptions. Please try again.</p>
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                onClick={() => query.refetch()}
              >
                Try again
              </button>
            </div>
          ) : query.isLoading ? (
            <p className="phs-empty" role="status">
              Loading…
            </p>
          ) : !rows.length ? (
            <p className="phs-empty">
              {q ? "No patient matches your search." : (EMPTY[category] ?? EMPTY.all)}
            </p>
          ) : (
            <>
              <ul className="prx-patients">
                {rows.map((row) => {
                  const on = patientId === String(row.patient_id);
                  return (
                    <li key={row.patient_id}>
                      <button
                        type="button"
                        className={`prx-row${on ? " is-on" : ""}`}
                        aria-current={on ? "true" : undefined}
                        onClick={() => setPatientId(String(row.patient_id))}
                      >
                        <span className="prx-row__top">
                          <span className="prx-row__name">{row.name}</span>
                          <BillBadge row={row} />
                        </span>
                        <span className="prx-row__meta">
                          {[row.file_no, row.doctor_name].filter(Boolean).join(" · ")}
                        </span>
                        <FlowStatus status={row.current_status} label={row.status_label} />
                        <Progress row={row} />
                        <span className="prx-row__last">
                          <History size={13} aria-hidden="true" />
                          {row.last_collected
                            ? `Last collected ${showDate(row.last_collected)}`
                            : "First collection from us"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={query.data?.total ?? 0}
                onChange={setPage}
                disabled={query.isFetching}
                unit="patients"
              />
            </>
          )}
        </section>

        <section ref={detailRef} className="prx-detail" aria-label="Prescription and bill">
          {patientId ? (
            <RxPatientPane key={`${patientId}:${date}`} patientId={patientId} date={date} />
          ) : (
            <div className="phb-nolines">
              <ClipboardList size={20} className="phb-nolines__icon" aria-hidden="true" />
              <p className="phb-nolines__title">Choose a patient</p>
              <p className="phs-meta">Their prescription opens here, split by what is in stock.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
