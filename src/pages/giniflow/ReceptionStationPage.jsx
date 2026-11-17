import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { validCounterDate } from "../../components/billing/counter/CounterDate";
import {
  useArrivals,
  useArrivalAction,
  useWalkInSearch,
  useCheckInWalkIn,
  useReceptionHealthray,
  useReceptionHealthrayRefresh,
  useHealthrayBill,
  useArrivalBill,
  useCommitArrivalBill,
  useBackForTests,
} from "../../queries/hooks/useGiniflowReception";
import { useQueryClient } from "@tanstack/react-query";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import { useApprovalsWaiting } from "../../queries/hooks/useApprovals";
import {
  useGiniflowPauseVisit,
  useGiniflowResumeVisit,
} from "../../queries/hooks/useGiniflowQueue";
import LiveBadge from "../../components/giniflow/LiveBadge";
import BillingDesk, { DESK_TABS } from "../../components/billing/counter/BillingDesk";
import { BillBadge } from "../../components/billing/counter/PatientList";
import { approvedRefundText, useRefundsToPay } from "../../components/billing/counter/RefundsBoard";
import { receptionBillHref } from "../../components/billing/counter/billHref";
import {
  ConsultantChangesAlert,
  consultantChangeText,
  useConsultantChangesToSettle,
} from "../../components/billing/counter/ConsultantChange";
import {
  useCounterPatients,
  useCurrentShift,
  useDeskSettings,
} from "../../queries/hooks/useBilling";
import "../../styles/giniflow-station.css";
import useAuthStore from "../../stores/authStore";
import useDebounced from "../../hooks/useDebounced";
import { CAPABILITIES as CAPS, hasCapability } from "../../../shared/permissions.js";
import CancelTestControl from "../../components/giniflow/CancelTestControl";
import UrgentCancelControl from "../../components/giniflow/UrgentCancelControl";
import HomeSampleDialog, {
  HomeSampleFields,
  HomeSampleLine,
  emptyHomeAnswer,
  homePayload,
  homeProblemsNow,
} from "../../components/giniflow/HomeSampleDialog";
import { useSaveHomeSample } from "../../queries/hooks/useHomeSample";
import { REFUND_TOAST_MS, TOAST_MS } from "../../lib/testCancelText.js";
import ConfirmModal from "../../components/ui/ConfirmModal";
import IdPendingBadge from "../../components/patient/IdPendingBadge.jsx";
import OrderedServicesPanel from "../../components/billing/OrderedServicesPanel";
import StationNotice from "../../components/giniflow/StationNotice";
import JourneyBuilder, { TestPicker } from "../../components/giniflow/JourneyBuilder";
import ArrivalBill, {
  arrivalBlocker,
  arrivalButtonText,
  arrivalPayload,
  arrivalReady,
  emptyArrivalChoices,
} from "../../components/giniflow/ArrivalBill";
import { useFlowStepCatalog, useFlowVisitTypes } from "../../queries/hooks/useFlow";
import { stepPassesConditions } from "../../../shared/giniflowConditions.js";
import {
  columnForStatus,
  hasNotStarted,
  isSampleBreak,
  pauseReasonLabel,
} from "../../../shared/giniflowStatus.js";
import { useGiniflowTimeline } from "../../queries/hooks/useGiniflowBoard";
import { rupeesFromPaise } from "../../../shared/labPayment.js";
import {
  dropUnbilledTestSteps,
  requiredStepsFirst,
  testsBeforeDoctors,
} from "../../../shared/journeyOrder.js";
import { categoryColor, categoryLabel } from "../../../shared/patientCategories.js";
import {
  useJourneyPlan,
  useArriveForAppointment,
  useCheckIn,
  useJourney,
  useJourneyStep,
} from "../../queries/hooks/useGiniflowJourney";
import {
  CONSULT_CHOICES,
  keepsForChoice,
  onlineConsultChoice,
} from "../../../shared/directConsult.js";
import { labOnlyJourney, labOnlyKeepsStep, withProcedure } from "../../../shared/labOnly.js";
import { homeStillNeeded } from "../../../shared/homeCollectors.js";
import LabSiteControl from "../../components/giniflow/LabSiteControl";
import { useLabSite } from "../../queries/hooks/useLabSite";

// Arrived and done. They stay on the floor list — the desk is asked about them
// — but they are not in the building.
const FINISHED_STATUSES = ["dispensed", "exited"];

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "—";

const identity = (p) =>
  `${p.age ?? "—"}${(p.sex || "")[0] || ""} · ${p.fileNo || "no file no"}${
    p.phone ? ` · ${p.phone}` : ""
  }`;

const visitCategory = (a) => {
  const booked = a.bookingType || "";
  if (/tele|online|video/i.test(booked)) return { label: "Online", cls: "b-pu" };
  if (a.walkIn) return { label: "Walk-in", cls: "b-amb" };
  if (/investigat|lab|test/i.test(booked)) return { label: "Tests only", cls: "b-tl" };
  if (/follow|f\/?u|review/i.test(booked)) return { label: "Follow-up", cls: "b-blu" };
  if (/^\s*new\b/i.test(booked)) return { label: "New", cls: "b-grn" };
  return booked ? { label: booked, cls: "b-ink" } : null;
};

const ARRIVAL_FILTERS = [
  { key: "all", label: "All", match: () => true },
  {
    key: "for_appointment",
    label: "🔔 Mark arrived for appointment",
    match: (a) => Boolean(a.awaitsAppointment),
  },
  {
    key: "lab_only",
    label: "🧪 Lab only",
    match: (a) => a.samplesOnly || visitCategory(a)?.label === "Tests only",
  },
  { key: "home", label: "🏠 Home collection", match: (a) => a.homeCollection },
  {
    key: "follow_up",
    label: "Follow-up",
    match: (a) => /follow|f\/?u|review/i.test(a.bookingType || ""),
  },
  { key: "new", label: "New", match: (a) => /^\s*new\b/i.test(a.bookingType || "") },
  { key: "walk_in", label: "🚶 Walk-in", match: (a) => a.walkIn },
];

function VisitCategory({ arrival }) {
  const category = visitCategory(arrival);
  if (!category) return null;
  return (
    <div className="dp-cat">
      <span className={`badge ${category.cls}`}>{category.label}</span>
    </div>
  );
}

// The arrival itself: which visit this is, and the stops it will take. Opened by
// "✓ Arrived" and by a walk-in check-in — nothing is written until it is
// confirmed. docs/gini-flow/29-RECEPTION-JOURNEY-PLAN.md
//
// A walk-in has no visit yet when this opens: it is created by the same press
// that plans it, so backing out of the panel leaves the patient exactly as they
// were found, with nothing on the floor to undo.
const inJourneyOrder = (list, requires = {}) =>
  requiredStepsFirst(testsBeforeDoctors(list), {
    requiresOf: (s) => requires[s.catalogId] || null,
  });

const BILL_SETTLED = ["ok", "no_tests", "procedures_only"];

const withBilledSteps = (planned, bill = null, requires = {}) => {
  const billed = bill?.steps || [];
  const ids = new Set(billed.map((b) => b.catalogId));
  const list = BILL_SETTLED.includes(bill?.status) ? dropUnbilledTestSteps(planned, ids) : planned;
  if (!billed.length) return inJourneyOrder(list, requires);
  const rest = list.filter((s) => !ids.has(s.catalogId));
  const merged = billed.map((b) => {
    const existing = list.find((s) => s.catalogId === b.catalogId);
    return existing
      ? {
          ...existing,
          billedIn: b.billedIn,
          ...(b.tests ? { tests: b.tests, billedTests: b.billedTests } : {}),
        }
      : { ...b, source: "auto" };
  });
  const vitalsAt = rest.findIndex((s) => s.catalogId === "vitals");
  if (vitalsAt < 0) {
    const inPlace = list.map((s) => merged.find((m) => m.catalogId === s.catalogId) || s);
    const added = merged.filter((m) => !list.some((s) => s.catalogId === m.catalogId));
    const after = inPlace.findIndex((s) => s.catalogId === "check_in") + 1;
    return inJourneyOrder(
      [...inPlace.slice(0, after), ...added, ...inPlace.slice(after)],
      requires,
    );
  }
  const at = vitalsAt + 1;
  return inJourneyOrder([...rest.slice(0, at), ...merged, ...rest.slice(at)], requires);
};

const billNote = (bill, loading) => {
  if (loading) return "Checking the HealthRay bill for lab and machine tests…";
  if (!bill) return null;
  if (bill.status === "ok") {
    const parts = [];
    if (bill.labTests.length) parts.push(`${bill.labTests.length} lab test(s)`);
    if (bill.machines.length) parts.push(bill.machines.join(", "));
    return `✓ Added from the HealthRay bill: ${parts.join(" + ")} — tests not on the bill were left out; mark the payment on the Payments tab before the lab can start`;
  }
  if (bill.status === "procedures_only")
    return `✓ From the HealthRay bill: ${bill.procedure.name} — a procedure, no lab or machine tests; test steps were left out of the journey`;
  if (bill.status === "no_tests")
    return "Today's HealthRay bill has no lab or machine tests — test steps were left out of the journey";
  if (bill.status === "blocked")
    return bill.blockedUntil
      ? `HealthRay is not reachable until ${clock(bill.blockedUntil)} — add tests by hand if the patient has any`
      : "Couldn't read the HealthRay bill just now — add tests by hand if the patient has any, or try again shortly";
  if (bill.status === "loading")
    return "Checking the HealthRay bill — another bill is being read; test steps are kept until it's in";
  if (bill.status === "no_bill")
    return "No HealthRay bill for today yet — test steps are kept and checked once the bill is in";
  if (bill.status === "no_patient") return "This patient is not linked to HealthRay yet";
  return "Could not read the HealthRay bill — add tests by hand if the patient has any";
};

