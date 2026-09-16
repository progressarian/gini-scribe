import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../../services/api.js";
import {
  DOCTOR_PRIORITIES,
  RELATIONSHIP_STAGES,
  visitDueStateMeta,
  visitTypeMeta,
  visitOutcomeMeta,
  referralStatusLabel,
  attributionStatusMeta,
} from "../../../shared/crmVocab.js";

// Doctor 360 (brief §8). Header, KPI cards, and one chronological record of the
// relationship.
//
// The timeline is the point. A rep walking back into a clinic six weeks later
// needs what was actually said last time — so a visit entry shows its notes in
// full, not a summary. Everything else on this page exists to frame that.

const rupees = (n) =>
  n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const when = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export default function Doctor360Page() {
  const { doctorId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api
        .get(`/api/crm/doctors/${doctorId}`)
        .then(({ data }) => setData(data))
        .catch((e) => setErr(e?.response?.data?.error || "Could not load this doctor")),
    [doctorId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const setPriority = async (priority) => {
    setSaving(true);
    try {
      await api.post("/api/crm/doctors/priority", { doctorIds: [doctorId], priority });
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || "Could not change the priority");
    } finally {
      setSaving(false);
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

  const d = data.doctor;
  const k = data.kpis || {};
  const due = d.due_state ? visitDueStateMeta(d.due_state) : null;

  return (
    <div className="rep d360">
      <header className="rep__bar">
        <button className="rep__back" onClick={() => navigate(-1)} aria-label="Back">
          ←
        </button>
        <div className="rep__bar-title">
          <strong>{d.full_name}</strong>
          <span>
            {[d.specialty, d.qualifications].filter(Boolean).join(" · ") || "No specialty recorded"}
          </span>
        </div>
      </header>

      <div className="d360__meta">
        {[d.clinic_name, d.address_line, d.area, d.territory_name].filter(Boolean).join(" · ") ||
          "No clinic recorded"}
      </div>

      <div className="d360__contact">
        {d.mobile ? (
          <a className="rep__call" href={`tel:${d.mobile}`}>
            Call {d.mobile}
          </a>
        ) : d.clinic_phone ? (
          <a className="rep__call" href={`tel:${d.clinic_phone}`}>
            Clinic {d.clinic_phone}
          </a>
        ) : (
          <span className="rep__flag">No number yet</span>
        )}
        <button
          className="rep__btn rep__btn--primary rep__btn--sm"
          onClick={() => navigate(`/crm/visit/${d.id}?name=${encodeURIComponent(d.full_name)}`)}
        >
          Log visit
        </button>
      </div>

      <div className="d360__flags">
        {due && <span className={`rep__due rep__due--${due.tone}`}>{due.label}</span>}
        {d.executive_name && <span className="rep__flag">Owned by {d.executive_name}</span>}
        <span className="rep__flag">
          {RELATIONSHIP_STAGES.find((s) => s.value === d.relationship_stage)?.label ||
            d.relationship_stage}
        </span>
        {d.needs_verification && (
          <span className="rep__flag" title={d.verification_note || ""}>
            Check details
          </span>
        )}
        {d.missing_fields?.length > 0 && (
          <span className="rep__flag">Missing: {d.missing_fields.join(", ")}</span>
        )}
      </div>

      <section className="d360__section">
        <span className="rep__label">Priority</span>
        <div className="rep__chips">
          {DOCTOR_PRIORITIES.map((p) => (
            <button
              key={p.value}
              className={`rep__chip ${d.priority === p.value ? "rep__chip--on" : ""}`}
              disabled={saving}
              onClick={() => setPriority(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <div className="d360__kpis">
        <Kpi label="Potential / mo" value={rupees(d.estimated_monthly_potential_inr)} />
        <Kpi label="Revenue MTD" value={rupees(k.revenue_mtd_inr)} />
        <Kpi label="Revenue YTD" value={rupees(k.revenue_ytd_inr)} />
        <Kpi label="Referrals MTD" value={k.referrals_mtd ?? 0} />
        <Kpi label="Admissions MTD" value={k.admissions_mtd ?? 0} />
        <Kpi
          label="Conversion"
          value={k.conversion_rate_pct == null ? "—" : `${k.conversion_rate_pct}%`}
        />
        <Kpi label="Visits" value={data.counts.visits} />
        <Kpi
          label="Last referral"
          value={k.last_referral_at ? when(k.last_referral_at) : "None yet"}
        />
      </div>

      <section className="d360__section">
        <span className="rep__label">Timeline</span>
        {data.timeline.length === 0 && (
          <p className="rep__hint">Nothing recorded yet. A logged visit appears here.</p>
        )}
        <ol className="d360__timeline">
          {data.timeline.map((e, i) => (
            <li key={`${e.kind}-${e.id || i}`} className={`d360__event d360__event--${e.kind}`}>
              <div className="d360__event-head">
                <span className="d360__event-date">{when(e.at)}</span>
                <span className="d360__event-kind">{labelFor(e)}</span>
              </div>
              {e.kind === "visit" && <VisitBody v={e} />}
              {e.kind === "referral" && <ReferralBody r={e} />}
              {e.kind === "task" && <div className="d360__event-body">{e.title}</div>}
              {e.kind === "stage" && (
                <div className="d360__event-body">
                  {e.from_stage ? `${e.from_stage} → ${e.to_stage}` : `Set to ${e.to_stage}`}
                  {e.reason ? ` — ${e.reason}` : ""}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function labelFor(e) {
  if (e.kind === "visit") return visitTypeMeta(e.visit_type)?.label || "Visit";
  if (e.kind === "referral") return "Referral";
  if (e.kind === "task") return "Task done";
  return "Stage change";
}

// A visit shows everything the rep wrote. This is the one place the field notes
// are read back, so nothing is truncated or summarised away.
function VisitBody({ v }) {
  const outcome = v.outcome ? visitOutcomeMeta(v.outcome) : null;
  const extras = [
    ["Requirements", v.doctor_requirements],
    ["Objections", v.objections],
    ["Opportunities", v.opportunities_identified],
    ["Commitments", v.commitments],
  ].filter(([, val]) => val);

  return (
    <div className="d360__event-body">
      <div className="d360__event-tags">
        {v.purpose && <span className="d360__tag">{v.purpose}</span>}
        {outcome && <span className={`d360__tag d360__tag--${outcome.tone}`}>{outcome.label}</span>}
        {v.executive_name && <span className="d360__tag">{v.executive_name}</span>}
        {v.has_gps && <span className="d360__tag">📍</span>}
      </div>
      {v.discussion_notes ? (
        <p className="d360__notes">{v.discussion_notes}</p>
      ) : (
        <p className="d360__notes d360__notes--none">No notes written.</p>
      )}
      {extras.map(([label, val]) => (
        <p key={label} className="d360__extra">
          <strong>{label}:</strong> {val}
        </p>
      ))}
      {v.follow_up_required && (
        <p className="d360__extra">
          <strong>Follow-up</strong>
          {v.next_visit_date ? ` by ${v.next_visit_date}` : ""}
        </p>
      )}
    </div>
  );
}

function ReferralBody({ r }) {
  const attr = attributionStatusMeta(r.attribution_status);
  return (
    <div className="d360__event-body">
      <div className="d360__event-tags">
        <span className="d360__tag">{r.referral_code}</span>
        <span className="d360__tag">{referralStatusLabel(r.status)}</span>
        {attr && <span className={`d360__tag d360__tag--${attr.tone}`}>{attr.short}</span>}
      </div>
      {r.patient_name_raw && <p className="d360__notes">{r.patient_name_raw}</p>}
    </div>
  );
}

function Kpi({ label, value }) {
  return (
    <div className="d360__kpi">
      <span className="d360__kpi-v">{value}</span>
      <span className="d360__kpi-l">{label}</span>
    </div>
  );
}
