import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "../services/api";
import { qk } from "../queries/keys";
import {
  BarList,
  DataTable,
  Legend,
  Notes,
  Sparkline,
  StackedShare,
  StatRow,
  StatTile,
  fmt,
  pctText,
} from "../components/analytics/AnalyticsCharts";
import "./AnalyticsPage.css";

const SECTIONS = [
  { id: "overview", label: "Panel & retention" },
  { id: "conditions", label: "Conditions" },
  { id: "biomarkers", label: "Outcomes" },
  { id: "treatment", label: "Prescribing" },
  { id: "drug-outcomes", label: "GLP-1 results" },
  { id: "data-quality", label: "Data quality" },
  { id: "worklists", label: "Act on" },
];

const CONTROL_SEGMENTS = [
  { key: "at_goal", label: "At goal", color: "var(--an-good)" },
  { key: "borderline", label: "Borderline", color: "var(--an-warning)" },
  { key: "off_goal", label: "Off goal", color: "var(--an-critical)" },
];

const TRAJECTORY_SEGMENTS = [
  { key: "improving", label: "Improving", color: "var(--an-good)" },
  { key: "stable", label: "Stable", color: "var(--an-muted)" },
  { key: "worsening", label: "Worsening", color: "var(--an-critical)" },
];

const signed = (v, d = 2) => {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
};

function useSection(id) {
  return useQuery({
    queryKey: qk.analytics.section(id),
    queryFn: async () => (await api.get(`/api/analytics/sections/${id}`)).data,
    staleTime: 10 * 60 * 1000,
  });
}

function Loading() {
  return <p className="an-empty">Loading…</p>;
}

function Failed({ error }) {
  return (
    <p className="an-empty">
      Could not load this section.{" "}
      {error?.response?.status === 403 ? "You do not have analytics access." : ""}
    </p>
  );
}

function Overview() {
  const { data, isLoading, isError, error } = useSection("overview");
  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;
  const reg = data.s1_registry;
  const ret = data.s3_retention;
  const k = reg.kpis;

  return (
    <>
      <StatRow>
        <StatTile
          value={fmt(k.registered_patients)}
          label="Registered patients"
          note="all records"
        />
        <StatTile
          value={fmt(k.patients_with_visit)}
          label="With a recorded visit"
          note={`${fmt(k.patients_without_visit)} have none`}
        />
        <StatTile
          value={fmt(k.continuing_patients)}
          label="Continuing"
          note={`${pctText(k.continuing_share_pct)} of those with a visit`}
          tone="good"
        />
        <StatTile
          value={fmt(k.lapsed_patients)}
          label="Lapsed"
          note="no visit in 6 months"
          tone="bad"
        />
        <StatTile
          value={pctText(ret.attendance.no_show_rate_pct)}
          label="No-show rate"
          note="booked appointments"
        />
        <StatTile value={fmt(ret.intervals.intervals.median)} label="Median days between visits" />
      </StatRow>

      <h3>Panel growth</h3>
      <div className="an-card">
        <Sparkline
          points={reg.growth.map((g) => g.cumulative)}
          labels={reg.growth.map((g) => g.quarter)}
        />
        <p className="an-cap">
          Cumulative patients, by the quarter of each patient&apos;s first visit
        </p>
      </div>

      <h3>Patients seen each month</h3>
      <div className="an-card">
        <Sparkline
          points={reg.visit_volume.map((v) => v.patients)}
          labels={reg.visit_volume.map((v) => v.month)}
          color="var(--an-series-2)"
        />
      </div>

      <h3>Time since last visit</h3>
      <div className="an-card">
        <BarList rows={reg.recency.map((r) => ({ label: r.band, value: r.patients }))} />
      </div>

      <h3>Retention by joining cohort</h3>
      <DataTable
        columns={[
          { label: "Joining quarter", key: "cohort" },
          { label: "Cohort size", get: (r) => fmt(r.size) },
          { label: "Returned within 180 days", get: (r) => pctText(r.retained_180d_pct) },
          { label: "Returned within a year", get: (r) => pctText(r.retained_365d_pct) },
          { label: "Still attending", get: (r) => pctText(r.still_active_pct) },
        ]}
        rows={ret.retention_curve}
      />
      <Notes items={reg.notes} />
    </>
  );
}

