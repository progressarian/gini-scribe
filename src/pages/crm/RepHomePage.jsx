import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import api from "../../services/api.js";
import { downloadFile } from "../../lib/downloadBlob.js";
import { errorText } from "../../components/crm/import/importText.js";
import { startAutoDrain, pendingCount } from "../../crm/offlineQueue.js";
import AssignmentsPanel from "../../components/crm/AssignmentsPanel.jsx";
import RemovalRequestsPanel from "../../components/crm/doctors/RemovalRequestsPanel.jsx";
import DueList from "../../components/crm/home/DueList.jsx";
import DoctorsList from "../../components/crm/home/DoctorsList.jsx";
import ReferralsList from "../../components/crm/home/ReferralsList.jsx";
import TasksList from "../../components/crm/home/TasksList.jsx";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";

// The rep's home screen (brief §13). Opened one-handed, in a corridor.
//
// Ordered by what the rep does next, not by what the data model contains:
// who is overdue, who have I already seen today, who else is on my patch. The
// only number that matters at the top is how many doctors still need visiting.

const TABS = [
  { key: "due", label: "To visit" },
  // Open leads sit beside the visit list, not behind a doctor. A referral
  // nobody can see is a referral nobody chases (§6).
  { key: "referrals", label: "Referrals" },
  { key: "today", label: "Today" },
  { key: "doctors", label: "My doctors" },
  { key: "tasks", label: "Tasks" },
];

const ASSIGNMENTS_TAB = { key: "assignments", label: "Assignments" };
const REMOVALS_TAB = { key: "removals", label: "Removal requests" };
const SEES_EVERY_DOCTOR = ["ceo_admin", "head_of_growth"];

