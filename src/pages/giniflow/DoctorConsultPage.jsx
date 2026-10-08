import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  useConsult,
  useReleaseConsult,
  useSaveCarePlan,
  useDecideProposal,
} from "../../queries/hooks/useGiniflowDoctor";
import OverviewSection from "./consult/OverviewSection";
import ComplaintsSection from "./consult/ComplaintsSection";
import AdviceSection from "./consult/AdviceSection";
import LabsSection from "./consult/LabsSection";
import CarePlanSection from "./consult/CarePlanSection";
import { usePrescription, visitWriteKey } from "../../queries/hooks/useGiniflowPrescription";
import FastPathBar from "./consult/FastPathBar";
import ProposalsStrip from "./consult/ProposalsStrip";
import RxSection from "./consult/RxSection";
import TestsSection from "./consult/TestsSection";
import ProceduresSection from "./consult/ProceduresSection";
import MedCardSection from "./consult/MedCardSection";
import FinalizeBar from "./consult/FinalizeBar";
import TrendModal from "./consult/TrendModal";
import "../../styles/giniflow-station.css";
import StabilityChip from "../../components/giniflow/StabilityChip";
import { clearDraftFields, readDraft, writeDraftNav } from "../../lib/consultDraft";
import { fetchPrintableRx, printRxHref } from "../../queries/hooks/useGiniflowRx";
import PdfViewerModal from "../../components/visit/PdfViewerModal";
import useFullscreen from "../../hooks/useFullscreen";
import FullscreenButton from "../../components/giniflow/FullscreenButton";

// The consult screen — gini-doctor-final.html.
//
// One page with a section nav, not a wizard: a consultant re-reads the labs
// while editing the plan, and a wizard turns that into navigation. Deliberately
// unlike Scribe's /intake → … → /plan route sequence (plan §5.2).
//
// Sections live in ./consult/ — one file each, so this file stays the shell.

const CATEGORY_BADGE = {
  worse_out_of_range: { cls: "b-red", label: "🔴 HbA1c: Worse" },
  worse_in_range: { cls: "b-amb", label: "🟠 HbA1c: Watch" },
  getting_better: { cls: "b-amb", label: "🟡 HbA1c: Flag" },
  in_control: { cls: "b-grn", label: "✅ HbA1c: In control" },
  no_reports: { cls: "b-blu", label: "🔵 HbA1c: No reports" },
};

const NAV = [
  { id: "s-proposals", label: "🩺 Chief Endo proposed" },
  { id: "s-overview", label: "📋 Overview" },
  { id: "s-complaints", label: "🗣 Symptoms / History" },
  { id: "s-labs", label: "📊 Labs & graphs" },
  { id: "s-rx", label: "💊 Prescription" },
  { id: "s-tests", label: "🔬 Tests" },
  { id: "s-procedures", label: "🩹 Procedures" },
  { id: "s-medcard", label: "🗒 Medicine card" },
  { id: "s-advice", label: "💬 Advice" },
  { id: "s-plan", label: "📝 Care plan" },
];

// What a section can still be holding that no request has taken yet. The draft
// itself is safe — every Rx edit and the care plan are already written — so the
// guard is only about these three, and it names them rather than asking "are you
// sure?" about nothing in particular.
const DRAFT_LABEL = {
  history: "History note",
  advice: "Advice",
  carePlan: "Care plan",
  tests: "Tests selected but not ordered",
};

