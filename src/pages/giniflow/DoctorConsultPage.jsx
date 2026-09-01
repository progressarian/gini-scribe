import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useConsult,
  useReleaseConsult,
  useSaveCarePlan,
  useDecideProposal,
} from "../../queries/hooks/useGiniflowDoctor";
import OverviewSection from "./consult/OverviewSection";
import LabsSection from "./consult/LabsSection";
import CarePlanSection from "./consult/CarePlanSection";
import ProposalsStrip from "./consult/ProposalsStrip";
import RxSection from "./consult/RxSection";
import TestsSection from "./consult/TestsSection";
import MedCardSection from "./consult/MedCardSection";
import FinalizeBar from "./consult/FinalizeBar";
import TrendModal from "./consult/TrendModal";
import "../../styles/giniflow-station.css";

// The consult screen — gini-doctor-final.html.
//
// One page with a section nav, not a wizard: a consultant re-reads the labs
// while editing the plan, and a wizard turns that into navigation. Deliberately
// unlike Scribe's /intake → … → /plan route sequence (plan §5.2).
//
// Sections live in ./consult/ — one file each, so this file stays the shell.

const CATEGORY_BADGE = {
  worse_out_of_range: { cls: "b-red", label: "🔴 Worse" },
  worse_in_range: { cls: "b-amb", label: "🟠 Watch" },
  getting_better: { cls: "b-amb", label: "🟡 Flag" },
  in_control: { cls: "b-grn", label: "✅ In control" },
  no_reports: { cls: "b-blu", label: "🔵 No reports" },
};

const NAV = [
  { id: "s-proposals", label: "🩺 MO proposed" },
  { id: "s-overview", label: "📋 Overview" },
  { id: "s-labs", label: "📊 Labs & graphs" },
  { id: "s-rx", label: "💊 Prescription" },
  { id: "s-tests", label: "🔬 Tests" },
  { id: "s-medcard", label: "🗒 Medicine card" },
  { id: "s-plan", label: "📝 Care plan" },
];

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "—";

