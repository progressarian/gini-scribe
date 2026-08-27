import { useEffect, useState } from "react";
import { toast } from "../../stores/uiStore";
import {
  useFlowQueue,
  useFlowAdvance,
  useFlowEndVisit,
  useFlowStartStep,
  useFlowVisits,
  useFlowStepCatalog,
  useFlowAddStep,
  useFlowRemoveStep,
  useFlowClaimStep,
  useFlowReleaseStep,
  useFlowResultsIn,
} from "../../queries/hooks/useFlow";
import useAuthStore from "../../stores/authStore";
import LabPanel from "./LabPanel";
import LabCallInDialog from "./LabCallInDialog";
import DoctorReportsPanel, { prescriptionRows } from "./DoctorReportsPanel";
import PdfViewerModal from "../visit/PdfViewerModal";
import { CAPABILITIES as CAP, hasCapability, ownsStationRole } from "../../../shared/permissions";
import "../../styles/flow.css";

// Friendly URL slug → the assigned_role stored on flow_visit_steps, plus the
// station's display title and which data-entry form to render. Shared by the
// standalone station page and the "Live Lab Queue" tab on /lab-requests.
export const LAB_ROLE = "lab_tech";

export const ROLES = {
  vitals: { role: "vitals_associate", title: "⚖️ Vitals Station", form: "vitals" },
  mo: { role: "mo", title: "🩺 Doctor", form: "notes" },
  lab: { role: "lab_tech", title: "🔬 Lab & Tests", form: "lab" },
  dietitian: { role: "dietitian", title: "🥗 Dietitian", form: "notes" },
  rx: { role: "nurse", title: "💬 Prescription Explain", form: "rx" },
  pharmacy: { role: "pharmacist", title: "💊 Pharmacy — Final Step", form: "pharmacy" },
  assistant: { role: "report_desk", title: "🧑‍⚕️ Assistant Station", form: "assistant" },
};

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Quick-pick reasons for skipping a step (free text still allowed). Mirrors the
// list in VisitDetailModal so skip reasons stay consistent across the app.
const SKIP_REASONS = ["Already done", "Not required", "Done elsewhere", "Patient declined"];

// Patients still in the building — a completed or cancelled visit has left, so
// it would only add noise to a live station screen.
const PRESENT_STATUSES = ["waiting", "paused", "in_progress"];
const VISIT_STATUS_LABEL = {
  waiting: "waiting — timer not started",
  paused: "paused",
  in_progress: "in progress",
};

// Where a patient is right now: the step being worked, else the next one open.
const currentStepOf = (v) => {
  const steps = (v.steps || []).slice().sort((a, b) => a.step_order - b.step_order);
  return (
    steps.find((s) => s.status === "in_progress") ||
    steps.find((s) => ["ready", "pending"].includes(s.status)) ||
    null
  );
};

// A test step at this station, tied back to what HealthRay knows about it.
// Imaging maps by doc_type; a blood draw maps to the visit's pathology cases.
const STEP_DOC_TYPES = { abi: ["abi"], x_ray: ["xray", "x_ray"], ecg: ["ecg"], tmt: ["tmt"] };

function labStateForStep(step, lab) {
  const tests = lab?.tests || [];
  const types = STEP_DOC_TYPES[step.step_catalog_id];
  if (types) {
    const hit = tests.find((t) => t.kind === "imaging" && types.includes(t.doc_type));
    if (hit) return { label: "report on file", cls: "fb-grn", docId: hit.doc_id };
    return null;
  }
  if (step.step_catalog_id === "blood_sample") {
    const path = tests.filter((t) => t.kind === "pathology");
    if (!path.length) return null;
    const ready = path.filter((t) => t.ready).length;
    return ready === path.length
      ? { label: "results in", cls: "fb-grn" }
      : { label: `${ready}/${path.length} results in`, cls: "fb-amb" };
  }
  return null;
}

const SKIPPED_OR_DONE = (st) => st === "completed" || st === "skipped";
const LIVE_VISIT = ["waiting", "paused", "in_progress"];

// What pressing the button MEANS for each stage. "✓ processing" reads as an
// instruction to start processing; the button completes it, so it has to say so.
const STAGE_ACTION = {
  lab_delivered: "✓ Delivered to lab",
  lab_processing: "✓ Processing done",
  lab_reports: "✓ Reports available",
  report_printed: "🖨️ Printed",
  report_delivered: "✓ Handed to the consultant",
};

const stageLabel = (name) => name.replace(/^(Lab|Reports) — /, "");

// What the completing action means at this step. A lab desk does not "finish a
// step" — it takes a sample or performs a test, and the notes it writes differ.
const LAB_ACTION = {
  blood_sample: {
    btn: "✓ Sample collected",
    label: "Collection notes",
    hint: "Tubes taken, site, fasting / non-fasting…",
  },
  abi: { btn: "✓ Test done", label: "Test notes", hint: "Readings, difficulties…" },
  x_ray: { btn: "✓ Test done", label: "Test notes", hint: "Views taken, notes…" },
  ecg: { btn: "✓ Test done", label: "Test notes", hint: "Rhythm, notes…" },
  tmt: { btn: "✓ Test done", label: "Test notes", hint: "Protocol, notes…" },
};