const CONSULT_CHAIN = ["with_sd", "with_doctor"];

function CheckInPanel({ arrival, onClose, onDone, onFailed, onNote }) {
  const { data: visitTypes = [] } = useFlowVisitTypes();
  const [visitTypeId, setVisitTypeId] = useState(arrival.suggestedVisitTypeId || null);
  const [labOnlyChosen, setLabOnlyChosen] = useState(false);
  const samplesOnly = arrival.samplesOnly || labOnlyChosen;
  const [steps, setSteps] = useState(null);
  const bookedDoctor = useAuthStore((st) =>
    (st.doctorsList || []).find((d) => d.id === arrival.assignedDoctorId),
  );
  const seesWithoutChief = bookedDoctor?.chief_step === false;
  const seesChiefOnly = !arrival.consultsDirect && bookedDoctor?.chief_step === true;
  const defaultChoice = seesChiefOnly ? "chief" : "consultant";
  const [consultChoice, setConsultChoice] = useState(defaultChoice);
  const choiceTouched = useRef(false);
  useEffect(() => {
    if (!choiceTouched.current) setConsultChoice(defaultChoice);
  }, [defaultChoice]);
  const visitType = (visitTypes || []).find((t) => t.id === visitTypeId) || null;
  const onlineChoice = visitType?.for_online
    ? onlineConsultChoice(!arrival.consultsDirect && bookedDoctor?.chief_step === true)
    : null;
  const planChoice = onlineChoice || consultChoice;
  // Answers to the template's conditions. Only the keys this type's template
  // actually uses ever appear, and every one starts true: the journey a desk
  // sees on open is the journey they saw before this gate existed, and saying
  // "no tests today" is now one tick instead of deleting five rows.
  const [conditions, setConditions] = useState({});
  const labType = (visitTypes || []).find((t) => t.for_lab_only) || null;
  const pickableTypes = useMemo(
    () => (visitTypes || []).filter((t) => !t.for_lab_only),
    [visitTypes],
  );
  const { data: labPlan } = useJourneyPlan(arrival.samplesOnly ? labType?.id : null);
  const { data: typePlan } = useJourneyPlan(visitTypeId);
  const savedLab = !!arrival.samplesOnly && labPlan?.length > 0;
  const waitingLab = !!arrival.samplesOnly && !!labType && labPlan === undefined;
  const plan = waitingLab ? undefined : savedLab ? labPlan : typePlan;
  const checkIn = useCheckIn();
  const arriveForAppointment = useArriveForAppointment();
  const forAppointment = Boolean(arrival.forAppointment && arrival.awaitsAppointment);
  const alreadyHad = useMemo(
    () => new Set(forAppointment ? arrival.awaitsAppointment.have : []),
    [forAppointment, arrival],
  );
  const checkInWalkIn = useCheckInWalkIn();
  const saving = checkIn.isPending || checkInWalkIn.isPending || arriveForAppointment.isPending;
  const canBill = useCanBill();
  const { data: deskSettings } = useDeskSettings({ enabled: canBill });
  const billHere = canBill && deskSettings?.bill_at_check_in === true;
  const [billFor, setBillFor] = useState(null);
  const [arrivalChoices, setArrivalChoices] = useState(emptyArrivalChoices);
  const [arrivalError, setArrivalError] = useState(null);
  const { data: labSite } = useLabSite(forAppointment ? null : arrival.visitId);
  const homeNow = labSite ? labSite.site === "home" : arrival.homeCollection;
  const asksHome = Boolean(
    !forAppointment && arrival.visitId && homeNow && arrival.homeRecordsOn && !arrival.homeRecord,
  );
  const saveHome = useSaveHomeSample();
  const [homeAnswer, setHomeAnswer] = useState(emptyHomeAnswer);
  const [homeSaved, setHomeSaved] = useState(false);
  const [homeTouched, setHomeTouched] = useState(false);
  const homeProblems = asksHome && !homeSaved ? homeProblemsNow(homeAnswer, { brief: true }) : {};
  const homeMissing = Object.keys(homeProblems).length > 0;
  const billVisitId = billFor || arrival.visitId;
  const journeyPlan = useDebounced(
    useMemo(
      () => (billFor ? null : { visitTypeId, steps: steps || [] }),
      [billFor, visitTypeId, steps],
    ),
    300,
  );
  const { data: bill, isLoading: billLoading } = useHealthrayBill(arrival.patientId);
  const stepsBill = useRef(null);
  const arrivalBill = useArrivalBill(
    billVisitId,
    {
      skip: arrivalChoices.skip,
      add: arrivalChoices.add.map((item) => item.id),
      remove: arrivalChoices.remove.map((item) => item.id),
      plan: journeyPlan,
    },
    billHere &&
      (Boolean(billFor) ||
        (steps !== null &&
          journeyPlan?.steps === steps &&
          !billLoading &&
          stepsBill.current === (bill || null))),
  );
  const commitArrivalBill = useCommitArrivalBill();
  const { data: shift } = useCurrentShift({ enabled: billHere });
  const shiftOpen = Boolean(shift?.is_open);
  const billRef = useRef(null);
  billRef.current = bill || null;
  const { data: catalog = [] } = useFlowStepCatalog();
  const requires = useRef({});
  requires.current = Object.fromEntries(
    catalog.filter((c) => c.machine_requires_before).map((c) => [c.id, c.machine_requires_before]),
  );
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const notYetDone = (list) => list.filter((s) => !s.catalogId || !alreadyHad.has(s.catalogId));
  const forPatient = (list) =>
    forAppointment
      ? notYetDone(list)
      : samplesOnly
        ? withProcedure(
            labOnlyJourney(list, catalogRef.current, {
              withLeg: labOnlyChosen && !arrival.samplesOnly,
              saved: savedLab,
            }),
            stepsBill.current?.procedure,
            { only: stepsBill.current?.status === "procedures_only" },
          )
        : list;

  useEffect(() => {
    if (!bill) return;
    stepsBill.current = bill;
    setSteps((current) => current && forPatient(withBilledSteps(current, bill, requires.current)));
  }, [bill]);

  const askable = useMemo(
    () =>
      [...new Set((plan || []).filter((p) => p.conditionKey).map((p) => p.conditionKey))].filter(
        (k) => k !== "needs_chief",
      ),
    [plan],
  );

  useEffect(() => {
    setConditions(Object.fromEntries(askable.map((k) => [k, true])));
  }, [askable, visitTypeId]);

  // The template loads when the TYPE or an ANSWER changes — never merely because
  // the query refetched. A refetch on window focus, or the invalidation another
  // panel causes, would otherwise throw away everything reception had edited and
  // check the patient in on a journey they did not build.
  const loadedFor = useRef(null);
  const answerKey = `${visitTypeId}|${askable.map((k) => `${k}:${conditions[k] !== false}`).join(",")}|${planChoice}|${samplesOnly && catalog.length > 0}|${savedLab}`;
  useEffect(() => {
    if (!plan || loadedFor.current === answerKey) return;
    loadedFor.current = answerKey;
    // A consultant the booking already named is filled in, so the desk confirms
    // rather than picks from an empty box — and so an assignment that already
    // exists is not quietly replaced by a blank.
    const preassigned = (step) =>
      step.chainStatus === "with_doctor" && arrival.assignedDoctorId
        ? { staffId: String(arrival.assignedDoctorId), staffName: arrival.assignedDoctorName }
        : step.chainStatus === "with_sd" && onlineChoice === "chief" && arrival.assignedDoctorId
          ? { staffId: String(arrival.assignedDoctorId), staffName: arrival.assignedDoctorName }
          : step.chainStatus === "with_sd" && arrival.assignedSdId
            ? { staffId: String(arrival.assignedSdId), staffName: arrival.assignedSdName }
            : null;
    stepsBill.current = billRef.current;
    setSteps((current) => {
      // Toggling an answer rebuilds the template half of the list, so the edits
      // already made to the steps that survive have to be carried across —
      // otherwise answering "no dietitian" would also silently reset the
      // consultant the desk had just chosen three rows above.
      const kept = new Map(
        (current || []).filter((s) => s.source === "template").map((s) => [s.catalogId, s]),
      );
      const template = plan
        .filter((p) => p.included && stepPassesConditions(p, conditions))
        .filter((p) => keepsForChoice(p, planChoice))
        .filter((p) => !samplesOnly || labOnlyKeepsStep(p))
        .map((p) => {
          const base = { ...p, ...(preassigned(p) || {}) };
          const prev = kept.get(p.catalogId);
          return prev
            ? { ...base, minutes: prev.minutes, staffId: prev.staffId, staffName: prev.staffName }
            : base;
        });
      return forPatient(
        withBilledSteps(
          [
            ...template,
            // Steps the desk added by hand survive a change of type: retyping an
            // X-Ray because they corrected the visit type is how a screen gets
            // abandoned.
            ...(current || []).filter((s) => s.source === "added" || s.source === "custom"),
          ],
          billRef.current,
          requires.current,
        ),
      );
    });
  }, [plan, answerKey, arrival, conditions]);

  const consultSteps = useMemo(
    () => (plan || []).filter((p) => p.included && CONSULT_CHAIN.includes(p.chainStatus)),
    [plan],
  );
  const choiceKeepsConsult = (choice) => consultSteps.some((p) => keepsForChoice(p, choice));
  const showConsultChoice = !visitType?.for_online && !samplesOnly && consultSteps.length > 0;

  useEffect(() => {
    if (consultChoice !== "both" && consultSteps.length && !choiceKeepsConsult(consultChoice))
      setConsultChoice("both");
  }, [consultSteps]);

  const list = steps || [];
  const consultantMissing =
    !arrival.assignedDoctorId &&
    list.some((s) => s.chainStatus === "with_doctor") &&
    !list.some((s) => s.chainStatus === "with_doctor" && s.staffId);
  const arrivalPreview = billHere ? arrivalBill.data : null;
  const billsAtArrival = Boolean(arrivalPreview?.outstanding);
  const arrivalBusy =
    commitArrivalBill.isPending || (arrivalBill.isFetching && arrivalBill.isPlaceholderData);
  const billPending = billHere && Boolean(billVisitId) && !arrivalBill.data && !arrivalBill.isError;
  const blocked =
    saving ||
    saveHome.isPending ||
    homeMissing ||
    arrivalBusy ||
    !list.length ||
    consultantMissing ||
    (billsAtArrival && !arrivalReady(arrivalPreview, arrivalChoices, shiftOpen));
  const laterBlocked = saving || homeMissing || arrivalBusy || !list.length || consultantMissing;
  const lockedBecause = ({ withBill = true } = {}) => {
    if (saving) return "Checking in…";
    if (saveHome.isPending) return "Saving the home sample…";
    if (homeMissing)
      return `Home sample — still needed: ${homeStillNeeded(homeProblems).join(", ")}`;
    if (arrivalBusy || billPending) return "Working out the bill — wait a moment";
    if (!list.length) return "Add at least one step to the journey";
    if (consultantMissing) return "Choose the consultant on the consultation step";
    if (withBill && billsAtArrival)
      return arrivalBlocker(arrivalPreview, arrivalChoices, shiftOpen);
    return null;
  };
  const minutes = list.reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
  const doneBy = new Date(Date.now() + minutes * 60000).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });

  const submit = async (sendWhatsapp, { bill: withBill = true } = {}) => {
    try {
      if (asksHome && !homeSaved) {
        await saveHome.mutateAsync({
          visitId: arrival.visitId,
          ...homePayload(homeAnswer, { brief: true }),
        });
        setHomeSaved(true);
      }
      let visitId = arrival.visitId;
      if (!visitId) {
        const created = await checkInWalkIn.mutateAsync({
          patientId: arrival.patientId,
          appointmentId: arrival.appointmentId,
        });
        // The sync, or another desk, moved them past reception while this panel
        // was open. Planning a journey onto that visit would only earn a 409.
        if (created.unchanged) {
          onNote(
            `${arrival.name} was already checked in — ${String(created.status || "").replace(/_/g, " ")}`,
          );
          onClose();
          return;
        }
        visitId = created.visitId;
      }
      const r = await (forAppointment ? arriveForAppointment : checkIn).mutateAsync({
        visitId,
        visitTypeId,
        steps: list,
        sendWhatsapp: forAppointment ? false : sendWhatsapp,
      });
      const billed =
        withBill && billsAtArrival && arrival.visitId ? await collectAtArrival(visitId) : false;
      const stayOpen = billHere && Boolean(visitId) && !billed;
      if (stayOpen) setBillFor(visitId);
      onDone({ ...arrival, visitId }, r, sendWhatsapp, stayOpen);
    } catch (e) {
      onFailed(e);
    }
  };

  const collectAtArrival = async (visitId) => {
    setArrivalError(null);
    try {
      const done = await commitArrivalBill.mutateAsync({
        visitId,
        ...arrivalPayload(arrivalPreview, arrivalChoices),
      });
      onNote(
        `${arrival.name}: bill ${done.billNo || "saved"} — ${done.status === "final" ? "paid and final" : "paid, still a draft"}${done.notFinal ? ` (${done.notFinal})` : ""}`,
      );
      return true;
    } catch (e) {
      const changed = e?.response?.data?.code === "amount_changed";
      setArrivalError(
        changed
          ? "The amount changed while checking in — check the new total, then collect."
          : `${arrival.name} is checked in, but the payment was not taken: ${e?.response?.data?.error || "try again"}.`,
      );
      if (changed) setArrivalChoices((c) => ({ ...c, paid: {} }));
      return false;
    }
  };

  const collectAfterCheckIn = async () => {
    if (await collectAtArrival(billFor)) onClose();
  };

  return (
    <div
      className="detail-overlay"
      onMouseDown={(e) => {
        const busy = saving || saveHome.isPending || commitArrivalBill.isPending;
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="detail-pane ci-pane" role="dialog" aria-label="Check in">
        <div className="dp-head">
          <div className="dp-name">{arrival.name}</div>
          <div className="dp-meta">{identity(arrival)}</div>
          <VisitCategory arrival={arrival} />
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner ci-panel">
            {!forAppointment &&
              arrival.visitId &&
              (homeNow || (steps || []).some((s) => s.catalogId === "blood_sample")) && (
                <LabSiteControl visitId={arrival.visitId} atCheckIn />
              )}
            {asksHome && (
              <section
                className="ci-home"
                aria-label="Home collection — ask the patient"
                onBlur={(e) => {
                  if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
                    setHomeTouched(true);
                  }
                }}
              >
                <div className="ci-home__title">🏠 Home collection — ask the patient</div>
                {homeSaved ? (
                  <p className="ci-home-need" role="status">
                    Home sample saved.
                  </p>
                ) : (
                  <HomeSampleFields
                    value={homeAnswer}
                    onChange={setHomeAnswer}
                    problems={homeProblems}
                    showErrors={homeTouched}
                    withNote={false}
                    sampleOnly
                  />
                )}
              </section>
            )}
            <div className="wi-head">
              <strong>What is this visit?</strong>
            </div>
            {forAppointment && (
              <div className="dp-hint" role="status">
                Arrived for their appointment
                {arrival.awaitsAppointment.booking ? ` — ${arrival.awaitsAppointment.booking}` : ""}
                . The lab stops already done stay done; the stops below are added after them.
              </div>
            )}
            {billFor && (
              <div className="dp-hint" role="status">
                ✓ {arrival.name} is checked in —{" "}
                {billsAtArrival
                  ? "collect below, or open their bill."
                  : "open their bill to take the payment."}
              </div>
            )}
            {billNote(bill, billLoading) && (
              <div className="dp-hint">{billNote(bill, billLoading)}</div>
            )}
            {showConsultChoice && (
              <div className="dp-hint" style={{ marginBottom: "8px" }}>
                <strong className="consultation-type-label">Consultation Type:</strong>

                <div className="consultation-options">
                  {CONSULT_CHOICES.map((c) => {
                    const unavailable =
                      !choiceKeepsConsult(c.value) ||
                      (arrival.consultsDirect && c.value !== "consultant");
                    return (
                      <label key={c.value} className={unavailable ? "is-disabled" : undefined}>
                        <input
                          type="radio"
                          name="consultChoice"
                          value={c.value}
                          checked={consultChoice === c.value}
                          disabled={unavailable}
                          onChange={() => {
                            choiceTouched.current = true;
                            setConsultChoice(c.value);
                          }}
                        />
                        {c.label}
                      </label>
                    );
                  })}
                </div>
                {arrival.consultsDirect ? (
                  <div>
                    {arrival.assignedDoctorName || "This consultant"} sees patients without the
                    Chief Endocrinologist step.
                  </div>
                ) : (
                  seesWithoutChief &&
                  !choiceTouched.current && (
                    <div>
                      {arrival.assignedDoctorName || "This consultant"}'s patients skip the Chief
                      Endocrinologist steps (Settings → Doctor Management).
                    </div>
                  )
                )}
              </div>
            )}

            <JourneyBuilder
              steps={list}
              onChange={setSteps}
              visitTypes={pickableTypes}
              visitTypeId={visitTypeId}
              onTypeChange={(id) => {
                setLabOnlyChosen(false);
                setVisitTypeId(id);
              }}
              labOnly={samplesOnly}
              onLabOnly={
                arrival.samplesOnly
                  ? undefined
                  : () => {
                      setLabOnlyChosen(true);
                      const testsType = pickableTypes.find((t) => t.for_tests);
                      if (testsType) setVisitTypeId(testsType.id);
                    }
              }
              askable={askable}
              conditions={conditions}
              onConditionChange={(key, value) => setConditions((c) => ({ ...c, [key]: value }))}
            />

            {arrival.phone && (
              <div className="ci-wa">
                <div className="ci-wa-t">📱 WhatsApp preview</div>
                <div>
                  🏥 Gini Advanced Care
                  <br />
                  Namaste {(arrival.name || "").split(" ")[0]} — file {arrival.fileNo || "—"}
                  <br />
                  Est. visit: ~{minutes} min · Done by ~{doneBy}
                </div>
              </div>
            )}

            {!list.length && (
              <div className="dp-hint">
                Add at least one step — a journey with no stops tells the floor nothing.
              </div>
            )}

            {consultantMissing && (
              <div className="dp-hint" role="alert">
                No consultant is booked for {arrival.name}. Choose one on the consultant step before
                checking in.
              </div>
            )}
            {billHere && billVisitId && (
              <ArrivalBill
                preview={arrivalPreview}
                isLoading={arrivalBill.isLoading}
                isError={arrivalBill.isError}
                choices={arrivalChoices}
                onChange={setArrivalChoices}
                error={arrivalError}
                shiftOpen={shiftOpen}
                visitId={billVisitId}
              />
            )}
          </div>
        </div>

        {billFor ? (
          <div className="dp-foot">
            {billsAtArrival && (
              <button
                type="button"
                className="btn-full st-btn st-btn-grn"
                disabled={arrivalBusy || !arrivalReady(arrivalPreview, arrivalChoices, shiftOpen)}
                onClick={collectAfterCheckIn}
              >
                {commitArrivalBill.isPending
                  ? "Collecting…"
                  : arrivalButtonText(arrivalPreview, arrivalChoices, true)}
              </button>
            )}
            <Link
              className={`${billsAtArrival ? "" : "btn-full "}st-btn ${billsAtArrival ? "st-btn-g" : "st-btn-grn"}`}
              to={receptionBillHref({ visit: billFor })}
            >
              Open bill →
            </Link>
            <button type="button" className="st-btn st-btn-g" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <div className="dp-foot">
            {homeMissing && (
              <p className="ci-home-need btn-full" role="status">
                Home sample — still needed: {homeStillNeeded(homeProblems).join(", ")}
              </p>
            )}
            <button
              className="btn-full st-btn st-btn-grn"
              disabled={blocked}
              title={blocked ? lockedBecause() || undefined : undefined}
              onClick={() => submit(false)}
            >
              {saving || commitArrivalBill.isPending
                ? "Checking in…"
                : billPending
                  ? "Working out the bill…"
                  : billsAtArrival
                    ? arrivalButtonText(arrivalPreview, arrivalChoices, false)
                    : forAppointment
                      ? "✓ Arrived for appointment"
                      : arrival.phone
                        ? "✓ Check in only"
                        : "✓ Check in"}
            </button>
            {arrival.phone && !forAppointment && (
              <button
                className="st-btn st-btn-g"
                disabled={blocked}
                title={blocked ? lockedBecause() || undefined : undefined}
                onClick={() => submit(true)}
              >
                {billsAtArrival ? "Same + send WhatsApp" : "Check in + send WhatsApp"}
              </button>
            )}
            {billsAtArrival && (
              <button
                type="button"
                className="st-btn st-btn-g"
                disabled={laterBlocked}
                title={laterBlocked ? lockedBecause({ withBill: false }) || undefined : undefined}
                onClick={() => submit(false, { bill: false })}
              >
                Check in only — bill later
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The stops a patient still has, opened from their row. An ECG or an X-Ray has
// no board column, so nothing but this can complete it — the board would show
// them "with the consultant" for the whole time they were at the X-Ray.
function ProceduresPanel({ arrival, onClose }) {
  const canBill = useCanBill();
  return (
    <div className="detail-overlay">
      <div className="detail-pane ci-pane" role="dialog" aria-label="Procedures">
        <div className="dp-head">
          <div className="dp-name">{arrival.name}</div>
          <div className="dp-meta">{identity(arrival)} · procedures priced for this patient</div>
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
          </div>
        </div>
        <div className="dp-sec">
          <OrderedServicesPanel station="reception" visitId={arrival.visitId} readOnly={!canBill} />
        </div>
      </div>
    </div>
  );
}

function BackForTestsPanel({ arrival, onClose, onNote }) {
  const [tests, setTests] = useState([]);
  const send = useBackForTests();
  const submit = () =>
    send.mutate(
      { visitId: arrival.visitId, tests },
      {
        onSuccess: () => {
          onNote(
            `${arrival.name} is back for tests — ${tests.join(", ")} sent to Payments and the lab`,
          );
          onClose();
        },
        onError: (e) =>
          onNote(e?.response?.data?.error || "Could not send the patient back for tests"),
      },
    );
  return (
    <div className="detail-overlay">
      <div className="detail-pane ci-pane" role="dialog" aria-label="Back for tests">
        <div className="dp-head">
          <div className="dp-name">{arrival.name}</div>
          <div className="dp-meta">
            {identity(arrival)} · {arrival.statusLabel} · tests ordered after the visit
          </div>
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose} disabled={send.isPending}>
              ← Back
            </button>
          </div>
        </div>
        <div className="dp-sec">
          <p className="ar-note">
            The visit reopens for these tests only. Consultation, Rx desk and pharmacy stay done;
            the patient exits again once the reports are in.
          </p>
          <TestPicker picked={tests} onChange={setTests} withMachines />
          <button
            type="button"
            className="st-btn st-btn-grn"
            disabled={!tests.length || send.isPending}
            onClick={submit}
          >
            {send.isPending
              ? "Sending…"
              : `Send back for ${tests.length || ""} test${tests.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const proceduresText = (services) =>
  `🩹 ${services.count} procedure${services.count === 1 ? "" : "s"} · ₹${rupeesFromPaise(services.total)}`;

function JourneyPanel({ arrival, onClose }) {
  const { data, isLoading } = useJourney(arrival.visitId);
  const { data: timeline } = useGiniflowTimeline(arrival.visitId);
  const step = useJourneyStep();
  const steps = data?.steps || [];
  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const planColumns = new Set(
    steps.map((s) => s.chainStatus && columnForStatus(s.chainStatus)).filter(Boolean),
  );
  if (planColumns.has("doctor")) planColumns.add("wait_doctor");
  const floorSteps = (timeline?.steps || []).filter((t) => {
    const column = columnForStatus(t.status);
    return column && column !== "checked_in" && !planColumns.has(column);
  });
  const doctorName = arrival.assignedDoctorName || arrival.assignedSdName || null;

  return (
    <div className="detail-overlay">
      <div className="detail-pane ci-pane" role="dialog" aria-label="Journey">
        <div className="dp-head">
          <div className="dp-name">{arrival.name}</div>
          <div className="dp-meta">
            {identity(arrival)}
            {arrival.slot ? ` · ${arrival.slot}` : ""}
            {doctorName ? ` · ${doctorName}` : ""}
          </div>
          <VisitCategory arrival={arrival} />
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner ci-panel">
            {isLoading && <div className="empty-note">Loading…</div>}
            {steps.length > 0 && (
              <div className="dp-hint">
                {data.doneCount} of {data.totalCount} stops done
                {skippedCount ? ` · ${skippedCount} skipped` : ""} · ~{data.plannedTotalMin}m
                planned
                {data.currentStep
                  ? ` · now: ${data.currentStep}`
                  : data.nextStep
                    ? ` · next: ${data.nextStep}`
                    : ""}
              </div>
            )}
            {floorSteps.length > 0 && (
              <>
                <div className="dp-hint">On the floor — stops outside this visit&apos;s plan</div>
                {floorSteps.map((t) => (
                  <div className="jp-row" key={`floor-${t.status}`}>
                    <span className={`jp-dot ${t.isCurrent ? "jp-in_progress" : "jp-done"}`} />
                    <span className="jp-name">{t.label}</span>
                    <span className="jp-min">{clock(t.enteredAt)}</span>
                    <span className="jp-status">{t.isCurrent ? "now" : "done"}</span>
                  </div>
                ))}
                <div className="dp-hint">Planned stops</div>
              </>
            )}
            {steps.map((s, i) => {
              // Its turn: everything before it is finished, one way or another.
              // Billing sits at seven of eight in every template, and a tick
              // offered from check-in invited "billed" on a patient who had not
              // yet seen the doctor.
              // Only the template's own stops are a sequence. One the desk added
              // during the visit is appended to the end of the list but happened
              // now, so it is theirs to tick when they say.
              const ordered = s.source === "template" || s.source === "auto";
              const blocker = ordered
                ? steps.slice(0, i).find((e) => !["done", "skipped"].includes(e.status))
                : null;
              return (
                <div className="jp-row" key={s.stepId}>
                  <span className={`jp-dot jp-${s.status}`} />
                  <span className="jp-name">
                    {s.order}. {s.name}
                    {s.staffName ? ` · ${s.staffName}` : ""}
                  </span>
                  <span className="jp-min">{s.minutes}m</span>
                  {/* Only the steps the board cannot see are the desk's to tick.
                      The rest follow the patient's status on their own, and a
                      button that duplicated that would let two truths
                      disagree. */}
                  {data?.finished ? (
                    // The patient has gone. What they did and did not do is a
                    // record now, and a tick offered here would be somebody
                    // writing history from memory.
                    <span className="jp-status">
                      {s.status === "skipped"
                        ? `not done${s.skipNote ? ` · ${s.skipNote}` : ""}`
                        : s.status.replace(/_/g, " ")}
                    </span>
                  ) : s.status === "skipped" && s.skipNote ? (
                    <span className="jp-status">skipped · {s.skipNote}</span>
                  ) : s.manual && s.status === "done" ? (
                    <button
                      className="st-btn st-btn-ghost"
                      disabled={step.isPending}
                      title="Mark it not done again"
                      onClick={() =>
                        step.mutate({ action: "status", stepId: s.stepId, status: "pending" })
                      }
                    >
                      ✓ done · undo
                    </button>
                  ) : s.manual && !blocker ? (
                    <button
                      className="st-btn st-btn-grn"
                      disabled={step.isPending}
                      onClick={() =>
                        step.mutate({ action: "status", stepId: s.stepId, status: "done" })
                      }
                    >
                      ✓ Done
                    </button>
                  ) : s.manual && blocker ? (
                    // Named, not just greyed: the desk needs to know WHAT comes
                    // first, or a step that cannot be ticked reads as broken.
                    <span className="jp-status">after {blocker.name}</span>
                  ) : s.manual ? (
                    <span className="jp-status">{s.status.replace(/_/g, " ")}</span>
                  ) : (
                    <span className="jp-status">{s.status.replace(/_/g, " ")}</span>
                  )}
                </div>
              );
            })}
            {!isLoading && steps.length === 0 && (
              <div className="empty-note">No journey recorded for this visit.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// How late they are against their own slot. The desk phones the patient 40
// minutes past their appointment, so lateness reads louder the longer it runs;
// a patient whose slot has not arrived yet is not a problem at all.
function LateChip({ minutesLate }) {
  if (minutesLate === null || minutesLate === undefined) return null;
  if (minutesLate < 0) return <span className="ar-late">in {Math.abs(minutesLate)}m</span>;
  const tone = minutesLate >= 30 ? " ar-late-r" : minutesLate >= 10 ? " ar-late-a" : "";
  return <span className={`ar-late${tone}`}>{minutesLate}m past slot</span>;
}

const canRecordHome = (a) => a.homeCollection && a.homeRecordsOn;

function HomeSampleButton({ arrival, onHome }) {
  if (!canRecordHome(arrival) || !onHome) return null;
  return (
    <button
      type="button"
      className="st-btn st-btn-g ar-home-btn"
      title="Record what the home collection staff reported"
      onClick={() => onHome(arrival)}
    >
      🏠 Home sample
    </button>
  );
}

function ArrivalRow({ arrival, children, note, warning, wide, showLabOnly }) {
  const queryClient = useQueryClient();
  return (
    <div className="ar-row">
      <div className="ar-slot">{arrival.slot || "—"}</div>
      <div className="ar-who">
        <div className="ar-name">
          {arrival.name}
          {arrival.priority !== "normal" && <span className="badge b-red">{arrival.priority}</span>}
          {showLabOnly && arrival.samplesOnly && <span className="badge b-tl">🧪 Lab only</span>}
          {arrival.awaitsAppointment && (
            <span className="badge b-amb">🔔 Mark arrived for appointment</span>
          )}
          {arrival.idPending && (
            <IdPendingBadge
              patientId={arrival.patientId}
              name={arrival.name}
              fileNo={arrival.fileNo}
              onSaved={() =>
                queryClient.invalidateQueries({ queryKey: ["giniflow", "reception", "arrivals"] })
              }
            />
          )}
        </div>
        <div className="ar-meta">{identity(arrival)}</div>
        {arrival.homeCollection && <HomeSampleLine record={arrival.homeRecord} />}
        {note && <div className="ar-note">{note}</div>}
        {warning && (
          <div className="ar-dup" role="alert">
            {warning}
          </div>
        )}
      </div>
      <div className={`ar-acts${wide ? " ar-acts-wide" : ""}`}>{children}</div>
    </div>
  );
}

const useCanBill = () =>
  hasCapability(
    useAuthStore((st) => st.currentDoctor?.role),
    CAPS.BILLING_DESK,
  );

function useTestsToBill(enabled) {
  const { data } = useCounterPatients("", { enabled });
  return (data?.toBill || []).filter((row) => row.hints?.tests > 0).length;
}

function useBillStates(enabled) {
  const { data } = useCounterPatients("", { enabled });
  return useMemo(
    () =>
      new Map(
        [...(data?.onFloor || []), ...(data?.left || []), ...(data?.notArrived || [])].map(
          (row) => [String(row.visitId), row.bill ?? null],
        ),
      ),
    [data],
  );
}

function BillButton({ visitId, bills }) {
  const canBill = useCanBill();
  if (!canBill || !visitId) return null;
  const key = String(visitId);
  return (
    <>
      {bills?.has(key) && <BillBadge bill={bills.get(key)} />}
      <Link
        className="st-btn st-btn-ghost"
        to={receptionBillHref({ visit: visitId })}
        title="Open this patient's bill on the Bill tab"
      >
        Bill
      </Link>
    </>
  );
}

function ExpectedRow({ arrival, onAct, onCheckIn, onHome, busy, bills }) {
  const [reason, setReason] = useState(null);

  if (reason !== null) {
    return (
      <ArrivalRow arrival={arrival} wide showLabOnly>
        <form
          className="ar-reason"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length < 2) return;
            onAct(arrival, "cancel", reason.trim());
            setReason(null);
          }}
        >
          <input
            className="ar-reason-input"
            autoFocus
            value={reason}
            placeholder="Why is it cancelled?"
            onChange={(e) => setReason(e.target.value)}
          />
          <button className="st-btn st-btn-grn" type="submit" disabled={reason.trim().length < 2}>
            Cancel visit
          </button>
          <button className="st-btn st-btn-g" type="button" onClick={() => setReason(null)}>
            Back
          </button>
        </form>
      </ArrivalRow>
    );
  }

  const twin = arrival.alreadyOnFloorAs;
  return (
    <ArrivalRow
      arrival={arrival}
      showLabOnly
      warning={
        twin &&
        `⚠ Same name and phone as ${twin.name} (${twin.fileNo}), already on the floor — ${twin.statusLabel}. Check it is not the same person before marking arrived.`
      }
    >
      <LateChip minutesLate={arrival.minutesLate} />
      {/* Arriving is no longer one click: reception says what the patient is
          here for first, so the floor and the patient both know. */}
      <button className="st-btn st-btn-grn" disabled={busy} onClick={() => onCheckIn(arrival)}>
        ✓ Arrived
      </button>
      <button
        className="st-btn st-btn-ghost"
        disabled={busy}
        onClick={() => onAct(arrival, "no-show")}
      >
        No-show
      </button>
      {/* A cancel another station will see has to say why, so it asks before it
          writes rather than after. */}
      <button className="st-btn st-btn-ghost" disabled={busy} onClick={() => setReason("")}>
        Cancel
      </button>
      <BillButton visitId={arrival.visitId} bills={bills} />
      <HomeSampleButton arrival={arrival} onHome={onHome} />
    </ArrivalRow>
  );
}

function WalkInPanel({ onClose, onCheckIn, busy }) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isFetching } = useWalkInSearch(term);
  const results = data?.results || [];

  return (
    <div className="wi-panel">
      <div className="wi-head">
        <strong>Walk-in — patient with no appointment</strong>
        <button className="st-btn st-btn-g" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sq-search">
        <input
          autoFocus
          value={search}
          placeholder="File no, phone or name"
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="sqs-count">{isFetching ? "…" : `${results.length} found`}</span>
      </div>

      {term.length < 2 && (
        <div className="wi-note">
          Search the patient first — a walk-in is booked against their existing record, never a new
          one. A patient who has never been here is registered on the patients screen.
        </div>
      )}
      {term.length >= 2 && results.length === 0 && !isFetching && (
        <div className="empty-note">
          Nobody matches “{term}”. A patient HealthRay knows but Scribe does not comes in on its own
          once they are booked in HealthRay for today.
        </div>
      )}

      {results.map((p) => (
        <div className="wi-row" key={p.patientId}>
          <div className="ar-who">
            <div className="ar-name">{p.name}</div>
            <div className="ar-meta">{identity(p)}</div>
            {/* A blocked patient is shown, not hidden: reception has to know the
                person in front of them is blocked and why the desk cannot book
                them. The reason itself is redacted for the role by the server. */}
            {p.isBlocked && <div className="wi-blocked">🚫 {p.block}</div>}
          </div>
          <div className="ar-acts">
            {p.isBlocked ? (
              <span className="badge b-red">Blocked</span>
            ) : p.status ? (
              <span className="badge b-ink">Already on today's list — {p.statusLabel}</span>
            ) : (
              <button className="st-btn st-btn-grn" disabled={busy} onClick={() => onCheckIn(p)}>
                ✓ Check in
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const matchesTerm = (item, term) => {
  const t = term.trim().toLowerCase();
  return (
    t.length >= 2 &&
    [item.fileNo, item.name].some((v) =>
      String(v || "")
        .toLowerCase()
        .includes(t),
    )
  );
};

function NotInScribe({ items }) {
  if (!items.length) return null;
  return (
    <div className="workflow-note is-warn" role="status">
      <span className="wn-ico">⚠</span>
      <div>
        <strong>{items.length} booked in HealthRay, not in Scribe yet.</strong> They appear here on
        their own once the sync catches up. If a name stays on this list for more than 10 minutes,
        tell an administrator.
        <ul className="nis-list">
          {items.map((i) => (
            <li key={i.healthrayId}>
              <strong>{i.name || "Name not given"}</strong> · {i.fileNo || "no UHID"} ·{" "}
              {i.doctor || "no doctor"} · slot {clock(i.slotAt)} · in HealthRay since{" "}
              {clock(i.firstSeenAt)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function NotFoundHelp({ term, notInScribe }) {
  const pending = notInScribe.find((i) => matchesTerm(i, term));
  return (
    <div className="empty-note">
      {pending
        ? `${pending.name || "This patient"} (${pending.fileNo || "no UHID"}) is booked in HealthRay with ${pending.doctor || "a doctor"} at ${clock(pending.slotAt)} but has not reached Scribe yet. They appear here once the sync catches up.`
        : `Nobody on today's list matches “${term}”. If they are booked in HealthRay for today, they appear here within about 3 minutes. If not, create today's visit in HealthRay first — Scribe takes patients from HealthRay's appointment list.`}
    </div>
  );
}

export function ArrivalsTab({
  search,
  setSearch,
  data,
  isLoading,
  onAct,
  onCheckedIn,
  onFailed,
  onNote,
  onPauseToggle,
  breakBusy,
  busy,
}) {
  const [walkIn, setWalkIn] = useState(false);
  // The arrival being planned. Nothing is written until it is confirmed.
  const [arriving, setArriving] = useState(null);
  const [journeyFor, setJourneyFor] = useState(null);
  const [proceduresFor, setProceduresFor] = useState(null);
  const [backForTestsFor, setBackForTestsFor] = useState(null);
  const [homeFor, setHomeFor] = useState(null);
  const [filterKey, setFilterKey] = useState("all");
  const canBill = useCanBill();
  const bills = useBillStates(canBill);
  const everyone = [
    ...(data?.expected || []),
    ...(data?.onFloor || []),
    ...(data?.notComing || []),
  ];
  const filter = ARRIVAL_FILTERS.find((f) => f.key === filterKey) || ARRIVAL_FILTERS[0];
  const expected = (data?.expected || []).filter(filter.match);
  const onFloor = (data?.onFloor || []).filter(filter.match);
  // The list holds everyone who is not expected and not a no-show, so it counts
  // the patients who have already gone home alongside the ones standing in the
  // building. One number for both read as 89 people on a floor holding 32.
  const notFinished = onFloor.filter((a) => !FINISHED_STATUSES.includes(a.status));
  const onBreak = notFinished.filter((a) => a.paused).length;
  const stillHere = notFinished.length - onBreak;
  const alreadyLeft = onFloor.length - notFinished.length;
  const notComing = (data?.notComing || []).filter(filter.match);
  const searching = (data?.query || "").length >= 2;
  const { data: healthray } = useReceptionHealthray();
  const notInScribe = healthray?.notInScribe?.items || [];
  const toMarkArrived = everyone.filter((a) => a.awaitsAppointment).length;

  return (
    <>
      <div className="ar-controls ar-controls--compact">
        <div className="sq-search">
          <input
            value={search}
            placeholder="Search today — name, file no or phone"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="st-btn st-btn-g" onClick={() => setSearch("")}>
              Clear
            </button>
          )}
        </div>
        <button className="st-btn st-btn-blu" onClick={() => setWalkIn((w) => !w)}>
          + Walk-in
        </button>
        <div className="sq-filters" role="group" aria-label="Filter arrivals">
          {ARRIVAL_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filterKey === f.key ? "on" : ""}
              aria-pressed={filterKey === f.key}
              onClick={() => setFilterKey((on) => (on === f.key ? "all" : f.key))}
            >
              {f.label}
              <span className="sq-fcount">{everyone.filter(f.match).length}</span>
            </button>
          ))}
        </div>
      </div>

      {toMarkArrived > 0 && filterKey !== "for_appointment" && (
        <div className="workflow-note is-warn" role="status">
          <span className="wn-ico">🔔</span>
          <span>
            <strong>
              {toMarkArrived} {toMarkArrived === 1 ? "patient needs" : "patients need"} “Arrived for
              appointment”
            </strong>{" "}
            — mark them when they come back to the desk.
          </span>
          <button
            type="button"
            className="st-btn st-btn-g"
            onClick={() => setFilterKey("for_appointment")}
          >
            Show them
          </button>
        </div>
      )}

      {walkIn && (
        <WalkInPanel
          onClose={() => setWalkIn(false)}
          busy={busy}
          // A walk-in has no appointment to infer anything from, so it gets the
          // same question a booked patient gets — and the same promise: the
          // visit is created by the press that plans it, not by this one.
          onCheckIn={(patient) => {
            setWalkIn(false);
            setArriving({
              patientId: patient.patientId,
              appointmentId: patient.appointmentId,
              suggestedVisitTypeId: patient.suggestedVisitTypeId,
              walkIn: true,
              name: patient.name,
              fileNo: patient.fileNo,
              age: patient.age,
              sex: patient.sex,
              phone: patient.phone,
            });
          }}
        />
      )}

      <NotInScribe items={notInScribe} />
      {searching && !isLoading && expected.length === 0 && onFloor.length === 0 && (
        <NotFoundHelp term={data.query} notInScribe={notInScribe} />
      )}

      {journeyFor && <JourneyPanel arrival={journeyFor} onClose={() => setJourneyFor(null)} />}
      {proceduresFor && (
        <ProceduresPanel arrival={proceduresFor} onClose={() => setProceduresFor(null)} />
      )}
      {backForTestsFor && (
        <BackForTestsPanel
          arrival={backForTestsFor}
          onClose={() => setBackForTestsFor(null)}
          onNote={onNote}
        />
      )}

      {homeFor && (
        <HomeSampleDialog
          arrival={homeFor}
          onClose={() => setHomeFor(null)}
          onSaved={(message) => {
            setHomeFor(null);
            onNote(message);
          }}
        />
      )}

      {arriving && (
        <CheckInPanel
          key={arriving.visitId || arriving.appointmentId || arriving.patientId}
          arrival={arriving}
          onClose={() => setArriving(null)}
          onFailed={onFailed}
          onNote={onNote}
          onDone={(arrival, result, sentWhatsapp, stayOpen) => {
            if (!stayOpen) setArriving(null);
            onCheckedIn(arrival, result, sentWhatsapp);
          }}
        />
      )}

      {/* Two columns, because the desk uses them differently: Expected is the
          worklist — the people to greet or chase — and On the floor is
          reference, checked when somebody asks "is my father in yet?". Side by
          side, the worklist stays visible while the long list scrolls. */}
      <div className="ar-split">
        <div className="ar-col">
          <div className="grp-lbl grp-lbl-sp">⏳ Expected — not here yet ({expected.length})</div>
          {isLoading && <div className="empty-note">Loading…</div>}
          {!isLoading && expected.length === 0 && (
            <div className="empty-note">
              {searching
                ? "Nobody expected matches that search."
                : filterKey !== "all"
                  ? `No ${filter.label} patients still expected.`
                  : "Everyone booked has arrived."}
            </div>
          )}
          {expected.map((a) => (
            <ExpectedRow
              key={a.visitId}
              arrival={a}
              onAct={onAct}
              onCheckIn={setArriving}
              onHome={setHomeFor}
              busy={busy}
              bills={bills}
            />
          ))}
        </div>

        <div className="ar-col">
          <div className="grp-lbl grp-lbl-sp">
            🏥 On the floor ({stillHere} here
            {onBreak > 0 ? ` · ${onBreak} on break` : ""}
            {alreadyLeft > 0 ? ` · ${alreadyLeft} left` : ""})
          </div>
          {onFloor.length === 0 && (
            <div className="empty-note">
              {filterKey !== "all"
                ? `No ${filter.label} patients on the floor.`
                : "Nobody in the building yet."}
            </div>
          )}
          {onFloor.map((a) => (
            <ArrivalRow
              key={a.visitId}
              arrival={a}
              note={a.blockedReason && `🚫 ${a.blockedReason}`}
            >
              <span className="ar-where">{a.statusLabel}</span>
              {/* Check-in is the last moment before an OPD fee is keyed into
                  HealthRay, and the only point a walk-in passes at all — so the
                  scheme is shown here whether or not anyone set it upstream. */}
              {a.schemeCode && (
                <span
                  className={`badge b-${categoryColor(a.schemeCode)}`}
                  title={
                    a.schemeOpdFee !== null
                      ? `${categoryLabel(a.schemeCode)} — OPD ₹${a.schemeOpdFee}. Key this into HealthRay; Gini cannot set it.`
                      : `${categoryLabel(a.schemeCode)} — no OPD rate entered for this scheme yet`
                  }
                >
                  {categoryLabel(a.schemeCode)}
                  {a.schemeOpdFee !== null ? ` · ₹${a.schemeOpdFee}` : ""}
                </span>
              )}
              {a.orderedServices && (
                <button
                  type="button"
                  className="badge b-tl ar-procs"
                  title="Procedures priced for this patient"
                  onClick={() => setProceduresFor(a)}
                >
                  {proceduresText(a.orderedServices)}
                </button>
              )}
              {/* Where they are in their OWN journey, which the columns cannot
                  show: a patient with an ECG and an X-Ray still to do reads the
                  same as one who is nearly finished. */}
              {/* Shown whether or not a journey exists yet: most patients are
                  checked in by the HealthRay sync and have none, and opening
                  this is what gives them one. A button that appeared only for
                  patients who already had a plan could never seed the ones who
                  did not. */}
              <button
                className="ar-journey"
                title="Their stops — and tick the ones the board cannot see"
                onClick={() => setJourneyFor(journeyFor?.visitId === a.visitId ? null : a)}
              >
                {a.journey
                  ? `${a.journey.done}/${a.journey.total}${
                      a.journey.next ? ` · next: ${a.journey.next}` : " · done"
                    }`
                  : "Journey"}
              </button>
              {/* The desk sees the patient leave and come back, so the desk is
                  who can say the clocks stop. One control showing the action that
                  applies — never both.

                  This list holds the whole day, not only the people still in the
                  building: on the floor reads "18 here · 61 left". A finished
                  visit has no clock to hold, so it gets no control — the server
                  refuses those with a 409 and a button that only ever errors is
                  worse than no button. */}
              {a.awaitsAppointment && (
                <button
                  type="button"
                  className="st-btn st-btn-grn"
                  disabled={busy}
                  title={`Their tests are done and they now have a consultant booking${
                    a.awaitsAppointment.booking ? ` (${a.awaitsAppointment.booking})` : ""
                  } — add the consultation to their journey`}
                  onClick={() => setArriving({ ...a, forAppointment: true })}
                >
                  ✓ Arrived for appointment
                </button>
              )}
              {FINISHED_STATUSES.includes(a.status) && !a.awaitsAppointment && (
                <button
                  type="button"
                  className="st-btn st-btn-ghost"
                  title="A test was ordered after the patient left — reopen the visit for it"
                  onClick={() => setBackForTestsFor(a)}
                >
                  Back for tests
                </button>
              )}
              {!FINISHED_STATUSES.includes(a.status) && a.status !== "back_for_tests" && (
                <button
                  className={`st-btn ${a.paused ? "st-btn-grn" : "st-btn-ghost"}`}
                  disabled={breakBusy}
                  title={
                    a.paused && isSampleBreak(a.pausedReason) && hasNotStarted(a.status)
                      ? "Back from their break — they go to the vitals queue and their wait starts now"
                      : hasNotStarted(a.status)
                        ? a.paused
                          ? "They are back — their wait starts again from zero, because nobody had seen them yet"
                          : "They left before anyone saw them — stop their clock until they come back"
                        : a.paused
                          ? "They are back — start the clocks again and leave the break out of their waiting time"
                          : "They have stepped out — hold their clocks until they are back"
                  }
                  onClick={() => onPauseToggle(a)}
                >
                  {a.paused && isSampleBreak(a.pausedReason)
                    ? "▶ Back"
                    : hasNotStarted(a.status)
                      ? a.paused
                        ? "▶ Restart"
                        : "⏹ Stop"
                      : a.paused
                        ? "▶ Resume"
                        : "⏸ Pause"}
                </button>
              )}
              <BillButton visitId={a.visitId} bills={bills} />
              {!FINISHED_STATUSES.includes(a.status) && (
                <HomeSampleButton arrival={a} onHome={setHomeFor} />
              )}
              <span className="ar-since">
                {a.paused
                  ? `${pauseReasonLabel(a.pausedReason) || "On break"} · on break since ${clock(a.pausedAt)}`
                  : `in since ${clock(a.checkedInAt)}`}
              </span>
            </ArrivalRow>
          ))}
        </div>
      </div>

      {notComing.length > 0 && (
        <div>
          <div className="grp-lbl grp-lbl-sp">🚫 Not coming ({notComing.length})</div>
          {notComing.map((a) => (
            <ArrivalRow key={a.visitId} arrival={a}>
              <span className="ar-where">{a.statusLabel}</span>
              {/* Undo returns them to booked; the desk then presses Arrived. A
                  no-show who turns up is re-checked-in, not un-no-showed. */}
              <button
                className="st-btn st-btn-ghost"
                disabled={busy}
                onClick={() => onAct(a, "undo")}
              >
                Undo
              </button>
            </ArrivalRow>
          ))}
        </div>
      )}
    </>
  );
}

const syncedAt = (iso) => {
  if (!iso) return "never";
  const d = new Date(iso);
  const sameDay =
    d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) ===
    new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  return sameDay
    ? clock(iso)
    : `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })} ${clock(iso)}`;
};

