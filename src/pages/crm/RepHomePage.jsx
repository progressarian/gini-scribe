import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import api from "../../services/api.js";
import { startAutoDrain, pendingCount } from "../../crm/offlineQueue.js";
import ReferralStatusControl from "../../components/crm/ReferralStatusControl.jsx";
import { urgencyLabel, referralStatusLabel } from "../../../shared/crmVocab.js";
import {
  visitDueStateMeta,
  doctorPriorityMeta,
  DOCTOR_PRIORITIES,
} from "../../../shared/crmVocab.js";

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

export default function RepHomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("due");
  const [query, setQuery] = useState("");
  const [territory, setTerritory] = useState("all");
  const [pending, setPending] = useState(pendingCount());
  const [classifying, setClassifying] = useState(false);
  const [referrals, setReferrals] = useState(null);
  const [bulkMsg, setBulkMsg] = useState(null);
  const [err, setErr] = useState(null);

  const justLogged = params.get("logged");
  const justReferred = params.get("referral");

  const load = () =>
    Promise.all([
      api.get("/api/crm/home").then(({ data }) => setData(data)),
      api
        .get("/api/crm/referrals")
        .then(({ data }) => setReferrals(data))
        .catch(() => setReferrals({ referrals: [], summary: {} })),
    ]).catch((e) => setErr(e?.response?.data?.error || "Could not load your doctors"));

  useEffect(() => {
    load();
    // The queue drains here rather than on the visit screen, because this is
    // the screen a rep leaves open between calls — and the one they reopen
    // when they walk back into signal.
    const stop = startAutoDrain(
      (v) => api.post("/api/crm/visits", v).then((r) => r.data),
      (remaining) => {
        setPending(remaining);
        if (remaining === 0) load();
      },
    );
    return stop;
  }, []);

  useEffect(() => {
    if (!justLogged && !justReferred) return;
    const t = setTimeout(() => setParams({}, { replace: true }), 4000);
    return () => clearTimeout(t);
  }, [justLogged, justReferred, setParams]);

  const territories = useMemo(() => {
    const names = new Set((data?.my_doctors || []).map((d) => d.territory_name).filter(Boolean));
    return ["all", ...[...names].sort()];
  }, [data]);

  const doctors = useMemo(() => {
    let list = data?.my_doctors || [];
    if (territory !== "all") list = list.filter((d) => d.territory_name === territory);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((d) =>
        [d.full_name, d.specialty, d.area, d.city].some((v) => (v || "").toLowerCase().includes(q)),
      );
    }
    return list;
  }, [data, territory, query]);

  // Classifying 273 doctors one at a time is how a universe stays Unclassified
  // forever, so the bulk action sits on the filter the rep is already using.
  const classifyTerritory = async (priority) => {
    if (territory === "all") return;
    setClassifying(true);
    setBulkMsg(null);
    try {
      const { data: r } = await api.post("/api/crm/doctors/priority", { territory, priority });
      setBulkMsg(
        `${r.updated} doctor${r.updated === 1 ? "" : "s"} in ${territory} set to ${priority}`,
      );
      await load();
    } catch (e) {
      setBulkMsg(e?.response?.data?.error || "Could not update");
    } finally {
      setClassifying(false);
    }
  };

  if (err)
    return (
      <div className="rep">
        <div className="rep__err">{err}</div>
      </div>
    );
  if (!data)
    return (
      <div className="rep">
        <div className="rep__loading">Loading…</div>
      </div>
    );

  const p = data.performance;

  return (
    <div className="rep">
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

      <nav className="rep__tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`rep__tab ${tab === t.key ? "rep__tab--on" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "due" && (data.due_summary?.total ?? 0) > 0 && (
              <span className="rep__badge">{data.due_summary.total}</span>
            )}
            {t.key === "referrals" && (referrals?.summary?.open ?? 0) > 0 && (
              <span className="rep__badge">{referrals.summary.open}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "due" && (
        <ul className="rep__list">
          {data.due_visits.length === 0 && <Empty>Nobody is due. Good.</Empty>}
          {data.due_visits.map((d) => (
            <DoctorRow key={d.doctor_id} d={d} navigate={navigate} showDue />
          ))}
          {data.due_summary && data.due_summary.showing < data.due_summary.total && (
            <li className="rep__more">
              Showing the {data.due_summary.showing} most urgent of {data.due_summary.total} waiting
            </li>
          )}
        </ul>
      )}

      {tab === "referrals" && (
        <ul className="rep__list">
          {(referrals?.referrals?.length ?? 0) === 0 && (
            <Empty>No open referrals. Log one from a doctor's page.</Empty>
          )}
          {referrals?.referrals?.map((r) => (
            <li key={r.id} className="rep__row rep__row--stack">
              <div className="rep__row-main">
                <strong>{r.patient_name_raw || r.patient_phone_raw || "Unnamed patient"}</strong>
                <span className="rep__row-sub">
                  {r.referral_code} · from {r.doctor_name || "—"}
                  {r.service_line_name ? ` · ${r.service_line_name}` : ""}
                </span>
                <span className="rep__row-flags">
                  {r.urgency !== "routine" && (
                    <span className="rep__due rep__due--red">{urgencyLabel(r.urgency)}</span>
                  )}
                  <span className="rep__flag">{referralStatusLabel(r.status)}</span>
                </span>
              </div>
              <ReferralStatusControl referral={r} onChanged={load} />
            </li>
          ))}
        </ul>
      )}

      {tab === "today" && (
        <ul className="rep__list">
          {data.todays_visits.length === 0 && <Empty>No visits logged yet today.</Empty>}
          {data.todays_visits.map((v) => (
            <li key={v.id} className="rep__row">
              <div className="rep__row-main">
                <strong>{v.full_name}</strong>
                <span className="rep__row-sub">
                  {new Date(v.occurred_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {v.outcome ? ` · ${v.outcome.replace(/_/g, " ")}` : ""}
                  {v.area ? ` · ${v.area}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "doctors" && (
        <>
          <div className="rep__filters">
            <input
              className="rep__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, specialty, area"
            />
            <div className="rep__chips rep__chips--scroll">
              {territories.map((t) => (
                <button
                  key={t}
                  className={`rep__chip ${territory === t ? "rep__chip--on" : ""}`}
                  onClick={() => setTerritory(t)}
                >
                  {t === "all" ? "All" : t}
                </button>
              ))}
            </div>
            {territory !== "all" && (
              <div className="rep__bulk">
                <span className="rep__hint">
                  Set all {doctors.length} in {territory} to
                </span>
                {DOCTOR_PRIORITIES.filter((p) => p.value !== "unclassified").map((p) => (
                  <button
                    key={p.value}
                    className="rep__btn rep__btn--sm"
                    disabled={classifying}
                    onClick={() => classifyTerritory(p.value)}
                  >
                    {p.short}
                  </button>
                ))}
                {bulkMsg && <span className="rep__saved">{bulkMsg}</span>}
              </div>
            )}
          </div>
          <ul className="rep__list">
            {doctors.length === 0 && <Empty>No doctors match.</Empty>}
            {doctors.map((d) => (
              <DoctorRow key={d.doctor_id} d={d} navigate={navigate} />
            ))}
          </ul>
        </>
      )}

      {tab === "tasks" && (
        <ul className="rep__list">
          {data.tasks.length === 0 && <Empty>No open tasks.</Empty>}
          {data.tasks.map((t) => (
            <li key={t.id} className="rep__row">
              <div className="rep__row-main">
                <strong>{t.title}</strong>
                <span className="rep__row-sub">
                  {t.due_date ? `Due ${t.due_date}` : "No date"} · {t.priority}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="rep__perf">
        <span>
          {p.visits_month} visits this month · {p.unique_doctors_month} unique doctors ·{" "}
          {p.doctors_assigned} assigned
        </span>
        <Link to="/crm/import" className="rep__link">
          Import list
        </Link>
      </div>
    </div>
  );
}

function DoctorRow({ d, navigate, showDue }) {
  const due = d.due_state ? visitDueStateMeta(d.due_state) : null;
  const pri = doctorPriorityMeta(d.priority);
  return (
    <li className="rep__row">
      <div className="rep__row-main">
        <strong>
          <button className="rep__name" onClick={() => navigate(`/crm/doctor/${d.doctor_id}`)}>
            {d.full_name}
          </button>
          {pri && d.priority !== "unclassified" && (
            <span className={`rep__pri rep__pri--${pri.tone}`}>{pri.short}</span>
          )}
        </strong>
        <span className="rep__row-sub">
          {[d.specialty, d.area, d.territory_name].filter(Boolean).join(" · ") || "No details yet"}
        </span>
        <span className="rep__row-flags">
          {showDue && due && <span className={`rep__due rep__due--${due.tone}`}>{due.label}</span>}
          {d.profile_complete === false && <span className="rep__flag">No mobile</span>}
          {d.needs_verification && <span className="rep__flag">Check details</span>}
        </span>
      </div>
      <div className="rep__row-actions">
        {d.mobile && (
          <a className="rep__call" href={`tel:${d.mobile}`} aria-label={`Call ${d.full_name}`}>
            Call
          </a>
        )}
        <button
          className="rep__btn rep__btn--sm"
          onClick={() =>
            navigate(`/crm/referral/${d.doctor_id}?name=${encodeURIComponent(d.full_name)}`)
          }
        >
          Referral
        </button>
        <button
          className="rep__btn rep__btn--primary rep__btn--sm"
          onClick={() =>
            navigate(`/crm/visit/${d.doctor_id}?name=${encodeURIComponent(d.full_name)}`)
          }
        >
          Log visit
        </button>
      </div>
    </li>
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