// The live execution queue for one station role: the active (in-progress)
// patient with a role-specific form + "advance", and one call-in queue holding
// every step assigned here. Self-contained (owns its data + mutations) so it
// can be dropped into any page.
export default function StationQueue({ role, form, freeMove = false }) {
  const { data, isLoading } = useFlowQueue(role);
  const advance = useFlowAdvance();
  const endVisit = useFlowEndVisit();
  const startStep = useFlowStartStep();
  const addStep = useFlowAddStep();
  const removeStep = useFlowRemoveStep();
  const claimStep = useFlowClaimStep();
  const releaseStep = useFlowReleaseStep();
  const resultsIn = useFlowResultsIn();
  // Server-side floor search (name / file / phone / token), debounced so a
  // desk can find any patient today without scrolling the whole floor.
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const searching = debounced.length > 0;

  const { data: allVisits = [], isFetching: searchBusy } = useFlowVisits(
    undefined,
    undefined,
    {},
    debounced,
  );
  const { data: catalog = [] } = useFlowStepCatalog();
  const myRole = useAuthStore((st) => st.currentDoctor?.role);
  const myId = useAuthStore((st) => st.currentDoctor?.id);
  // Where the patient physically is. A step in progress at another station means
  // this desk cannot take them — one patient, one place.
  const visitById = new Map(allVisits.map((v) => [v.id, v]));
  const busyElsewhere = (s) => {
    const v = visitById.get(s.visit_id);
    const other = (v?.steps || []).find(
      (x) =>
        x.status === "in_progress" &&
        x.id !== s.id &&
        !x.is_background &&
        x.assigned_role !== s.assigned_role,
    );
    return other ? other.step_name : null;
  };
  // The nurse's own gate, shown before she clicks rather than as an error after.
  const rxNotReady = (s) => {
    if (!isRx) return null;
    const v = visitById.get(s.visit_id);
    const stage = (v?.steps || []).find((x) => x.step_catalog_id === "rx_ready");
    // No stage at all (a visit created before it existed) is not a green light —
    // fall back to whether a prescription is genuinely on file.
    if (!stage) return v && !v.rx?.ready ? { step_name: "the prescription" } : null;
    return ["completed", "skipped"].includes(stage.status) ? null : stage;
  };
  // Everything before this step that is still open. The patient stays visible in
  // the queue — the desk wants to see who is coming — but cannot be called in
  // until they have actually finished the earlier stations. Mirrors the same
  // guard on POST /steps/:id/start, so the button never promises what the API
  // will refuse.
  const notTheirTurn = (s) => {
    const v = visitById.get(s.visit_id);
    return (
      (v?.steps || [])
        .filter(
          (x) =>
            !x.is_background &&
            x.step_order < s.step_order &&
            !["completed", "skipped"].includes(x.status),
        )
        .sort((a, b) => a.step_order - b.step_order)[0] || null
    );
  };
  const heldByMe = (s) => s.claim && String(s.claim.by_id) === String(myId);
  const heldByOther = (s) => s.claim && String(s.claim.by_id) !== String(myId);
  const canManage = hasCapability(myRole, CAP.FLOW_COORDINATOR);
  // Journey edits confined to this desk: floor managers anywhere, station staff
  // only where they actually work.
  const canEditHere = canManage || ownsStationRole(myRole, role);

  const activeList = data?.active || [];
  const inMyBox = (s) => activeList.some((a) => a.visit_id === s.visit_id);
  // Callable and not-yet-reachable steps sit in one list: POST /flow/steps/:id/
  // start accepts a pending step, so the desk can pull a patient forward instead
  // of waiting for an earlier station to release them. VIP first, then arrival.
  const ready = [...(data?.ready || []), ...(data?.pending || [])].sort(
    (a, b) =>
      Number(!!b.is_vip) - Number(!!a.is_vip) ||
      new Date(a.checkin_time) - new Date(b.checkin_time),
  );

  // In free-move stations (vitals) the user picks who sits in the form box. The
  // box patient is a LOCAL selection (default: whoever is in_progress, else
  // none); clicking "Move in" on a queued patient just swaps them into the box
  // (and the previous one returns to the list) — it does NOT advance anyone.
  const [selectedId, setSelectedId] = useState(null);
  const [callInTarget, setCallInTarget] = useState(null);
  const [endTarget, setEndTarget] = useState(null);
  const [endReason, setEndReason] = useState("");
  const isLab = form === "lab";
  const isAssistant = form === "assistant";
  const isDoctor = role === "mo";
  const isRx = form === "rx";
  const queueItems = freeMove ? [...(data?.active || []), ...ready] : [];
  const active = activeList.find((a) => a.id === selectedId) || activeList[0] || null;
  const boxPatient = freeMove ? queueItems.find((i) => i.id === selectedId) || active : active;
  const boxTests = boxPatient ? activeList.filter((a) => a.visit_id === boxPatient.visit_id) : [];
  const listItems = freeMove ? queueItems.filter((i) => i.id !== boxPatient?.id) : ready;

  // The visit behind the box patient — carries the HealthRay lab panel and the
  // open reports stage, neither of which the queue payload includes.
  const boxVisit = boxPatient ? allVisits.find((v) => v.id === boxPatient.visit_id) : null;
  const openLabStage = (boxVisit?.steps || []).find(
    (s) => s.is_background && !["completed", "skipped"].includes(s.status),
  );
  // Nothing can have produced a result until a test at this station has actually
  // been done, so the manual "results received" stays hidden until then —
  // otherwise it appears the moment a patient is called in for their first draw.
  const anyTestDone = (boxVisit?.steps || []).some(
    (s) => s.assigned_role === role && !s.is_background && s.status === "completed",
  );

  // Collection is the last hands-on step, so once it is done the patient leaves
  // this queue — but their reports stage is still open and only this desk can
  // close it. Without this list there is nowhere to press "results received".
  // The whole after-the-patient chain: every collection step, then every
  // background stage whatever desk owns it. Both the lab and the reports desk
  // show the same line, so each can see what the other has already done — only
  // the actionable stage differs.
  const awaitingResults = allVisits
    .filter((v) => LIVE_VISIT.includes(v.status))
    .map((v) => {
      const bg = (v.steps || [])
        .filter((s) => s.is_background)
        .sort((a, b) => a.step_order - b.step_order);
      const taken = (v.steps || [])
        .filter(
          (s) =>
            s.assigned_role === LAB_ROLE &&
            !s.is_background &&
            ["completed", "skipped"].includes(s.status),
        )
        .sort((a, b) => a.step_order - b.step_order);
      const open = (x) => !["completed", "skipped"].includes(x.status);
      const collections = (v.steps || []).filter(
        (x) => x.assigned_role === LAB_ROLE && !x.is_background,
      );
      // Everything went elsewhere: the courier and machine stages were dropped
      // and the collection was never ours, so the whole story is one line —
      // "sent outside", then print and hand over.
      const allOutside = collections.length > 0 && collections.every((x) => x.data?.outside?.sent);
      const shown = (x) =>
        !x.data?.outside_dropped && !(allOutside && !x.is_background && x.data?.outside?.sent);
      // Stages run in order across desks, so this desk's earliest open stage is
      // only offered once everything before it is closed.
      const mine = bg.filter((x) => x.assigned_role === role).find(open) || null;
      const blockedBy = mine ? bg.find((x) => x.step_order < mine.step_order && open(x)) : null;
      return {
        visit: v,
        line: [...taken, ...bg].filter(shown),
        allOutside,
        next: blockedBy ? null : mine,
        // A test the patient went elsewhere for is closed work too — without it
        // an all-outside visit would appear in neither desk's list.
        done: taken.filter((s) => s.status === "completed" || s.data?.outside?.sent),
      };
    })
    .filter((e) => e.next && e.done.length)
    .sort((a, b) => new Date(a.visit.checkin_time) - new Date(b.visit.checkin_time));

  // The assistant's two jobs are different work: chasing a report the patient is
  // fetching from another lab, versus printing one that is already in. One list
  // headed "results are ready" was a lie for half its rows.
  const waitingOutside = awaitingResults.filter((e) => e.next?.data?.awaiting_outside);
  const readyToPrint = awaitingResults.filter((e) => !e.next?.data?.awaiting_outside);
  const stageSections = isAssistant
    ? [
        {
          key: "print",
          title: "Ready to print & hand over",
          sub: "Results are in. Print the report, then hand it to the doctor — the consultation opens once you mark it delivered.",
          rows: readyToPrint,
        },
        {
          key: "waiting",
          title: "Waiting on outside labs",
          sub: "Being done elsewhere. Mark the report received when the patient brings it in — nothing to print until then.",
          rows: waitingOutside,
        },
      ]
    : [
        {
          key: "lab",
          title: "In the lab",
          sub: "Sample taken, patient gone to their consultation. Work the stages in order — the consultation opens once reports are available.",
          rows: awaitingResults,
        },
      ];

  // The MO's own work, not the consultant's. Reports are delivered to the
  // consultant now, so listing them here was showing someone else's queue.
  const toPrepare = isDoctor ? prescriptionRows(allVisits) : [];

  const confirmEndVisit = async () => {
    try {
      const r = await endVisit.mutateAsync({
        visitId: endTarget.visit_id,
        reason: endReason.trim(),
        complete_current: isRx,
        step_data: isRx ? formData : undefined,
      });
      toast(
        `${endTarget.patient_name} — ${r.completed_step ? `${r.completed_step} done, ` : ""}visit ended${
          r.skipped_steps ? `, ${r.skipped_steps} step(s) skipped` : ""
        }`,
        "success",
      );
      setEndTarget(null);
      setEndReason("");
      setFormData({});
      setSelectedId(null);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const markPrepared = async (step, name) => {
    try {
      await resultsIn.mutateAsync(step.id);
      toast(`${name} — prescription ready, the nurse can explain it`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const markStageIn = async (stage, name) => {
    try {
      await resultsIn.mutateAsync(stage.id);
      toast(`${name} — ${stageLabel(stage.step_name)} done`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const markResultsIn = async () => {
    if (!openLabStage) return;
    try {
      await resultsIn.mutateAsync(openLabStage.id);
      toast("Results marked received — consultation released", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // One card per patient, not per step. A patient needing bloods, ABI and X-Ray
  // was appearing as three near-identical rows, each with its own actions.
  const listGroups = (() => {
    const m = new Map();
    for (const s of listItems) {
      if (!m.has(s.visit_id)) m.set(s.visit_id, { visit_id: s.visit_id, head: s, steps: [] });
      m.get(s.visit_id).steps.push(s);
    }
    return [...m.values()];
  })();

  const [viewingDoc, setViewingDoc] = useState(null);
  const labAction = boxPatient ? LAB_ACTION[boxPatient.step_catalog_id] : null;
  const [formData, setFormData] = useState({});
  useEffect(() => setFormData({}), [boxPatient?.id]);

  // Skip-reason dialog — targets a specific step (the box patient OR any queued
  // patient), so anyone can be skipped at any time. Replaces the native prompt.
  const [skipTarget, setSkipTarget] = useState(null);
  const [skipReason, setSkipReason] = useState("");
  // Remove a step from the patient's journey — the undo for "Send to my
  // station", and for a step queued here that shouldn't be.
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeReason, setRemoveReason] = useState("");

  // Everyone still in the building who isn't already somewhere in this
  // station's own queue (active / ready / queued-behind-an-earlier-step).
  const myVisitIds = new Set([...(data?.active || []), ...ready].map((i) => i.visit_id));
  // Already dealt with here — their step at this station is completed, or was
  // deliberately skipped. Either way this desk is done with them, so they drop
  // off the list rather than looking like outstanding work.
  const settledHere = (v) =>
    (v.steps || []).some(
      (s) => s.assigned_role === role && ["completed", "skipped"].includes(s.status),
    );
  // While searching, show every match the server returned — including patients
  // this desk has already finished with, since finding them again is the point.
  const notSeenHere = (
    searching
      ? allVisits
      : allVisits.filter(
          (v) => PRESENT_STATUSES.includes(v.status) && !myVisitIds.has(v.id) && !settledHere(v),
        )
  ).map((v) => ({ visit: v, step: currentStepOf(v) }));

  // Catalog steps this station works — used to append one for a patient who
  // never got a step here (or whose step is already done). Several stations own
  // more than one (lab: Blood Sample / ABI / X-Ray), so the user picks.
  const myCatalogSteps = catalog.filter((c) => c.assigned_role === role);

  const sendToMyStation = async (v, catId) => {
    const c = myCatalogSteps.find((x) => x.id === catId) || myCatalogSteps[0];
    if (!c) return;
    // Adding a step the patient already has open just creates a second copy of
    // the same work — three "Prescription Explain" rows on one journey.
    const already = (v.steps || []).find(
      (x) => x.step_catalog_id === c.id && !["completed", "skipped"].includes(x.status),
    );
    if (already) {
      toast(`${v.patient_name} already has ${c.name} in their journey`, "warn");
      return;
    }
    const maxOrder = (v.steps || []).reduce((m, s) => Math.max(m, s.step_order || 0), 0);
    try {
      await addStep.mutateAsync({
        visitId: v.id,
        step_catalog_id: c.id,
        step_name: c.name,
        planned_duration_min: c.default_duration_min,
        station: c.station,
        assigned_role: c.assigned_role,
        insert_after_order: maxOrder,
      });
      // Not "added to the queue": it goes at the end of their journey, so they
      // only appear here once they have finished everything before it.
      toast(`${v.patient_name} → ${c.name} added to their journey`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const callIn = async (stepId, checks) => {
    try {
      await startStep.mutateAsync({ stepId, ...(checks || {}) });
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const confirmCallIn = async ({ handsOff, ...checks }) => {
    const s = callInTarget;
    setCallInTarget(null);
    if (!handsOff) {
      await callIn(s.id, checks);
      return;
    }
    // Nothing to call in for: the patient is going to that lab themselves, so
    // the test leaves this desk and only its report comes back to us.
    try {
      await advance.mutateAsync({
        visitId: s.visit_id,
        step_id: s.id,
        skip: true,
        reason: `Sent to ${checks.outside.lab_name}`,
        step_data: { outside: checks.outside },
      });
      toast(`${s.patient_name} — ${s.step_name} sent to ${checks.outside.lab_name}`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Bring a queued patient into the form box. Takes the step first, so two
  // people at the same desk can't quietly work the same patient — the loser is
  // told who has them rather than finding out at "Done".
  const moveIntoBox = async (s) => {
    if (heldByOther(s)) {
      toast(`${s.claim.by} is already working ${s.patient_name}`, "warn");
      return;
    }
    try {
      await claimStep.mutateAsync(s.id);
      setSelectedId(s.id);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Hand a patient back to the queue without completing them.
  const release = async (s) => {
    try {
      await releaseStep.mutateAsync(s.id);
      if (selectedId === s.id) setSelectedId(null);
      toast(`${s.patient_name} released back to the queue`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const complete = async () => {
    if (!boxPatient) return;
    try {
      await advance.mutateAsync({
        visitId: boxPatient.visit_id,
        step_id: boxPatient.id,
        step_data: formData,
      });
      toast(`${boxPatient.patient_name} → next step`, "success");
      setFormData({});
      setSelectedId(null);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Skip a step (e.g. vitals already taken elsewhere / not applicable) — the
  // patient still advances. Confirmed via a dialog with quick-pick reasons.
  const confirmSkip = async () => {
    if (!skipTarget) return;
    try {
      await advance.mutateAsync({
        visitId: skipTarget.visit_id,
        step_id: skipTarget.id,
        skip: true,
        reason: skipReason.trim(),
      });
      toast(`${skipTarget.patient_name} — ${skipTarget.step_name} skipped → next step`, "success");
      if (skipTarget.id === boxPatient?.id) {
        setFormData({});
        setSelectedId(null);
      }
      setSkipTarget(null);
      setSkipReason("");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await removeStep.mutateAsync({ stepId: removeTarget.id, reason: removeReason.trim() });
      toast(`${removeTarget.patient_name} — ${removeTarget.step_name} removed`, "success");
      if (removeTarget.id === boxPatient?.id) {
        setFormData({});
        setSelectedId(null);
      }
      setRemoveTarget(null);
      setRemoveReason("");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  if (isLoading) return <div className="flow-card flow-empty">Loading…</div>;

  return (
    <>
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
      {callInTarget && (
        <LabCallInDialog
          step={callInTarget}
          busy={startStep.isPending}
          onCancel={() => setCallInTarget(null)}
          onConfirm={confirmCallIn}
        />
      )}
      <div className={isDoctor ? "station-split" : undefined}>
        <div className="station-main">
          {/* Patient in the form box */}
          {boxPatient ? (
            <div className="station-active">
              <div className="station-head">
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>
                    {boxPatient.token_number ? `#${boxPatient.token_number} · ` : ""}
                    {boxPatient.patient_name} · Step{" "}
                    {boxPatient.step_position ?? boxPatient.step_order} of {boxPatient.total_steps}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                    {boxPatient.patient_age_sex || ""} · {boxPatient.file_no} ·{" "}
                    {boxPatient.visit_type_id} · budget ≤ {boxPatient.planned_duration_min} min
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 14 }}>
                    At station: {boxPatient.step_timing?.at_station_min ?? 0} min
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.8 }}>
                    Visit: {boxPatient.visit_remaining_min}m left
                  </div>
                  {boxPatient.claim && (
                    <div style={{ fontSize: 10, opacity: 0.9, marginTop: 2 }}>
                      🔒{" "}
                      {heldByMe(boxPatient)
                        ? "you have this patient"
                        : `with ${boxPatient.claim.by}`}
                    </div>
                  )}
                  <div className="qrow-chips" style={{ justifyContent: "flex-end", marginTop: 4 }}>
                    <CheckChips step={boxPatient} />
                  </div>
                </div>
              </div>
              {boxTests.length > 1 && (
                <div className="station-tests">
                  <span className="flow-muted">At your desk now:</span>
                  {boxTests.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`flow-btn flow-btn-mini station-test${
                        a.id === boxPatient.id ? " is-on" : ""
                      }`}
                      aria-pressed={a.id === boxPatient.id}
                      onClick={() => {
                        setSelectedId(a.id);
                        setFormData({});
                      }}
                    >
                      {a.step_name}
                    </button>
                  ))}
                </div>
              )}
              <div className="station-body">
                <StationForm
                  key={boxPatient.id}
                  form={form}
                  value={formData}
                  onChange={setFormData}
                  labAction={labAction}
                />

                {isRx && <RxState rx={boxVisit?.rx} onView={setViewingDoc} />}
                {form === "lab" && (
                  <>
                    <LabPanel lab={boxVisit?.lab} />
                    {openLabStage && anyTestDone && (
                      <div className="lab-manual">
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>
                            {openLabStage.step_name}
                          </div>
                          <div className="flow-muted">
                            Completes on its own when HealthRay syncs the results. Mark it by hand
                            if the report came another way.
                          </div>
                        </div>
                        <button
                          className="flow-btn flow-btn-grn"
                          disabled={resultsIn.isPending}
                          onClick={markResultsIn}
                        >
                          ✓ Results received
                        </button>
                      </div>
                    )}
                  </>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
                  <button
                    className={`flow-btn ${form === "pharmacy" ? "flow-btn-primary" : "flow-btn-grn"}`}
                    style={{ padding: "8px 18px" }}
                    disabled={advance.isPending || heldByOther(boxPatient)}
                    title={
                      heldByOther(boxPatient)
                        ? `${boxPatient.claim.by} is working this patient`
                        : ""
                    }
                    onClick={complete}
                  >
                    {form === "pharmacy"
                      ? "💊 Dispensed — Confirm Exit (stops clock)"
                      : isRx
                        ? "✓ Prescription explained — move to next step"
                        : labAction
                          ? labAction.btn
                          : "✓ Done — move to next step"}
                  </button>
                  <button
                    className="flow-btn flow-btn-ghost"
                    style={{ padding: "8px 14px" }}
                    disabled={advance.isPending || heldByOther(boxPatient)}
                    onClick={() => setSkipTarget(boxPatient)}
                    title={
                      heldByOther(boxPatient)
                        ? `${boxPatient.claim.by} is working this patient`
                        : "Skip this step — patient still advances"
                    }
                  >
                    ⏭ Skip
                  </button>
                  {heldByMe(boxPatient) && (
                    <button
                      className="flow-btn flow-btn-ghost"
                      style={{ padding: "8px 14px" }}
                      disabled={releaseStep.isPending}
                      onClick={() => release(boxPatient)}
                      title="Hand this patient back to the queue without completing"
                    >
                      ↩ Release
                    </button>
                  )}
                  {(isRx || form === "pharmacy") && (
                    <button
                      className="flow-btn flow-btn-ghost"
                      style={{
                        padding: "8px 14px",
                        color: "var(--fre)",
                        borderColor: "var(--fre)",
                      }}
                      disabled={endVisit.isPending}
                      onClick={() => setEndTarget(boxPatient)}
                      title={
                        isRx
                          ? "Record the explanation, then close the visit — billing and pharmacy are skipped"
                          : "Close the visit here — everything still open is skipped with a reason"
                      }
                    >
                      {isRx ? "⏹ Prescription explained — end visit" : "⏹ End visit"}
                    </button>
                  )}
                  <span className="flow-muted">
                    {heldByOther(boxPatient)
                      ? `${boxPatient.claim.by} has this patient — ask them to release before you take over.`
                      : "Patient auto-moves to their next station"}
                  </span>
                </div>
              </div>
            </div>
          ) : isAssistant ? null : (
            <div className="flow-card flow-empty">
              {freeMove
                ? "No patient selected. Pick one from the queue below."
                : "No patient in progress. Call in the next from your queue."}
            </div>
          )}

          {stageSections.map(
            (sec) =>
              sec.rows.length > 0 && (
                <div key={sec.key} className="q-sec">
                  <div className="q-sec-head">
                    <span className="flow-sec-title" style={{ margin: 0 }}>
                      {sec.title}
                      <span className="q-count">{sec.rows.length}</span>
                    </span>
                  </div>
                  <div className="flow-muted" style={{ marginBottom: 6 }}>
                    {sec.sub}
                  </div>
                  {sec.rows.map(({ visit, line, next, allOutside }) => (
                    <div key={visit.id} className="qrow qrow--muted">
                      <span className="qrow-tok">{visit.token_number || "—"}</span>
                      <div className="qrow-main">
                        <div className="qrow-name">
                          {visit.patient_name}
                          {visit.is_vip && <span title="VIP">⭐</span>}
                        </div>
                        <div className="qrow-meta">
                          {visit.patient_id} · now at {currentStepOf(visit)?.step_name || "—"}
                        </div>

                        <div className="labstages">
                          {line.map((st) => {
                            const isDone = st.status === "completed";
                            // A test the patient took elsewhere is not cancelled work —
                            // striking it through reads as a mistake rather than a route.
                            const isAway = st.data?.outside?.sent && st.status === "skipped";
                            const isSkipped = st.status === "skipped" && !isAway;
                            const isNext = next && st.id === next.id;
                            const isRunning = st.status === "in_progress";
                            return (
                              <div
                                key={st.id}
                                className={`labstage${isDone ? " labstage--done" : isAway ? " labstage--outside" : isSkipped ? " labstage--skip" : isNext ? " labstage--next" : ""}`}
                              >
                                <span className="labstage-dot">
                                  {isDone
                                    ? "✓"
                                    : isAway
                                      ? "→"
                                      : isSkipped
                                        ? "–"
                                        : isRunning || isNext
                                          ? "●"
                                          : "○"}
                                </span>
                                <span className="labstage-name">
                                  {st.data?.awaiting_outside && allOutside
                                    ? `sent outside · ${st.data.awaiting_outside.lab_name}`
                                    : stageLabel(st.step_name)}
                                </span>
                                {isDone && st.actual_duration_min != null && (
                                  <span className="flow-badge fb-ink">
                                    {st.actual_duration_min}m
                                  </span>
                                )}
                                {st.status === "in_progress" && st.started_at && (
                                  <span className="flow-badge fb-amb">
                                    {Math.max(
                                      0,
                                      Math.round(
                                        (Date.now() - new Date(st.started_at).getTime()) / 60000,
                                      ),
                                    )}
                                    m
                                  </span>
                                )}

                                {isDone && st.data?.auto_completed === "lab_results" && (
                                  <span className="flow-badge fb-ink">auto</span>
                                )}
                                {isDone && st.data?.results_in?.manual && (
                                  <span className="flow-badge fb-ink">by hand</span>
                                )}
                                <CheckChips step={st} hideWaitLab={allOutside} />
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="qrow-actions">
                        <button
                          className="flow-btn flow-btn-grn"
                          disabled={resultsIn.isPending}
                          title={`Mark "${stageLabel(next.step_name)}" done`}
                          onClick={() => markStageIn(next, visit.patient_name)}
                        >
                          {next.data?.awaiting_outside
                            ? `✓ Report received from ${next.data.awaiting_outside.lab_name}`
                            : STAGE_ACTION[next.step_catalog_id] ||
                              `✓ ${stageLabel(next.step_name)} done`}
                        </button>
                        {canEditHere && (
                          <button
                            className="flow-btn flow-btn-ghost"
                            style={{ color: "var(--fre)", borderColor: "var(--fre)" }}
                            disabled={removeStep.isPending}
                            title="Skip this stage — releases the consultation if it is the last one"
                            onClick={() => setRemoveTarget(next)}
                          >
                            ✕ Skip
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ),
          )}

          {/* This desk has no call-in queue and no patient box, so with both stage
              lists empty the page would otherwise be blank below the header. */}
          {isAssistant && stageSections.every((sec) => sec.rows.length === 0) && (
            <div className="flow-card flow-empty">
              Nothing waiting. A patient appears here once the lab marks their reports available —
              print it, then hand it to the consultant. Patients having tests done at an outside lab
              show up too, so you can mark the report received when they bring it in.
            </div>
          )}

          {/* Queue — free-move: pick anyone into the box; else call-in order */}
          {!isAssistant && (
            <div className="q-sec">
              <div className="q-sec-head">
                <span className="flow-sec-title" style={{ margin: 0 }}>
                  {freeMove ? "My queue — pick anyone" : "My queue — ready to call in"}
                  <span className="q-count">{listGroups.length}</span>
                </span>
              </div>
              {listGroups.length === 0 ? (
                <div className="flow-card flow-empty">No one waiting at this station.</div>
              ) : (
                listGroups.map(({ visit_id, head, steps }) => {
                  const away = busyElsewhere(head);
                  const visit = visitById.get(visit_id);
                  return (
                    <div
                      key={visit_id}
                      className={`qrow${head.visit_urgency === "breach" ? " qrow--breach" : head.visit_urgency === "atrisk" ? " qrow--atrisk" : ""}`}
                    >
                      <span className="qrow-tok">{head.token_number || "—"}</span>
                      <div className="qrow-main">
                        <div className="qrow-name">
                          {head.patient_name}
                          {head.is_vip && <span title="VIP">⭐</span>}
                        </div>
                        <div className="qrow-meta">
                          {head.patient_age_sex || ""} · {head.file_no} · in since{" "}
                          {fmtTime(head.checkin_time)}
                        </div>
                        <div className="qrow-chips">
                          <span
                            className={`flow-badge ${head.visit_urgency === "breach" ? "fb-red" : head.visit_urgency === "atrisk" ? "fb-amb" : "fb-ink"}`}
                          >
                            {head.visit_remaining_min}m left of visit
                          </span>
                          {isRx &&
                            (visitById.get(head.visit_id)?.rx?.ready ? (
                              <span className="flow-badge fb-grn">Rx ready</span>
                            ) : (
                              <span
                                className="flow-badge fb-amb"
                                title="The doctor has not written it yet"
                              >
                                no Rx yet
                              </span>
                            ))}
                          {away && <span className="flow-badge fb-amb">🔒 at {away} now</span>}
                          {head.claim && (
                            <span className={`flow-badge ${heldByMe(head) ? "fb-blu" : "fb-amb"}`}>
                              🔒{" "}
                              {heldByMe(head) ? "you have this patient" : `with ${head.claim.by}`}
                            </span>
                          )}
                        </div>

                        <div className="qtests">
                          {/* Tests already finished here — the queue payload only
        carries open ones, so these come from the visit. */}
                          {(visit?.steps || [])
                            .filter(
                              (x) =>
                                x.assigned_role === role &&
                                !x.is_background &&
                                SKIPPED_OR_DONE(x.status),
                            )
                            .sort((a, b) => a.step_order - b.step_order)
                            .map((x) => {
                              const st = labStateForStep(x, visit?.lab);
                              return (
                                <div key={x.id} className="qtest qtest--done">
                                  <span className="qtest-name">{x.step_name}</span>
                                  <span
                                    className={`flow-badge ${x.status === "skipped" ? "fb-ink" : "fb-grn"}`}
                                  >
                                    {x.status === "skipped" ? "skipped" : "done"}
                                  </span>
                                  {st && <span className={`flow-badge ${st.cls}`}>{st.label}</span>}
                                  {st?.docId && (
                                    <button
                                      className="flow-btn flow-btn-ghost flow-btn-mini"
                                      onClick={() =>
                                        setViewingDoc({
                                          id: st.docId,
                                          title: x.step_name,
                                          file_name: `${x.step_name}.pdf`,
                                        })
                                      }
                                    >
                                      View report
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          {steps.map((s) => (
                            <div key={s.id} className="qtest">
                              <span className="qtest-name">{s.step_name}</span>
                              {freeMove ? (
                                <button
                                  className="flow-btn flow-btn-primary flow-btn-mini"
                                  disabled={
                                    heldByOther(s) || !!busyElsewhere(s) || claimStep.isPending
                                  }
                                  title={
                                    busyElsewhere(s)
                                      ? `Patient is at ${busyElsewhere(s)} right now`
                                      : "Take this patient"
                                  }
                                  onClick={() => moveIntoBox(s)}
                                >
                                  ↑ Move in
                                </button>
                              ) : (
                                <button
                                  className="flow-btn flow-btn-primary flow-btn-mini"
                                  disabled={
                                    (!!active && !inMyBox(s)) ||
                                    startStep.isPending ||
                                    heldByOther(s) ||
                                    !!busyElsewhere(s) ||
                                    !!rxNotReady(s) ||
                                    !!notTheirTurn(s)
                                  }
                                  title={
                                    notTheirTurn(s)
                                      ? notTheirTurn(s).status === "in_progress"
                                        ? `Patient is at ${notTheirTurn(s).step_name} right now`
                                        : `Not their turn yet — still at ${notTheirTurn(s).step_name}`
                                      : rxNotReady(s)
                                        ? "No prescription yet — the doctor has not submitted it"
                                        : busyElsewhere(s)
                                          ? `Patient is at ${busyElsewhere(s)} right now`
                                          : heldByOther(s)
                                            ? `${s.claim.by} is working this patient`
                                            : active && !inMyBox(s)
                                              ? "Finish the current patient first"
                                              : inMyBox(s)
                                                ? "Call in — this patient is already at your desk"
                                                : "Call in"
                                  }
                                  onClick={() => (isLab ? setCallInTarget(s) : callIn(s.id))}
                                >
                                  Call in
                                </button>
                              )}
                              <button
                                className="flow-btn flow-btn-ghost flow-btn-mini"
                                disabled={advance.isPending || heldByOther(s)}
                                title="Skip — patient still advances"
                                onClick={() => setSkipTarget(s)}
                              >
                                ⏭
                              </button>
                              {canEditHere && (
                                <button
                                  className="flow-btn flow-btn-ghost flow-btn-mini"
                                  style={{ color: "var(--fre)" }}
                                  disabled={removeStep.isPending || heldByOther(s)}
                                  title="Remove this test from the patient's journey"
                                  onClick={() => setRemoveTarget(s)}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="qrow-actions">
                        {heldByMe(head) && (
                          <button
                            className="flow-btn flow-btn-ghost"
                            disabled={releaseStep.isPending}
                            title="Hand this patient back to the queue"
                            onClick={() => release(head)}
                          >
                            ↩ Release
                          </button>
                        )}
                        {canEditHere && (
                          <AddMoreTests
                            visit={visit}
                            steps={myCatalogSteps}
                            busy={addStep.isPending}
                            onAdd={sendToMyStation}
                          />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {!isAssistant && (
            <div className="q-sec">
              <div className="q-sec-head">
                <span className="flow-sec-title" style={{ margin: 0 }}>
                  {searching ? "Search results" : "Checked in today — not yet seen at this station"}
                  <span className="q-count">{notSeenHere.length}</span>
                </span>
                <div className="q-search">
                  <span aria-hidden="true">🔎</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, file no, phone or token…"
                    aria-label="Search today's patients"
                  />
                  {search && (
                    <button
                      className="q-search-x"
                      title="Clear search"
                      onClick={() => setSearch("")}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
              {searching && (
                <div className="flow-muted" style={{ marginBottom: 6 }}>
                  {searchBusy ? "Searching…" : `Matching today’s patients for “${debounced}”`}
                </div>
              )}

              {notSeenHere.length === 0 ? (
                <div className="flow-card flow-empty">
                  {searching
                    ? `No patient today matches “${debounced}”.`
                    : "Everyone checked in has either been through this station or is in your queue above."}
                </div>
              ) : (
                notSeenHere.map(({ visit: v, step }) => {
                  const settled = settledHere(v);
                  const queuedHere = myVisitIds.has(v.id);
                  return (
                    <div key={v.id} className="qrow qrow--muted">
                      <span className="qrow-tok">{v.token_number || "—"}</span>
                      <div className="qrow-main">
                        <div className="qrow-name">
                          {v.patient_name}
                          {v.is_vip && <span title="VIP">⭐</span>}
                        </div>
                        <div className="qrow-meta">
                          {v.patient_id}
                          {v.patient_age_sex ? ` · ${v.patient_age_sex}` : ""} ·{" "}
                          {VISIT_STATUS_LABEL[v.status] || v.status}
                        </div>
                        <div className="qrow-chips">
                          <span className="flow-badge fb-ink">
                            {step ? `now at ${step.step_name}` : "journey not started"}
                          </span>
                          {queuedHere && (
                            <span className="flow-badge fb-blu">already in your queue</span>
                          )}
                          {settled && !queuedHere && (
                            <span className="flow-badge fb-grn">done at this station</span>
                          )}
                        </div>
                      </div>
                      <div className="qrow-actions">
                        {canEditHere && myCatalogSteps.length > 0 && !queuedHere && (
                          <SendToStation
                            visit={v}
                            steps={myCatalogSteps}
                            busy={addStep.isPending}
                            onSend={sendToMyStation}
                          />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
        {isDoctor && (
          <DoctorReportsPanel
            rows={toPrepare}
            onReview={markPrepared}
            busy={resultsIn.isPending}
            title="Prescriptions to prepare"
            subtitle="The consultant has finished with these patients. The nurse cannot explain anything until you submit the prescription."
            emptyText="Nothing waiting. A patient appears here once their consultation ends, and leaves as soon as the prescription is on file."
            actionLabel="✓ Prescription prepared"
            actionTitle="Submit the prescription — this releases the nurse"
            stampLabel="consulted"
          />
        )}
      </div>

      {endTarget && (
        <StepReasonDialog
          title={`End ${endTarget.patient_name}'s visit?`}
          subtitle={
            isRx
              ? `Prescription Explain is recorded as done with your notes. Everything after it — billing, pharmacy — is skipped with your reason and the visit is closed. This also marks the appointment completed in OPD.`
              : `Every step still open — billing, pharmacy, anything else — is skipped with your reason and the visit is closed. This also marks the appointment completed in OPD.`
          }
          reason={endReason}
          setReason={setEndReason}
          confirmLabel="⏹ End visit"
          confirmClass="flow-btn-red"
          busy={endVisit.isPending}
          onCancel={() => {
            setEndTarget(null);
            setEndReason("");
          }}
          onConfirm={confirmEndVisit}
        />
      )}

      {skipTarget && (
        <StepReasonDialog
          title={`Skip “${skipTarget.step_name}”`}
          subtitle={`${skipTarget.patient_name} · ${skipTarget.file_no} — they’ll move to the next step. Pick or type a reason (optional).`}
          reason={skipReason}
          setReason={setSkipReason}
          confirmLabel="⏭ Skip step"
          confirmClass="flow-btn-grn"
          busy={advance.isPending}
          onCancel={() => setSkipTarget(null)}
          onConfirm={confirmSkip}
        />
      )}

      {removeTarget && (
        <StepReasonDialog
          title={`Remove “${removeTarget.step_name}”`}
          subtitle={`${removeTarget.patient_name} · ${removeTarget.file_no} — this step leaves their journey entirely. A step already started is kept and marked skipped instead.`}
          reason={removeReason}
          setReason={setRemoveReason}
          confirmLabel="✕ Remove step"
          confirmClass="flow-btn-red"
          busy={removeStep.isPending}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={confirmRemove}
        />
      )}
    </>
  );
}

function SendToStation({ visit, steps, busy, onSend }) {
  // Steps this patient already has open. Offering them again just stacks
  // duplicates — the API refuses them, so the option should say why rather
  // than failing after the click. Kept visible but disabled: silently removing
  // an option leaves the user wondering where it went.
  const already = new Set(
    (visit.steps || [])
      .filter((s) => !["completed", "skipped"].includes(s.status))
      .map((s) => s.step_catalog_id),
  );
  if (steps.length === 1) {
    const has = already.has(steps[0].id);
    return (
      <button
        className="flow-btn flow-btn-ghost"
        disabled={busy || has}
        title={
          has
            ? `${steps[0].name} is already in this patient's journey`
            : `Add "${steps[0].name}" to this patient's journey and queue them here`
        }
        onClick={() => onSend(visit, steps[0].id)}
      >
        → Send to my station
      </button>
    );
  }
  return (
    <select
      className="jb-addsel"
      value=""
      disabled={busy}
      title="Add a step for this station to the patient's journey"
      onChange={(e) => {
        if (e.target.value) onSend(visit, e.target.value);
        e.target.value = "";
      }}
    >
      <option value="">→ Send to my station…</option>
      {steps.map((c) => (
        <option key={c.id} value={c.id} disabled={already.has(c.id)}>
          {c.name}
          {already.has(c.id) ? " — already in their journey" : ""}
        </option>
      ))}
    </select>
  );
}

// A patient may need several of this station's tests. Once the first is added
// they move into the queue and off the "not yet seen" list, so the remaining
// ones have to be reachable from the queue row itself.
function AddMoreTests({ visit, steps, busy, onAdd }) {
  if (!visit || !steps?.length) return null;
  const have = new Set((visit.steps || []).map((s) => s.step_catalog_id));
  const left = steps.filter((c) => !have.has(c.id));
  if (!left.length) return null;
  return (
    <select
      className="jb-addsel"
      value=""
      disabled={busy}
      title="Add another test at this station for this patient"
      onChange={(e) => {
        if (e.target.value) onAdd(visit, e.target.value);
        e.target.value = "";
      }}
    >
      <option value="">+ test</option>
      {left.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function RemoveStepBtn({ step, busy, heldBy, onPick }) {
  return (
    <button
      className="flow-btn flow-btn-ghost"
      style={{ color: "var(--fre)", borderColor: "var(--fre)" }}
      disabled={busy || !!heldBy}
      title={
        heldBy
          ? `${heldBy} is working this patient — they must release it first`
          : "Remove this step from the patient's journey"
      }
      onClick={() => onPick(step)}
    >
      ✕ Remove
    </button>
  );
}

// Shared confirm-with-reason modal for skipping and for removing a step.
const fmtDay = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" }) : "";

function RxState({ rx, onView }) {
  if (!rx?.ready) {
    return (
      <p className="flow-muted rx-state rx-state--wait">
        ⚠ No prescription on file yet — the doctor has not written it. Explaining now means working
        from memory.
      </p>
    );
  }
  return (
    <p className="rx-state rx-state--ok">
      <span>✓ Prescription ready</span>
      {rx.doc_id ? (
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          onClick={() =>
            onView({ id: rx.doc_id, title: "Prescription", file_name: "prescription.pdf" })
          }
        >
          View prescription
        </button>
      ) : (
        <span className="flow-muted">written, but no file to open</span>
      )}
    </p>
  );
}

function CheckChips({ step, hideWaitLab = false }) {
  const pay = step?.data?.payment;
  const out = step?.data?.outside;
  const wait = step?.data?.awaiting_outside;
  if (!pay && !out?.sent && !wait) return null;
  return (
    <>
      {pay &&
        (pay.status === "paid" ? (
          <span className="flow-badge fb-grn" title={`Confirmed by ${pay.by || "—"}`}>
            paid
          </span>
        ) : (
          <span className="flow-badge fb-red" title={pay.note || "Collected before payment"}>
            unpaid{pay.due_amount ? ` ₹${pay.due_amount}` : ""}
          </span>
        ))}
      {out?.sent && (
        <span
          className="flow-badge fb-amb"
          title={
            out.mode === "patient_goes"
              ? "Patient went to this lab themselves"
              : "Sample drawn here, couriered out"
          }
        >
          outside · {out.lab_name}
          {out.expected_on ? ` · due ${fmtDay(out.expected_on)}` : ""}
        </span>
      )}
      {wait && (wait.expected_on || !hideWaitLab) && (
        <span className="flow-badge fb-amb" title="Waiting on an outside lab's report">
          {hideWaitLab ? "" : `from ${wait.lab_name}`}
          {wait.expected_on ? `${hideWaitLab ? "" : " · "}due ${fmtDay(wait.expected_on)}` : ""}
        </span>
      )}
    </>
  );
}

function StepReasonDialog({
  title,
  subtitle,
  reason,
  setReason,
  confirmLabel,
  confirmClass,
  busy,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flow-card"
        style={{ width: "100%", maxWidth: 380, borderRadius: 10 }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div className="flow-muted" style={{ marginBottom: 10 }}>
          {subtitle}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {SKIP_REASONS.map((r) => (
            <button
              key={r}
              className={`flow-btn ${reason === r ? "flow-btn-primary" : "flow-btn-ghost"}`}
              style={{ padding: "5px 10px", fontSize: 12 }}
              onClick={() => setReason(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onConfirm()}
          placeholder="Reason (optional)…"
          style={{ width: "100%", padding: "8px 10px", marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="flow-btn flow-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={`flow-btn ${confirmClass}`} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Role-specific data-entry forms. Values are stored in step.data on advance.
function StationForm({ form, value, onChange, labAction }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  if (form === "vitals") {
    return <VitalsForm value={value} onChange={onChange} />;
  }
  if (form === "lab") {
    return (
      <Field label={labAction?.label || "Result notes"}>
        <textarea
          rows={3}
          value={value.result_notes || ""}
          onChange={(e) => set("result_notes", e.target.value)}
          placeholder={labAction?.hint || "Sample taken / result ready / notes…"}
        />
      </Field>
    );
  }
  if (form === "pharmacy") {
    return (
      <Field label="Dispense notes">
        <textarea
          rows={2}
          value={value.dispense_notes || ""}
          onChange={(e) => set("dispense_notes", e.target.value)}
          placeholder="Medicines dispensed / stock notes…"
        />
      </Field>
    );
  }
  if (form === "rx") {
    return (
      <Field label="Explanation notes">
        <textarea
          rows={2}
          value={value.notes || ""}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Medicines explained · patient understood…"
        />
      </Field>
    );
  }
  return (
    <Field label="Notes">
      <textarea
        rows={3}
        value={value.notes || ""}
        onChange={(e) => set("notes", e.target.value)}
        placeholder="Notes / observations…"
      />
    </Field>
  );
}

// Core vitals (always shown) + an "+ Add vital" picker for extra standard or
// custom vitals, recorded per patient. Everything is stored in step.data, so
// any added key persists. Remounts per patient (keyed on the active step).
const OPTIONAL_VITALS = [
  ["temperature", "Temp (°F)"],
  ["rbs", "RBS (mg/dL)"],
  ["height", "Height (cm)"],
  ["bmi", "BMI"],
  ["waist", "Waist (cm)"],
  ["body_fat", "Body fat (%)"],
  ["muscle_mass", "Muscle mass (kg)"],
  ["resp_rate", "Resp. rate (/min)"],
  ["pain_score", "Pain (0–10)"],
];
const CORE_VITAL_KEYS = ["weight", "bp_sys", "bp_dia", "pulse", "spo2"];
// Shown for every patient alongside the core vitals. Still removable per
// patient via the ✕, and re-addable from the "+ Add vital" picker.
const DEFAULT_EXTRA_VITALS = ["bmi", "body_fat"];

function VitalsForm({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const removeKey = (k) => {
    const nv = { ...value };
    delete nv[k];
    onChange(nv);
    setExtras((a) => a.filter((e) => e.key !== k));
  };
  // Extra (optional/custom) vitals the associate has added for this patient.
  const [extras, setExtras] = useState(() => {
    const keys = [
      ...DEFAULT_EXTRA_VITALS,
      ...Object.keys(value).filter((k) => !CORE_VITAL_KEYS.includes(k)),
    ];
    return [...new Set(keys)].map((k) => ({
      key: k,
      label: OPTIONAL_VITALS.find((o) => o[0] === k)?.[1] || k,
    }));
  });

  const addOptional = (key) => {
    const o = OPTIONAL_VITALS.find((x) => x[0] === key);
    if (!o || extras.some((e) => e.key === key)) return;
    setExtras((a) => [...a, { key, label: o[1] }]);
  };
  const addCustom = () => {
    const label = window.prompt("Name of vital (e.g. Grip strength, GRBS, Temp axilla):");
    if (!label || !label.trim()) return;
    const key =
      "x_" +
      label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    if (!key || extras.some((e) => e.key === key)) return;
    setExtras((a) => [...a, { key, label: label.trim() }]);
  };
  const remaining = OPTIONAL_VITALS.filter((o) => !extras.some((e) => e.key === o[0]));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <Field label="Weight (kg)">
          <input
            type="number"
            value={value.weight || ""}
            onChange={(e) => set("weight", e.target.value)}
          />
        </Field>
        <Field label="BP (mmHg)">
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Sys"
              value={value.bp_sys || ""}
              onChange={(e) => set("bp_sys", e.target.value)}
            />
            <span>/</span>
            <input
              type="number"
              placeholder="Dia"
              value={value.bp_dia || ""}
              onChange={(e) => set("bp_dia", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Pulse (bpm)">
          <input
            type="number"
            value={value.pulse || ""}
            onChange={(e) => set("pulse", e.target.value)}
          />
        </Field>
        <Field label="SpO2 (%)">
          <input
            type="number"
            value={value.spo2 || ""}
            onChange={(e) => set("spo2", e.target.value)}
          />
        </Field>
        {extras.map((ex) => (
          <Field
            key={ex.key}
            label={
              <span
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                {ex.label}
                <button
                  onClick={() => removeKey(ex.key)}
                  title="Remove"
                  style={{
                    border: "none",
                    background: "none",
                    color: "var(--fre)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              </span>
            }
          >
            <input value={value[ex.key] || ""} onChange={(e) => set(ex.key, e.target.value)} />
          </Field>
        ))}
      </div>
      <select
        className="jb-add"
        style={{ marginTop: 8, maxWidth: 260 }}
        value=""
        onChange={(e) => {
          if (e.target.value === "__custom") addCustom();
          else if (e.target.value) addOptional(e.target.value);
          e.target.value = "";
        }}
      >
        <option value="">+ Add vital…</option>
        {remaining.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
        <option value="__custom">Custom…</option>
      </select>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flow-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