const REFRESH_REFUSED = {
  blocked: (s) =>
    `HealthRay is blocking Scribe right now — it retries at ${clock(s.blockedUntil)}. Check patients in by hand meanwhile.`,
  running: () => "A HealthRay refresh is already running — the list updates when it finishes",
  too_soon: (s) =>
    `Refreshed a moment ago — you can refresh again at ${clock(s.refresh?.nextAllowedAt)}`,
};

function HealthraySync({ onNote }) {
  const queryClient = useQueryClient();
  const { data } = useReceptionHealthray();
  const refresh = useReceptionHealthrayRefresh();
  const running = !!(data?.refresh?.running || data?.refresh?.queued);
  const workerLate = !!data?.refresh?.workerLate;
  const wasRunning = useRef(false);

  useEffect(() => {
    if (wasRunning.current && !running) {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception", "arrivals"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      const r = data?.refresh;
      if (r?.error) onNote(`HealthRay refresh failed — ${r.error}`);
      else if (r?.outcome?.alreadyRunning)
        onNote("HealthRay was already syncing — the list updates as soon as that finishes");
      else if (r?.outcome)
        onNote(`✓ Refreshed from HealthRay · ${r.outcome.addedToFloor} new on the list`);
    }
    wasRunning.current = running;
  }, [running, data, queryClient, onNote]);

  const onRefresh = () =>
    refresh.mutate(undefined, {
      onSuccess: (r) =>
        onNote(
          r.started
            ? "Refreshing from HealthRay — new bookings appear in a minute or two"
            : REFRESH_REFUSED[r.reason](r),
        ),
      onError: (e) => onNote(e?.response?.data?.error || "Could not start a HealthRay refresh"),
    });

  const blocked = !!data?.blockedUntil;
  const quiet = !!data?.syncQuiet;
  return (
    <>
      <span
        className={`tr-live${blocked || workerLate || quiet ? " is-stale" : ""}`}
        role={quiet ? "alert" : undefined}
        title={
          blocked
            ? data.blockedReason || ""
            : quiet
              ? "No successful HealthRay sync for over 15 minutes. New walk-ins will not appear until it recovers — tell an administrator."
              : "Last successful sync with HealthRay"
        }
      >
        {blocked
          ? `HealthRay blocked · retry ${clock(data.blockedUntil)}`
          : workerLate
            ? "Refresh waiting — the background sync is not responding"
            : quiet
              ? `HealthRay sync stopped · last ${syncedAt(data?.lastSyncedAt)}`
              : `HealthRay synced ${syncedAt(data?.lastSyncedAt)}`}
      </span>
      <button
        type="button"
        className="rbtn"
        disabled={running || refresh.isPending || blocked}
        onClick={onRefresh}
      >
        {running ? "Refreshing…" : "⟳ Refresh"}
      </button>
    </>
  );
}