function Conditions() {
  const { data, isLoading, isError, error } = useSection("conditions");
  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;
  const s = data.s2_conditions;

  return (
    <>
      <h3>Patients per condition</h3>
      <div className="an-card">
        <BarList
          rows={s.prevalence.slice(0, 12).map((p) => ({ label: p.condition, value: p.patients }))}
        />
      </div>
      <DataTable
        columns={[
          { label: "Condition", key: "condition" },
          { label: "Patients", get: (r) => fmt(r.patients) },
          { label: "Share of panel", get: (r) => pctText(r.share_of_panel_pct) },
          { label: "Continuing", get: (r) => fmt(r.continuing) },
          { label: "Continuing %", get: (r) => pctText(r.continuing_pct) },
          { label: "Lapsed", get: (r) => fmt(r.lapsed) },
          { label: "Mean age", get: (r) => fmt(r.mean_age) },
        ]}
        rows={s.prevalence}
      />

      <h3>Complication burden among diabetic patients</h3>
      <StatRow>
        <StatTile
          value={pctText(s.complications.any_complication_pct)}
          label="Have at least one complication"
          note={`${fmt(s.complications.any_complication)} of ${fmt(s.complications.eligible_denominator)} recently seen`}
          tone="bad"
        />
      </StatRow>
      <DataTable
        columns={[
          { label: "Complication", key: "complication" },
          { label: "Patients", get: (r) => fmt(r.patients_affected) },
          { label: "Crude rate", get: (r) => pctText(r.crude_rate_pct) },
          { label: "Adjusted rate", get: (r) => <strong>{pctText(r.adjusted_rate_pct)}</strong> },
          { label: "Adjusted denominator", get: (r) => fmt(r.eligible_denominator) },
          { label: "Recorded from", get: (r) => r.capture_start || "—" },
        ]}
        rows={s.complications.rows}
      />
      <Notes items={s.complications.notes} tone="warn" />

      <h3>Conditions per patient</h3>
      <div className="an-card">
        <BarList
          rows={s.comorbidity.burden.map((b) => ({ label: b.bucket, value: b.patients }))}
          color="var(--an-series-3)"
        />
      </div>
    </>
  );
}

function Biomarkers() {
  const { data, isLoading, isError, error } = useSection("biomarkers");
  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;
  const s = data.s4_biomarkers;
  const controlRows = s.control.filter((r) => r.at_goal_pct != null);
  const trajRows = s.control.filter((r) => r.patients_paired >= 200);

  return (
    <>
      <h3>The diabetes control cascade</h3>
      <div className="an-card">
        <BarList
          rows={s.cascade.steps.map((st) => ({ label: st.step, value: st.patients }))}
          valueFormat={(v) => fmt(v)}
        />
        <p className="an-cap">Each step is a subset of the one above it</p>
      </div>
      <StatRow>
        {s.cascade.control_bands.map((b) => (
          <StatTile
            key={b.band}
            value={pctText(b.share_pct)}
            label={b.band}
            note={`${fmt(b.patients)} of ${fmt(s.cascade.current_denominator)} recently tested`}
            tone={
              b.band.startsWith("Under 7") ? "good" : b.band.startsWith("9%") ? "bad" : undefined
            }
          />
        ))}
      </StatRow>
      <Notes items={s.cascade.notes} />

      <h3>Where patients stand against target</h3>
      <div className="an-card">
        <Legend items={CONTROL_SEGMENTS} />
        <StackedShare rows={controlRows} segments={CONTROL_SEGMENTS} />
      </div>

      <h3>Direction of travel</h3>
      <div className="an-card">
        <Legend items={TRAJECTORY_SEGMENTS} />
        <StackedShare rows={trajRows} segments={TRAJECTORY_SEGMENTS} />
      </div>

      <h3>All markers</h3>
      <DataTable
        columns={[
          { label: "Marker", key: "label" },
          { label: "Ever tested", get: (r) => fmt(r.patients_any) },
          { label: "Tested in 12m", get: (r) => fmt(r.patients_current) },
          { label: "At goal", get: (r) => pctText(r.at_goal_pct) },
          { label: "Off goal", get: (r) => pctText(r.off_goal_pct) },
          { label: "Trendable", get: (r) => fmt(r.patients_paired) },
          { label: "Improving", get: (r) => pctText(r.improving_pct) },
          { label: "Worsening", get: (r) => pctText(r.worsening_pct) },
        ]}
        rows={s.control}
      />

      <h3>Continuing patients versus lapsed patients</h3>
      <p className="an-lede">
        Patients who stopped attending are in worse control on every headline marker.
      </p>
      <DataTable
        columns={[
          { label: "Marker", key: "marker" },
          { label: "Group", get: (r) => (r.group === "continuing" ? "Continuing" : "Lapsed") },
          { label: "Patients", get: (r) => fmt(r.patients) },
          { label: "At goal", get: (r) => pctText(r.at_goal_pct) },
          { label: "Off goal", get: (r) => pctText(r.off_goal_pct) },
          { label: "Median", get: (r) => r.median ?? "—" },
        ]}
        rows={s.by_continuity}
      />
    </>
  );
}

