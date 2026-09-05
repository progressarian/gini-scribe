import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutationState } from "@tanstack/react-query";
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
import { usePrescription, visitWriteKey } from "../../queries/hooks/useGiniflowPrescription";
import FastPathBar from "./consult/FastPathBar";
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

// What a section can still be holding that no request has taken yet. The draft
// itself is safe — every Rx edit and the care plan are already written — so the
// guard is only about these three, and it names them rather than asking "are you
// sure?" about nothing in particular.
const UNSAVED_LABEL = {
  rx: "a medicine editor is still open",
  add: "a medicine has been filled in but not added",
  tests: "tests are selected but not ordered",
};

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
  const { data: draft } = usePrescription(visitId);
  const { data: consult, isLoading, isError } = useConsult(visitId);
  const releaseConsult = useReleaseConsult();
  const saveCarePlan = useSaveCarePlan(visitId);
  const decideProposal = useDecideProposal(visitId);
  const [trendMarker, setTrendMarker] = useState(null);
  const [toast, setToast] = useState("");
  const [unsaved, setUnsaved] = useState({});
  const [confirmLeave, setConfirmLeave] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const toastTimer = useRef(null);
  const flushCarePlan = useRef(null);

  const markUnsaved = useCallback(
    (key, on) => setUnsaved((u) => (!!u[key] === !!on ? u : { ...u, [key]: !!on })),
    [],
  );
  const pendingWork = useMemo(
    () => Object.keys(unsaved).filter((k) => unsaved[k] && UNSAVED_LABEL[k]),
    [unsaved],
  );

  // When this visit's draft was last written to, by any section. The care plan
  // and every prescription edit share one mutation key for exactly this.
  const writeTimes = useMutationState({
    filters: { mutationKey: visitWriteKey(visitId), status: "success" },
    select: (m) => m.state.submittedAt,
  });
  const newestWrite = writeTimes.length ? Math.max(...writeTimes) : null;
  useEffect(() => {
    if (newestWrite) setLastSavedAt(newestWrite);
  }, [newestWrite]);

  // Closing the tab is the one exit the app cannot finish work for, so it is
  // the one exit that asks the browser to warn.
  useEffect(() => {
    if (!pendingWork.length) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingWork.length]);

  const leave = (action) => (pendingWork.length ? setConfirmLeave(() => action) : action());

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
  //
  // So is another consultant's patient. The queue's "Waiting for another
  // consultant" column exists so the floor can be seen whole, and opening one
  // from there is expected; writing to it is not. The server decides which it
  // is and refuses the writes either way — this only keeps the page from
  // offering an action that would come back 403.
  const otherConsultant = !!consult.readOnly;
  const readOnly = consult.finalized || otherConsultant;

  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  return (
    <div className="gf">
      <div className="top-rail">
        <button
          className="tr-back"
          onClick={() => leave(() => navigate("/giniflow/station/doctor"))}
        >
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
          <span
            className={`badge ${otherConsultant ? "b-amb" : readOnly ? "b-grn" : "b-blu"}`}
            title={
              otherConsultant
                ? `${consult.readOnlyOwner || "Another consultant"} is assigned to this patient`
                : undefined
            }
          >
            {otherConsultant
              ? `👁 Read-only · ${consult.readOnlyOwner || "another consultant"}'s patient`
              : readOnly
                ? "Finalized"
                : lastSavedAt
                  ? `Draft · saved ${clock(lastSavedAt)}`
                  : "Draft"}
          </span>
          {/* "Step out" read as walking away from the work. Nothing is lost —
              the draft is written as it is made, and leaving flushes what the
              care plan's autosave has not sent yet — so the button says so. */}
          {consult.inRoom && !otherConsultant && (
            <button
              className="tr-back"
              onClick={() =>
                leave(() => {
                  flushCarePlan.current?.();
                  releaseConsult.mutate(visitId, {
                    onSuccess: () => navigate("/giniflow/station/doctor"),
                    onError: (e) => showToast(e?.response?.data?.error || "Could not release"),
                  });
                })
              }
            >
              Save &amp; step out
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
          {/* Not on a read-only consult. These four answer "how is this visit
              running" — the arrival clock, whether results are in, whether the
              patient kept to the plan — and they are the assigned consultant's
              to act on. A colleague reading the floor needs to know who the
              patient is and where their markers stand, not to be handed
              somebody else's running visit to judge. */}
          {!otherConsultant && (
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
          )}
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
          {/* An addition, not a replacement: everything below still renders. */}
          {!readOnly && (
            <FastPathBar
              visitId={visitId}
              consult={consult}
              draft={draft}
              onDone={(r) => {
                showToast(
                  `✓ Finished — ${r.medicines} medicine${r.medicines === 1 ? "" : "s"} to the pharmacy${
                    r.testsRepeated?.length
                      ? `, ${r.testsRepeated.length} tests at the next visit`
                      : ""
                  }`,
                );
                navigate("/giniflow/station/doctor");
              }}
              onToast={showToast}
            />
          )}
          <ProposalsStrip
            proposals={consult.proposals}
            draftItems={draft?.items || []}
            onDecide={onDecide}
            readOnly={readOnly}
          />
          <OverviewSection consult={consult} onTile={setTrendMarker} />
          <LabsSection
            consult={consult}
            onTrend={(l) =>
              setTrendMarker({ key: l.test, label: l.test_name || l.test, unit: l.unit })
            }
          />
          <RxSection
            visitId={visitId}
            readOnly={readOnly}
            onToast={showToast}
            onUnsaved={markUnsaved}
          />
          <TestsSection
            visitId={visitId}
            consult={consult}
            readOnly={readOnly}
            onToast={showToast}
            onUnsaved={markUnsaved}
          />
          <MedCardSection visitId={visitId} onToast={showToast} />
          <CarePlanSection
            consult={consult}
            visitId={visitId}
            onToast={showToast}
            flushRef={flushCarePlan}
            onSave={onSavePlan}
            saving={saveCarePlan.isPending}
            readOnly={readOnly}
          />

          {otherConsultant ? (
            <div className="fin-done">
              <strong>👁 Read-only</strong> — {consult.readOnlyOwner || "another consultant"} is
              assigned to this patient. You are seeing their consult so the floor can be read whole;
              only the assigned consultant can write to it.
            </div>
          ) : readOnly ? (
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
      {confirmLeave && (
        <div className="modal-back" onClick={() => setConfirmLeave(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Leave with work in hand?</h3>
            <p className="modal-body">
              The draft is saved — every medicine already in the list and the care plan are kept and
              will be here when you come back. What is not saved:
              <span className="fin-gap">
                {pendingWork.map((k) => UNSAVED_LABEL[k]).join(" · ")}.
              </span>
            </p>
            <div className="modal-acts">
              <button className="st-btn st-btn-g" onClick={() => setConfirmLeave(null)}>
                Stay
              </button>
              <button
                className="st-btn st-btn-grn"
                onClick={() => {
                  const go = confirmLeave;
                  setConfirmLeave(null);
                  go();
                }}
              >
                Leave anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