const TAB = {
  arrivals: "arrivals",
};

const DESK_TAB_KEYS = Object.keys(DESK_TABS);

function useReceptionTab(canBill, canApprove, canCollectPharmacy) {
  const [params, setParams] = useSearchParams();
  const { data: deskSettings } = useDeskSettings({ enabled: canBill });
  const requested = params.get("tab") || TAB.arrivals;
  const isDesk = DESK_TAB_KEYS.includes(requested);
  const duesOff = deskSettings && !deskSettings.allow_pay_later;
  const tab =
    (isDesk && !canBill) ||
    (requested === DESK_TABS.requests.key && !canApprove) ||
    (requested === DESK_TABS.pharmacy.key && !canCollectPharmacy)
      ? TAB.arrivals
      : requested === DESK_TABS.dues.key && duesOff
        ? DESK_TABS.bill.key
        : isDesk || Object.values(TAB).includes(requested)
          ? requested
          : TAB.arrivals;
  const deskTabs = canBill
    ? [
        DESK_TABS.bill,
        ...(duesOff || (!deskSettings && tab !== DESK_TABS.dues.key) ? [] : [DESK_TABS.dues]),
        DESK_TABS.shift,
        DESK_TABS.refunds,
        ...(canApprove ? [DESK_TABS.requests] : []),
        ...(canCollectPharmacy ? [DESK_TABS.pharmacy] : []),
      ]
    : [];

  const setTab = useCallback(
    (key) =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set("tab", key);
        return next;
      }),
    [setParams],
  );

  const deskDate = validCounterDate(params.get("date"));

  const openBill = useCallback(
    (next, options) =>
      setParams(
        { tab: DESK_TABS.bill.key, ...(deskDate ? { date: deskDate } : {}), ...next },
        options,
      ),
    [setParams, deskDate],
  );

  const setDeskDate = useCallback(
    (day) => setParams({ tab: DESK_TABS.bill.key, ...(day ? { date: day } : {}) }),
    [setParams],
  );

  return {
    tab,
    deskTabs,
    setTab,
    openBill,
    deskDate,
    setDeskDate,
    visitId: params.get("visit") || "",
    patientId: params.get("patient") || "",
    billId: params.get("bill") || "",
  };
}