function Treatment() {
  const { data, isLoading, isError, error } = useSection("treatment");
  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;
  const s = data.s5_treatment;

  return (
    <>
      <h3>Prescribing across the panel</h3>
      <div className="an-card">
        <BarList
          rows={s.landscape.classes
            .slice(0, 14)
            .map((c) => ({ label: c.drug_class, value: c.patients_ever }))}
        />
      </div>
      <DataTable
        columns={[
          { label: "Drug class", key: "drug_class" },
          { label: "Ever prescribed", get: (r) => fmt(r.patients_ever) },
          { label: "Currently active", get: (r) => fmt(r.patients_active) },
          { label: "Share of panel", get: (r) => pctText(r.share_of_panel_pct) },
        ]}
        rows={s.landscape.classes}
      />

      <h3>Diabetes treatment intensity</h3>
      <div className="an-card">
        <BarList
          rows={s.regimen.intensity.map((i) => ({ label: i.bucket, value: i.patients }))}
          color="var(--an-series-2)"
        />
      </div>

      <h3>Gaps against standard guidance</h3>
      <p className="an-lede">
        Patients who meet the clinical trigger but have no matching active prescription recorded.
      </p>
      <div className="an-card">
        <BarList
          rows={s.gaps.map((g) => ({
            label: g.gap,
            value: g.gap_rate_pct,
            color: "var(--an-critical)",
          }))}
          valueFormat={(v) => `${v}%`}
        />
      </div>
      <DataTable
        columns={[
          { label: "Gap", key: "gap" },
          { label: "Eligible", get: (r) => fmt(r.eligible_patients) },
          { label: "With gap", get: (r) => fmt(r.patients_with_gap) },
          { label: "Gap rate", get: (r) => <strong>{pctText(r.gap_rate_pct)}</strong> },
        ]}
        rows={s.gaps}
      />
    </>
  );
}