export default function RepHomePage() {
  const navigate = useNavigate();
  const me = useAuthStore((st) => st.currentDoctor);
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(() => params.get("tab") || "due");
  const [removalsWaiting, setRemovalsWaiting] = useState(0);
  const [pending, setPending] = useState(pendingCount());
  const [referrals, setReferrals] = useState(null);
  const [listFilters, setListFilters] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [err, setErr] = useState(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState(null);

  const justLogged = params.get("logged");
  const justReferred = params.get("referral");

  const load = () =>
    Promise.all([
      api.get("/api/crm/home", { params: { lists: 0 } }).then(({ data }) => setData(data)),
      api
        .get("/api/crm/referrals", { params: { page: 1 } })
        .then(({ data }) => setReferrals(data))
        .catch(() => setReferrals({ referrals: [], summary: {} })),
    ]).catch((e) => setErr(e?.response?.data?.error || "Could not load your doctors"));

  const reload = () => load().then(() => setRefreshKey((n) => n + 1));

  useEffect(() => {
    load();
    // The queue drains here rather than on the visit screen, because this is
    // the screen a rep leaves open between calls — and the one they reopen
    // when they walk back into signal.
    const stop = startAutoDrain(
      (v) => api.post("/api/crm/visits", v).then((r) => r.data),
      (remaining) => {
        setPending(remaining);
        if (remaining === 0) reload();
      },
    );
    return stop;
  }, []);

  useEffect(() => {
    if (!justLogged && !justReferred) return;
    const t = setTimeout(() => setParams({}, { replace: true }), 4000);
    return () => clearTimeout(t);
  }, [justLogged, justReferred, setParams]);

  const leadView = SEES_EVERY_DOCTOR.includes(data?.user?.role);

  useEffect(() => {
    if (!leadView) return;
    api
      .get("/api/crm/removal-requests", { params: { status: "pending" } })
      .then(({ data: body }) => setRemovalsWaiting(body.counts.pending))
      .catch(() => setRemovalsWaiting(0));
  }, [leadView, refreshKey]);

  useEffect(() => {
    if (!params.get("tab")) return;
    const next = new URLSearchParams(params);
    next.delete("tab");
    setParams(next, { replace: true });
  }, []);

  const filtersFor = (key) => listFilters[key] || {};
  const setFiltersFor = (key) => (next) => setListFilters((prev) => ({ ...prev, [key]: next }));

  if (err)
    return (
      <div className="rep rep--wide">
        <div className="rep__err">{err}</div>
      </div>
    );
  if (!data)
    return (
      <div className="rep rep--wide">
        <div className="rep__loading">Loading…</div>
      </div>
    );

  const p = data.performance;
  const canImport = hasCapability(me, CAPABILITIES.CRM_IMPORT);

  const downloadSheet = async () => {
    setSheetBusy(true);
    setSheetErr(null);
    try {
      await downloadFile("/api/crm/visits/sheet.xlsx", "my-visits.xlsx");
    } catch (e) {
      setSheetErr(errorText(e, "Unable to download your sheet."));
    } finally {
      setSheetBusy(false);
    }
  };

  return (
    <div className="rep rep--wide">
      <header className="rep__head">
        <div>
          <span className="rep__eyebrow">Growth</span>
          <h1 className="rep__title">{data.user.name?.split(" ")[0] || "Today"}</h1>
        </div>
        {pending > 0 && (
          <span className="rep__pending" title="Visits saved on this phone, waiting for signal">
            {pending} to sync
          </span>
        )}
      </header>

      <section className="rep__perf" aria-label="This month">
        <dl className="rep__perf-stats">
          <div>
            <dt>Visits this month</dt>
            <dd>{p.visits_month}</dd>
          </div>
          <div>
            <dt>Unique doctors</dt>
            <dd>{p.unique_doctors_month}</dd>
          </div>
          <div>
            <dt>Assigned</dt>
            <dd>{p.doctors_assigned}</dd>
          </div>
        </dl>
        <div className="rep__perf-actions">
          <Link to="/crm/doctors/new" className="rep__perf-action rep__perf-action--primary">
            Add doctor
          </Link>
          <button
            type="button"
            className="rep__perf-action"
            onClick={downloadSheet}
            disabled={sheetBusy}
          >
            {sheetBusy ? "Preparing…" : "Download my sheet"}
          </button>
          <Link to="/crm/visits/import" className="rep__perf-action">
            Upload visits
          </Link>
          <Link to="/crm/progress" className="rep__perf-action">
            View progress
          </Link>
          {canImport && (
            <Link to="/crm/import" className="rep__perf-action">
              Import list
            </Link>
          )}
        </div>
        {sheetErr && (
          <p className="rep__perf-err" role="alert">
            {sheetErr}
          </p>
        )}
        {leadView && removalsWaiting > 0 && (
          <p className="rep__perf-note" role="status">
            {removalsWaiting} removal request{removalsWaiting === 1 ? "" : "s"} waiting for you.{" "}
            <button type="button" className="asg__link" onClick={() => setTab("removals")}>
              Review
            </button>
          </p>
        )}
      </section>

      {justLogged && (
        <div className="rep__toast">Visit logged{justLogged ? ` — ${justLogged}` : ""}</div>
      )}
      {justReferred && (
        <div className="rep__toast">
          Referral {justReferred} logged — claimed until the patient confirms at registration
        </div>
      )}

      <div className="rep__stats">
        <Stat n={data.due_summary?.total ?? data.due_visits.length} label="To visit" tone="warn" />
        <Stat n={p.visits_today} label="Today" />
        <Stat
          n={referrals?.summary?.open ?? 0}
          label="Open leads"
          tone={referrals?.summary?.untouched ? "warn" : null}
        />
        <Stat
          n={p.doctors_incomplete}
          label="Need details"
          tone={p.doctors_incomplete ? "warn" : null}
        />
      </div>

      <nav className="rep__tabs" aria-label="CRM lists">
        {[...TABS, ...(leadView ? [ASSIGNMENTS_TAB, REMOVALS_TAB] : [])].map((t) => (
          <button
            key={t.key}
            type="button"
            className={`rep__tab ${tab === t.key ? "rep__tab--on" : ""}`}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "due" && (data.due_summary?.total ?? 0) > 0 && (
              <span className="rep__badge">{data.due_summary.total}</span>
            )}
            {t.key === "referrals" && (referrals?.summary?.open ?? 0) > 0 && (
              <span className="rep__badge">{referrals.summary.open}</span>
            )}
            {t.key === "removals" && removalsWaiting > 0 && (
              <span className="rep__badge">{removalsWaiting}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "due" && (
        <DueList
          filters={filtersFor("due")}
          onChange={setFiltersFor("due")}
          refreshKey={refreshKey}
        />
      )}

      {tab === "referrals" && (
        <ReferralsList
          filters={filtersFor("referrals")}
          onChange={setFiltersFor("referrals")}
          refreshKey={refreshKey}
          onChanged={reload}
        />
      )}

      {tab === "today" && (
        <ul className="rep__list home__list">
          {data.todays_visits.length === 0 && <Empty>No visits logged yet today.</Empty>}
          {data.todays_visits.map((v) => (
            // The whole card is the target, not a link inside it. A logged
            // visit is a thing you want to re-read — what did they say? — and
            // hunting for a small link on a phone is the wrong ask.
            <li key={v.id}>
              <button
                className="rep__row rep__row--tap"
                onClick={() => navigate(`/crm/doctor/${v.doctor_id}?visit=${v.id}`)}
              >
                <div className="rep__row-main">
                  <strong>{v.full_name}</strong>
                  <span className="rep__row-sub">
                    {new Date(v.occurred_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {v.outcome ? ` · ${v.outcome.replace(/_/g, " ")}` : ""}
                    {v.area ? ` · ${v.area}` : ""}
                    {v.source === "sheet" ? " · From sheet" : ""}
                  </span>
                </div>
                <span className="rep__chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === "doctors" && (
        <DoctorsList
          filters={filtersFor("doctors")}
          onChange={setFiltersFor("doctors")}
          refreshKey={refreshKey}
          onChanged={reload}
        />
      )}

      {tab === "assignments" && leadView && <AssignmentsPanel />}

      {tab === "removals" && leadView && (
        <RemovalRequestsPanel onCountChange={setRemovalsWaiting} />
      )}

      {tab === "tasks" && (
        <TasksList
          filters={filtersFor("tasks")}
          onChange={setFiltersFor("tasks")}
          refreshKey={refreshKey}
        />
      )}
    </div>
  );
}

function Stat({ n, label, tone }) {
  return (
    <div className={`rep__stat ${tone ? `rep__stat--${tone}` : ""}`}>
      <span className="rep__stat-n">{n}</span>
      <span className="rep__stat-l">{label}</span>
    </div>
  );
}

const Empty = ({ children }) => <li className="rep__empty">{children}</li>;