const UNSAVED_LABEL = {
  rx: "a medicine editor is still open",
  add: "a medicine has been filled in but not added",
  tests: "tests are selected but not ordered",
  history: "the history note is still saving",
  advice: "the advice is still saving",
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
  const scrollRef = useRef(null);
  const navRef = useRef(null);
  const [activeNav, setActiveNav] = useState(NAV[0].id);
  const [restored, setRestored] = useState(null);
  const [restorePrompt, setRestorePrompt] = useState(null);
  const [printState, setPrintState] = useState(null);
  const { ref: pageRef, fullscreen, toggle: toggleFullscreen } = useFullscreen();
  const flushHistory = useRef(null);
  const flushAdvice = useRef(null);
  const requestFinalize = useRef(null);
  const [saveRequested, setSaveRequested] = useState(false);
  const writing = useIsMutating({ mutationKey: visitWriteKey(visitId) });

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

  const openPrint = async ({ leaveAfter = false } = {}) => {
    setPrintState({ phase: "preparing", leaveAfter });
    try {
      await fetchPrintableRx(visitId);
      setPrintState({ phase: "ready", leaveAfter, url: printRxHref(visitId) });
    } catch (e) {
      setPrintState(null);
      showToast(e.message || "The prescription could not be opened");
      if (leaveAfter) navigate("/giniflow/station/doctor");
    }
  };

  const saveAll = () => {
    flushCarePlan.current?.();
    flushHistory.current?.();
    flushAdvice.current?.();
    setSaveRequested(true);
  };

  const saveAndPrint = () => {
    saveAll();
    if (consult?.finalized) openPrint();
    else requestFinalize.current?.();
  };

  useEffect(() => {
    if (!saveRequested || writing > 0) return;
    setSaveRequested(false);
    const left = pendingWork.filter((k) => k !== "history" && k !== "advice");
    showToast(
      left.length
        ? `✓ Saved · still open: ${left.map((k) => UNSAVED_LABEL[k]).join(" · ")}`
        : "✓ All changes saved",
    );
  }, [saveRequested, writing, pendingWork]);

  const closePrint = () => {
    const leaveAfter = printState?.leaveAfter;
    setPrintState(null);
    if (leaveAfter) navigate("/giniflow/station/doctor");
  };

  const jumpLock = useRef(0);
  const scrollToSection = (id, smooth) => {
    const scroller = scrollRef.current;
    const el = document.getElementById(id);
    if (!scroller || !el) return;
    const navHeight = navRef.current?.offsetHeight || 0;
    const top =
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      navHeight -
      8;
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  };

  const hasConsult = !!consult;
  useEffect(() => {
    const scroller = scrollRef.current;
    const nav = navRef.current;
    if (!scroller || !nav) return undefined;
    let frame = 0;
    const pick = () => {
      frame = 0;
      if (Date.now() < jumpLock.current) return;
      const line = scroller.getBoundingClientRect().top + nav.offsetHeight + 12;
      const present = NAV.map((n) => document.getElementById(n.id)).filter(Boolean);
      if (!present.length) return;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      let current = present[0].id;
      for (const el of present) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
      }
      setActiveNav(atBottom ? present[present.length - 1].id : current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(pick);
    };
    const onScrollEnd = () => {
      jumpLock.current = 0;
    };
    pick();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("scrollend", onScrollEnd);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("scrollend", onScrollEnd);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [hasConsult]);

  const consultLocked = !!(consult?.finalized || consult?.readOnly);
  useEffect(() => {
    if (!hasConsult) return;
    const draft = readDraft(visitId);
    const fields = Object.keys(draft.fields).filter((k) => DRAFT_LABEL[k]);
    if (consultLocked) {
      clearDraftFields(visitId);
      setRestored({});
    } else if (fields.length) {
      setRestorePrompt({ fields, values: draft.fields });
    } else {
      setRestored({});
    }
    if (draft.nav && NAV.some((n) => n.id === draft.nav)) {
      requestAnimationFrame(() => {
        scrollToSection(draft.nav, false);
        setActiveNav(draft.nav);
      });
    }
  }, [hasConsult, visitId, consultLocked]);

  useEffect(() => {
    if (hasConsult) writeDraftNav(visitId, activeNav);
  }, [activeNav, hasConsult, visitId]);

  useEffect(() => {
    const nav = navRef.current;
    const button = nav?.querySelector(`[data-nav="${activeNav}"]`);
    if (!nav || !button) return;
    const left =
      button.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    if (left < nav.scrollLeft) nav.scrollLeft = left - 8;
    else if (left + button.offsetWidth > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = left + button.offsetWidth - nav.clientWidth + 8;
    }
  }, [activeNav]);

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

  const jump = (id) => {
    setActiveNav(id);
    jumpLock.current = Date.now() + 1000;
    scrollToSection(id, true);
  };

  return (
    <div className={`gf${fullscreen ? " gf--full" : ""}`} ref={pageRef}>
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
          <StabilityChip stability={consult.stability} detail />
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
          <FullscreenButton fullscreen={fullscreen} onToggle={toggleFullscreen} what="consult" />
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
      <div className="cscroll" ref={scrollRef}>
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

        <nav className="cnav" ref={navRef} aria-label="Consult sections">
          {NAV.map((n) => (
            <button
              type="button"
              key={n.id}
              data-nav={n.id}
              className={activeNav === n.id ? "on" : undefined}
              aria-current={activeNav === n.id ? "true" : undefined}
              onClick={() => jump(n.id)}
            >
              {n.label}
            </button>
          ))}
          <span className="cnav-sep" aria-hidden="true" />
          <button
            type="button"
            className="cnav-act"
            disabled={readOnly || saveRequested}
            onClick={saveAll}
          >
            {saveRequested ? "Saving…" : "💾 Save"}
          </button>
          <button
            type="button"
            className="cnav-act"
            disabled={(!consult.finalized && readOnly) || !!printState}
            title={
              consult.finalized
                ? "Open the prescription to print"
                : "Save, then finalize — the prescription is made when you finalize"
            }
            onClick={saveAndPrint}
          >
            {printState?.phase === "preparing" ? "Preparing…" : "🖨 Save & Print"}
          </button>
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
          <ComplaintsSection
            restored={restored}
            flushRef={flushHistory}
            visitId={visitId}
            readOnly={readOnly}
            onToast={showToast}
            onUnsaved={markUnsaved}
          />
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
            restored={restored}
            visitId={visitId}
            consult={consult}
            readOnly={readOnly}
            onToast={showToast}
            onUnsaved={markUnsaved}
          />
          <ProceduresSection visitId={visitId} readOnly={readOnly} onToast={showToast} />
          <MedCardSection visitId={visitId} onToast={showToast} />
          <AdviceSection
            restored={restored}
            flushRef={flushAdvice}
            visitId={visitId}
            readOnly={readOnly}
            onToast={showToast}
            onUnsaved={markUnsaved}
          />
          <CarePlanSection
            restored={restored}
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
              requestRef={requestFinalize}
              visitId={visitId}
              onToast={showToast}
              onDone={(r, { print } = {}) => {
                showToast(
                  `✓ Finalized — ${r.medicines} medicine${r.medicines === 1 ? "" : "s"} to the pharmacy`,
                );
                if (print) openPrint({ leaveAfter: true });
                else navigate("/giniflow/station/doctor");
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
              <button className="st-btn st-btn-grn" onClick={() => setConfirmLeave(null)}>
                Keep editing
              </button>
              <button
                className="st-btn st-btn-g"
                onClick={() => {
                  const go = confirmLeave;
                  clearDraftFields(visitId);
                  setConfirmLeave(null);
                  go();
                }}
              >
                Discard &amp; leave
              </button>
            </div>
          </div>
        </div>
      )}
      {printState?.phase === "preparing" && (
        <div className="modal-back">
          <div className="modal-card" role="status" aria-live="polite">
            <h3 className="modal-title">Preparing the prescription…</h3>
            <p className="modal-body">
              The PDF is made just after finalizing. This usually takes a few seconds.
            </p>
          </div>
        </div>
      )}
      {printState?.phase === "ready" && (
        <PdfViewerModal
          printable
          src={{
            url: printState.url,
            mimeType: "application/pdf",
            fileName: `Prescription — ${consult.name || "patient"}`,
            title: `Prescription — ${consult.name || "patient"}`,
          }}
          onClose={closePrint}
        />
      )}
      {restorePrompt && (
        <div className="modal-back">
          <div
            className="modal-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="restore-title"
          >
            <h3 className="modal-title" id="restore-title">
              Unsaved changes found
            </h3>
            <p className="modal-body">
              These were being written when the page closed or reloaded, and had not reached the
              server:
              <span className="fin-gap">
                {restorePrompt.fields.map((k) => DRAFT_LABEL[k]).join(" · ")}.
              </span>
            </p>
            <div className="modal-acts">
              <button
                className="st-btn st-btn-g"
                onClick={() => {
                  clearDraftFields(visitId);
                  setRestorePrompt(null);
                  setRestored({});
                }}
              >
                Discard
              </button>
              <button
                className="st-btn st-btn-grn"
                autoFocus
                onClick={() => {
                  setRestored(restorePrompt.values);
                  setRestorePrompt(null);
                }}
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