function DrugOutcomes() {
  const { data, isLoading, isError, error } = useSection("drug-outcomes");
  const [window, setWindow] = useState("m6");
  const s = data?.s6_drug_outcomes;

  const a1c = useMemo(
    () =>
      s
        ? s.outcomes.filter((r) => r.marker === "hba1c" && r.window === window && r.paired_n >= 10)
        : [],
    [s, window],
  );
  const weight = useMemo(
    () =>
      s
        ? s.outcomes.filter((r) => r.marker === "weight" && r.window === window && r.paired_n >= 10)
        : [],
    [s, window],
  );

  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;

  return (
    <>
      <div className="an-filters">
        <label htmlFor="an-window">Follow-up window</label>
        <select id="an-window" value={window} onChange={(e) => setWindow(e.target.value)}>
          <option value="m3">3 months</option>
          <option value="m6">6 months</option>
          <option value="m12">12 months</option>
        </select>
      </div>

      <h3>HbA1c response</h3>
      <div className="an-card">
        <BarList
          rows={[...a1c]
            .sort((x, y) => x.change.mean - y.change.mean)
            .map((r) => ({
              label: r.cohort_label,
              value: Math.abs(r.change.mean),
            }))}
          valueFormat={(v) => `-${v.toFixed(2)}`}
        />
        <p className="an-cap">Mean fall in HbA1c, percentage points. Longer is better.</p>
      </div>
      <DataTable
        columns={[
          { label: "Cohort", key: "cohort_label" },
          { label: "Paired n", get: (r) => <strong>{fmt(r.paired_n)}</strong> },
          { label: "Baseline", get: (r) => r.baseline.mean },
          { label: "Follow-up", get: (r) => r.followup.mean },
          {
            label: "Mean change",
            get: (r) => signed(r.change.mean),
            className: (r) => (r.change.mean < 0 ? "pos" : "neg"),
          },
          { label: "Reached under 7%", get: (r) => pctText(r.reached_under_7_rate) },
          { label: "Fell 1%+", get: (r) => pctText(r.drop_ge_1pct_rate) },
        ]}
        rows={a1c}
      />

      <h3>Weight response</h3>
      <DataTable
        columns={[
          { label: "Cohort", key: "cohort_label" },
          { label: "Paired n", get: (r) => <strong>{fmt(r.paired_n)}</strong> },
          { label: "Baseline kg", get: (r) => r.baseline.mean },
          {
            label: "Mean change kg",
            get: (r) => signed(r.change.mean),
            className: (r) => (r.change.mean < 0 ? "pos" : "neg"),
          },
          { label: "Mean % change", get: (r) => signed(r.pct_change.mean, 1) },
          { label: "Lost 5%+", get: (r) => pctText(r.loss_ge_5pct_rate) },
          { label: "Lost 10%+", get: (r) => pctText(r.loss_ge_10pct_rate) },
        ]}
        rows={weight}
      />

      <h3>How much to trust these numbers</h3>
      <p className="an-lede">
        The same cohort and outcome, recomputed under different definitions of when treatment
        started. A wide spread means the headline figure is a range, not a point.
      </p>
      <DataTable
        columns={[
          { label: "Cohort", key: "cohort_label" },
          { label: "Start-date definition", key: "stratum_label" },
          { label: "Paired n", get: (r) => fmt(r.paired_n) },
          { label: "Mean change kg", get: (r) => signed(r.mean_change) },
          { label: "Mean % change", get: (r) => signed(r.mean_pct_change, 1) },
          { label: "Lost 5%+", get: (r) => pctText(r.responder_rate_pct) },
        ]}
        rows={s.sensitivity_weight.rows}
      />
      <Notes items={s.sensitivity_weight.notes} tone="warn" />

      <h3>Staying on treatment</h3>
      <DataTable
        columns={[
          { label: "Cohort", key: "cohort_label" },
          { label: "Patients", get: (r) => fmt(r.patients) },
          { label: "Still on drug", get: (r) => pctText(r.still_on_drug_pct) },
          { label: "Discontinued", get: (r) => fmt(r.discontinued) },
          { label: "Median days on drug", get: (r) => fmt(r.time_on_drug_days.median) },
        ]}
        rows={s.persistence}
      />
      <Notes items={s.notes} tone="warn" />
    </>
  );
}

function DataQuality() {
  const { data, isLoading, isError, error } = useSection("data-quality");
  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;
  const s = data.s7_data_quality;

  return (
    <>
      <h3>Coverage</h3>
      <div className="an-card">
        <BarList rows={s.coverage_funnel.map((f) => ({ label: f.step, value: f.patients }))} />
      </div>
      <StatRow>
        <StatTile
          value={pctText(s.identity.dob_missing_pct)}
          label="Missing date of birth"
          note={fmt(s.identity.dob_missing)}
        />
        <StatTile
          value={pctText(s.identity.sex_unspecified_pct)}
          label="Sex not recorded"
          note={fmt(s.identity.sex_unspecified)}
        />
        <StatTile
          value={pctText(s.identity.health_id_missing_pct)}
          label="No stable health ID"
          note={fmt(s.identity.health_id_missing)}
        />
        <StatTile
          value={fmt(s.identity.duplicate_name_phone_groups)}
          label="Possible duplicate identities"
          note="same name and phone"
        />
      </StatRow>

      <h3>Legacy derived tables</h3>
      <p className="an-lede">
        These look like analytics but nothing refreshes them and no code reads them. This page does
        not use them.
      </p>
      <DataTable
        columns={[
          { label: "Table", key: "table" },
          { label: "Rows", get: (r) => fmt(r.rows) },
          { label: "Newest record", get: (r) => r.newest_record || "unknown" },
        ]}
        rows={s.legacy_tables}
      />

      <h3>Drug names the classifier could not resolve</h3>
      <DataTable
        columns={[
          { label: "Recorded name", key: "name" },
          { label: "Rows", get: (r) => fmt(r.rows) },
          { label: "Patients", get: (r) => fmt(r.patients) },
        ]}
        rows={s.unmatched_drugs}
        maxRows={30}
      />
      <Notes items={s.notes} />
    </>
  );
}