function ReceptionTabs({
  tab,
  setTab,
  deskTabs,
  arrivalsCount,
  toMarkArrivedCount,
  refundsCount,
  requestsCount,
  feeChangesCount,
  testsToBillCount,
}) {
  return (
    <div className="st-tabs rc-tabs" role="tablist" aria-label="Reception">
      <button
        type="button"
        role="tab"
        aria-selected={tab === TAB.arrivals}
        className={`st-tab${tab === TAB.arrivals ? " on" : ""}`}
        onClick={() => setTab(TAB.arrivals)}
      >
        Arrivals <span className="st-tab-n">{arrivalsCount}</span>
        {toMarkArrivedCount > 0 && (
          <span
            className="st-tab-n st-tab-n--alert"
            aria-label={`${toMarkArrivedCount} to mark arrived for appointment`}
            title="Tests done and booked with a consultant — mark “Arrived for appointment”"
          >
            🔔 {toMarkArrivedCount}
          </span>
        )}
      </button>
      {deskTabs.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="tab"
          id={entry.tabId}
          aria-controls={tab === entry.key ? entry.panelId : undefined}
          aria-selected={tab === entry.key}
          aria-describedby={
            entry.key === DESK_TABS.bill.key && testsToBillCount > 0
              ? "rc-tests-to-bill"
              : undefined
          }
          className={`st-tab${tab === entry.key ? " on" : ""}`}
          onClick={() => setTab(entry.key)}
        >
          {entry.label}
          {entry.key === DESK_TABS.bill.key && feeChangesCount > 0 && (
            <span
              className="st-tab-n st-tab-n--alert"
              aria-label={`${feeChangesCount} consultant fee change${feeChangesCount === 1 ? "" : "s"} to settle`}
              title="Consultant changed — fee to settle"
            >
              {feeChangesCount}
            </span>
          )}
          {entry.key === DESK_TABS.bill.key && testsToBillCount > 0 && (
            <>
              <span
                className="st-tab-n"
                aria-hidden="true"
                title="Tests ordered and not billed yet"
              >
                🧪 {testsToBillCount}
              </span>
              <span id="rc-tests-to-bill" hidden>
                {`${testsToBillCount} patient${testsToBillCount === 1 ? "" : "s"} with tests to bill`}
              </span>
            </>
          )}
          {entry.key === DESK_TABS.refunds.key && (
            <span className="st-tab-n" aria-label={`${refundsCount} to pay back`}>
              {refundsCount}
            </span>
          )}
          {entry.key === DESK_TABS.requests.key && (
            <span
              className={`st-tab-n${requestsCount > 0 ? " st-tab-n--alert" : ""}`}
              aria-label={`${requestsCount} request${requestsCount === 1 ? "" : "s"} waiting for you`}
            >
              {requestsCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export default function ReceptionStationPage() {
  const canBill = useCanBill();
  const approvals = useApprovalsWaiting();
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const canCollectPharmacy = hasCapability(role, CAPS.PHARMACY_COLLECT);
  const desk = useReceptionTab(canBill, approvals.any, canCollectPharmacy);
  const { tab, setTab } = desk;
  const onDesk = DESK_TAB_KEYS.includes(tab);
  const sentPatient = useLocation().state?.duePatient ?? null;
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  // The search runs in Postgres so it reaches the whole day and can match a
  // phone number the browser never receives. Debounced, because every keystroke
  // would otherwise be a query.
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: arrivals, isLoading: arrivalsLoading } = useArrivals(undefined, term);
  const live = useGiniflowLive({ date: arrivals?.date });
  const pauseVisit = useGiniflowPauseVisit();
  const resumeVisit = useGiniflowResumeVisit();
  const pauseErr = (e) =>
    showToast(e?.response?.data?.error || "Could not record that — nothing changed");

  const onPauseToggle = (a) => {
    const fresh = hasNotStarted(a.status);
    return a.paused
      ? resumeVisit.mutate(
          { visitId: a.visitId },
          {
            onSuccess: () =>
              showToast(
                fresh
                  ? `▶ ${a.name} is back — in the vitals queue, their wait starts from now`
                  : `▶ ${a.name} resumed — the break is left out of their waiting time`,
              ),
            onError: pauseErr,
          },
        )
      : pauseVisit.mutate(
          { visitId: a.visitId },
          {
            onSuccess: () =>
              showToast(
                fresh
                  ? `⏹ ${a.name} stopped — nobody had seen them yet, so their clock restarts when they return`
                  : `⏸ ${a.name} paused — their clocks are held until they are back`,
              ),
            onError: pauseErr,
          },
        );
  };
  const arrivalAction = useArrivalAction();

  const counts = arrivals?.counts || { expected: 0, onFloor: 0, notComing: 0 };

  const showToast = (msg, ms = TOAST_MS) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const refundsToPay = useRefundsToPay(canBill, (rows) =>
    showToast(approvedRefundText(rows), REFUND_TOAST_MS),
  );
  const feeChanges = useConsultantChangesToSettle(canBill, (changes) =>
    showToast(consultantChangeText(changes), REFUND_TOAST_MS),
  );
  const testsToBill = useTestsToBill(canBill);
  const [feeFocus, setFeeFocus] = useState(0);

  const failed = (e, fallback) =>
    showToast(e?.response?.data?.detail || e?.response?.data?.error || fallback);

  const ACTION_DONE = {
    arrived: (name) => `✓ ${name} checked in — they are on the floor now`,
    "no-show": (name) => `${name} marked as a no-show — their timer has stopped`,
    cancel: (name) => `${name}'s visit is cancelled — every station can see it`,
    undo: (name) => `${name} is back on the expected list`,
  };

  const onAct = (arrival, action, reason) =>
    arrivalAction.mutate(
      { visitId: arrival.visitId, action, reason },
      {
        onSuccess: (r) =>
          showToast(
            r.unchanged
              ? `${arrival.name} was already there — nothing changed`
              : ACTION_DONE[action](arrival.name),
          ),
        onError: (e) => failed(e, "Could not do that — nothing was changed"),
      },
    );

  // What the desk has to do next, said in the toast: an order raised here is
  // money still to collect, and the patient cannot reach the lab or a machine
  // until this desk clears it.
  const ordersRaised = (raised) => {
    const parts = [];
    if (raised?.labTests?.length) parts.push(`${raised.labTests.length} lab test(s)`);
    const machines = (raised?.machine || []).filter((m) => !m.alreadyThere).length;
    if (machines) parts.push(`${machines} machine test(s)`);
    return parts.length ? ` · ${parts.join(" + ")} to bill on the Bill tab` : "";
  };

  const onCheckedIn = (arrival, result, sentWhatsapp) =>
    showToast(
      result.alreadyPlanned
        ? `${arrival.name} was already checked in — their journey is unchanged`
        : `✓ ${arrival.name} checked in · ${result.totalCount} stops · ~${result.plannedTotalMin} min${ordersRaised(
            result.raised,
          )}${sentWhatsapp && result.whatsappSent ? " · WhatsApp sent" : ""}`,
    );

  const tabs = (
    <ReceptionTabs
      tab={tab}
      setTab={setTab}
      deskTabs={desk.deskTabs}
      arrivalsCount={counts.expected}
      toMarkArrivedCount={
        [
          ...(arrivals?.expected || []),
          ...(arrivals?.onFloor || []),
          ...(arrivals?.notComing || []),
        ].filter((a) => a.awaitsAppointment).length
      }
      refundsCount={refundsToPay}
      requestsCount={approvals.total}
      feeChangesCount={feeChanges.length}
      testsToBillCount={testsToBill}
    />
  );

  return (
    <div className="gf">
      <StationNotice station="reception" />
      <div className="rail rc-rail">
        <div className="rl">Reception</div>
        <div className="rsep" />
        <span className="rail-title">
          {new Date().toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
        <div className="rr">
          <LiveBadge live={live} className="tr-live" />
          <HealthraySync onNote={showToast} />
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      {onDesk ? (
        <div className="rc-desk">
          <div className="rc-desk__tabs">
            {tabs}
            {tab === DESK_TABS.bill.key && (
              <ConsultantChangesAlert
                count={feeChanges.length}
                onShow={() => setFeeFocus((n) => n + 1)}
              />
            )}
          </div>
          <BillingDesk
            tab={tab}
            visitId={desk.visitId}
            patientId={desk.patientId}
            billId={desk.billId}
            sentPatient={sentPatient}
            onOpen={desk.openBill}
            date={desk.deskDate}
            onDate={desk.setDeskDate}
            feeChanges={feeChanges}
            feeFocus={feeFocus}
          />
        </div>
      ) : (
        <div className="scroll">
          <div className="inner">
            {tabs}

            {tab === TAB.arrivals ? (
              <div className="stats stats--pay" aria-label="Arrivals today">
                <div className="stat" title="Booked, not here yet">
                  <div className="sv sv-amb">{counts.expected}</div>
                  <div className="sl">Expected</div>
                </div>
                <div className="stat" title="In the building">
                  <div className="sv sv-grn">{counts.onFloorHere ?? counts.onFloor}</div>
                  <div className="sl">
                    On the floor
                    {counts.onFloorAway > 0 ? ` · ${counts.onFloorAway} on break` : ""}
                    {counts.onFloorLeft > 0 ? ` · ${counts.onFloorLeft} left today` : ""}
                  </div>
                </div>
                <div className="stat" title="No-show or cancelled">
                  <div className="sv sv-ink">{counts.notComing}</div>
                  <div className="sl">Not coming</div>
                </div>
              </div>
            ) : null}

            <ArrivalsTab
              onCheckedIn={onCheckedIn}
              onFailed={(e) => failed(e, "Could not check this patient in — nothing was changed")}
              onNote={showToast}
              search={search}
              setSearch={setSearch}
              data={arrivals}
              isLoading={arrivalsLoading}
              onAct={onAct}
              onPauseToggle={onPauseToggle}
              breakBusy={pauseVisit.isPending || resumeVisit.isPending}
              busy={arrivalAction.isPending}
            />
          </div>
        </div>
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