export default function DoctorConsultPage() {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { data: consult, isLoading, isError } = useConsult(visitId);
  const releaseConsult = useReleaseConsult();
  const saveCarePlan = useSaveCarePlan(visitId);
  const decideProposal = useDecideProposal(visitId);
  const [trendMarker, setTrendMarker] = useState(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const onSavePlan = useCallback(
    (plan, done) =>
      saveCarePlan.mutate(plan, {
        onSuccess: () => done?.(),
        onError: (e) => showToast(e?.response?.data?.error || "Care plan not saved — try again"),
      }),
    [saveCarePlan],
  );

  const onDecide = (decision) =>
    decideProposal.mutate(decision, {
      onError: (e) => showToast(e?.response?.data?.error || "Decision not saved"),
    });

  if (isLoading) return <div className="gf gf-loading">Opening the consult…</div>;
  if (isError || !consult) return <div className="gf gf-loading">Consult unavailable.</div>;

  const badge = CATEGORY_BADGE[consult.category];
  const { summary } = consult.header;
  // A finalized visit is read-only — the log only moves forward, so a correction
  // is an addendum, never an edit (plan §9).
  const readOnly = consult.finalized;

  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  return (
    <div className="gf">
      <div className="top-rail">
        <button className="tr-back" onClick={() => navigate("/giniflow/station/doctor")}>
          ← Patients
        </button>
        <div className="tr-role" style={{ background: "var(--blu-l)", color: "var(--blu)" }}>
          🧑‍⚕️ Consult
        </div>
        <div className="tr-pt">
          <strong>{consult.name}</strong>
          <span>
            {consult.age}
            {(consult.sex || "")[0] || ""} · {consult.fileNo || "—"}
          </span>
        </div>
        <div className="rail-right">
          {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
          <span className={`badge ${readOnly ? "b-grn" : "b-blu"}`}>
            {readOnly ? "Finalized" : "Draft"}
          </span>
          {consult.inRoom && (
            <button
              className="tr-back"
              onClick={() =>
                releaseConsult.mutate(visitId, {
                  onSuccess: () => navigate("/giniflow/station/doctor"),
                  onError: (e) => showToast(e?.response?.data?.error || "Could not release"),
                })
              }
            >
              Step out
            </button>
          )}
        </div>
      </div>

      {/* One scroll region, as the prototype's #bodyScroll is: the top rail
          stays put and everything below it scrolls together. `.gf` is
          height:100vh/overflow:hidden, so a station screen that declares no
          scroll container simply clips. */}
      <div className="cscroll">
        {/* The identity strip: who worked this patient up, and the whole "why are
            they here" in one line (plan §5.1). */}
        <div className="chead">
          <div className="ch-line">
            <strong>{consult.name}</strong> · {consult.age}
            {(consult.sex || "")[0] || ""} · {consult.fileNo || "—"} · Visit{" "}
            {consult.visitNumber ?? "—"}
            {consult.sdName ? ` · ${consult.sdName} (SD)` : ""}
            {consult.doctorName ? ` · ${consult.doctorName}` : ""}
          </div>
          <div className="ch-tiles">
            <div className="cht">
              <span>Checked in</span>
              <strong>{clock(consult.checkedInAt)}</strong>
            </div>
            <div className="cht">
              <span>Last visit</span>
              <strong>{consult.header.lastVisitDate || "first visit"}</strong>
            </div>
            <div className="cht">
              <span>Reports</span>
              <strong>
                {consult.resultsStatus === "ready" ? "✓ ready" : consult.resultsStatus}
              </strong>
            </div>
            <div className="cht">
              <span>Compliance</span>
              <strong>
                {consult.header.compliancePct == null ? "—" : `${consult.header.compliancePct}%`}
              </strong>
            </div>
          </div>
          {/* The computed triage line — every tracked marker classified against
            its target. The most useful line on the screen. */}
          <div className="ch-sum">
            <span className="chs g">
              ✓ {summary.inControl.count} in control
              {summary.inControl.count ? ` — ${summary.inControl.markers.join(" · ")}` : ""}
            </span>
            <span className="chs r">
              ↑ {summary.worse.count} worse
              {summary.worse.count ? ` — ${summary.worse.markers.join(" · ")}` : ""}
            </span>
            <span className="chs a">
              ⚠ {summary.watch.count} watch
              {summary.watch.count ? ` — ${summary.watch.markers.join(" · ")}` : ""}
            </span>
          </div>
          {consult.blockedReason && <div className="ch-blocked">🚫 {consult.blockedReason}</div>}
        </div>

        <nav className="cnav">
          {NAV.map((n) => (
            <button type="button" key={n.id} onClick={() => jump(n.id)}>
              {n.label}
            </button>
          ))}
        </nav>

        <div className="cbody">
          <ProposalsStrip proposals={consult.proposals} onDecide={onDecide} readOnly={readOnly} />
          <OverviewSection consult={consult} onTile={setTrendMarker} />
          <LabsSection
            consult={consult}
            onTrend={(l) =>
              setTrendMarker({ key: l.test, label: l.test_name || l.test, unit: l.unit })
            }
          />
          <RxSection visitId={visitId} readOnly={readOnly} onToast={showToast} />
          <TestsSection
            visitId={visitId}
            consult={consult}
            readOnly={readOnly}
            onToast={showToast}
          />
          <MedCardSection visitId={visitId} onToast={showToast} />
          <CarePlanSection
            consult={consult}
            onSave={onSavePlan}
            saving={saveCarePlan.isPending}
            readOnly={readOnly}
          />

          {readOnly ? (
            <div className="fin-done">
              <strong>✓ Finalized</strong> — this consultation is read-only, because Gini
              Flow&apos;s log only moves forward.
              {/* CS-07: this used to promise "a correction is a new addendum".
                  There is no addendum path yet, and a screen that names a route
                  the consultant cannot take is worse than one that admits it. */}
              <span className="fin-gap">
                There is no addendum path yet — a correction to a finalized prescription has to be
                made in Scribe, on the patient&apos;s chart.
              </span>
            </div>
          ) : (
            <FinalizeBar
              visitId={visitId}
              onToast={showToast}
              onDone={(r) => {
                showToast(
                  `✓ Finalized — ${r.medicines} medicine${r.medicines === 1 ? "" : "s"} to the pharmacy`,
                );
                navigate("/giniflow/station/doctor");
              }}
            />
          )}
        </div>
      </div>

      {trendMarker && (
        <TrendModal visitId={visitId} marker={trendMarker} onClose={() => setTrendMarker(null)} />
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