function Worklists() {
  const { data, isLoading, isError, error } = useSection("worklists");
  if (isLoading) return <Loading />;
  if (isError) return <Failed error={error} />;
  const s = data.s8_worklists;

  return (
    <>
      <p className="an-lede">
        These lists identify patients by internal ID and file number only. No names or contact
        details are shown here.
      </p>

      <h3>
        Lapsed patients with uncontrolled diabetes ({fmt(s.lapsed_uncontrolled_diabetics.length)})
      </h3>
      <DataTable
        columns={[
          { label: "Patient ID", key: "patient_id" },
          { label: "File no", key: "file_no" },
          { label: "Age", get: (r) => fmt(r.age) },
          { label: "Last HbA1c", get: (r) => r.last_hba1c },
          { label: "Measured", key: "last_hba1c_date" },
          { label: "Last visit", key: "last_visit" },
          { label: "Days since", get: (r) => fmt(r.days_since_visit) },
        ]}
        rows={s.lapsed_uncontrolled_diabetics}
        maxRows={50}
      />

      <h3>On a GLP-1 with no follow-up measurement ({fmt(s.glp1_without_followup.length)})</h3>
      <DataTable
        columns={[
          { label: "Patient ID", key: "patient_id" },
          { label: "File no", key: "file_no" },
          { label: "Recorded start", key: "index_date" },
          { label: "Still on drug", get: (r) => (r.still_on_drug ? "Yes" : "No") },
          { label: "Follow-up HbA1c", get: (r) => (r.has_followup_hba1c ? "Yes" : "No") },
          { label: "Follow-up weight", get: (r) => (r.has_followup_weight ? "Yes" : "No") },
        ]}
        rows={s.glp1_without_followup}
        maxRows={50}
      />

      <h3>Deteriorating on a headline marker ({fmt(s.worsening_tier1.length)})</h3>
      <DataTable
        columns={[
          { label: "Patient ID", key: "patient_id" },
          { label: "File no", key: "file_no" },
          { label: "Marker", key: "marker" },
          { label: "First", get: (r) => r.first_value },
          { label: "Latest", get: (r) => r.latest_value },
          { label: "Change", get: (r) => signed(r.change), className: () => "neg" },
          { label: "Still attending", get: (r) => (r.continuing ? "Yes" : "No") },
        ]}
        rows={s.worsening_tier1}
        maxRows={50}
      />
    </>
  );
}

const RENDERERS = {
  overview: Overview,
  conditions: Conditions,
  biomarkers: Biomarkers,
  treatment: Treatment,
  "drug-outcomes": DrugOutcomes,
  "data-quality": DataQuality,
  worklists: Worklists,
};

export default function AnalyticsPage() {
  const [active, setActive] = useState("overview");
  const [downloading, setDownloading] = useState(false);

  const { data: meta } = useQuery({
    queryKey: qk.analytics.meta(),
    queryFn: async () => (await api.get("/api/analytics/meta")).data,
    staleTime: 5 * 60 * 1000,
  });

  const download = async (kind) => {
    setDownloading(true);
    try {
      const res = await api.get(`/api/analytics/export.${kind}`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gini-outcomes-${meta?.snapshot?.as_of || "latest"}.${kind}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const Renderer = RENDERERS[active];

  return (
    <div className="an-page">
      <header className="an-head">
        <div>
          <h1>Population analytics</h1>
          <p className="an-sub">
            {meta?.snapshot
              ? `Data as at ${meta.snapshot.as_of}, built ${new Date(meta.snapshot.generated_at).toLocaleString()}`
              : "No snapshot has been built yet — showing a live computation."}
            {meta?.stale ? " · this snapshot is over a day old" : ""}
          </p>
        </div>
        <div className="an-actions">
          <button type="button" onClick={() => download("xlsx")} disabled={downloading}>
            {downloading ? "Preparing…" : "Download workbook"}
          </button>
          <button type="button" onClick={() => download("html")} disabled={downloading}>
            Download full report
          </button>
        </div>
      </header>

      <nav className="an-nav" aria-label="Analytics sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={active === s.id ? "is-active" : ""}
            aria-current={active === s.id ? "page" : undefined}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="an-body">
        <Renderer />
      </div>
    </div>
  );
}
