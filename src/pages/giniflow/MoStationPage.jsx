import { useEffect, useMemo, useRef, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { CHAIN } from "../../../shared/giniflowStatus";
import {
  useMoQueue,
  useMoPatient,
  useTestPanels,
  useStartWorkup,
  useExtractPlan,
  useSavePlan,
  useOrderTests,
  useReadyForDoctor,
  useReleaseWorkup,
  useTakeOver,
  useCloseWithoutDoctor,
  useAddProposal,
  useWithdrawProposal,
} from "../../queries/hooks/useGiniflowMo";
import { VoiceButton } from "../../components/giniflow/VoiceInput";
import RxSection from "./consult/RxSection";
import useAuthStore from "../../stores/authStore";
import { useTick, minutesSince, budgetColour } from "../../lib/giniflowTime";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import "../../styles/giniflow-station.css";
import StationNotice from "../../components/giniflow/StationNotice";

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

const monthLabel = (ymd) => {
  const [y, m] = (ymd || "").split("-").map(Number);
  if (!y) return "";
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
};

const dayLabel = (ymd) => {
  const [y, m, d] = (ymd || "").split("-").map(Number);
  if (!y) return "";
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
};

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : null;

// Which clock a row's timer is, in the station's own words.
const WAIT_WORD = {
  with_sd: "at my desk",
  with_vitals: "at vitals",
  with_doctor: "with the doctor",
  ready_for_doctor: "waiting for the doctor",
  doctor_done: "since the doctor",
};

// The MO reads a change, not a number — so every vital taken today carries what
// it was at the last visit. Lower is better for all four, which is why one
// direction is enough. Plan §2.4 item 3.
const VITAL_ROWS = [
  {
    key: "bp",
    label: "BP",
    of: (v) => (v?.bp_sys ? `${v.bp_sys}/${v.bp_dia}` : null),
    delta: (a, b) => a.bp_sys - b.bp_sys,
    unit: "",
  },
  {
    key: "weight",
    label: "Weight",
    of: (v) => v?.weight ?? null,
    delta: (a, b) => a.weight - b.weight,
    unit: " kg",
  },
  {
    key: "pulse",
    label: "Pulse",
    of: (v) => v?.pulse ?? null,
    delta: (a, b) => a.pulse - b.pulse,
    unit: "",
  },
  {
    key: "spo2",
    label: "SpO2",
    of: (v) => v?.spo2 ?? null,
    delta: (a, b) => a.spo2 - b.spo2,
    unit: "%",
  },
];

const deltaText = (today, last, row) => {
  if (!last || row.of(last) == null || row.of(today) == null) return null;
  const d = Number(row.delta(today, last).toFixed(1));
  if (!d) return "no change";
  return `${d > 0 ? "▲" : "▼"} ${Math.abs(d)} from ${row.of(last)}`;
};

const CATEGORY = {
  worse_out_of_range: { icon: "🔴", label: "Worse — out of range" },
  worse_in_range: { icon: "🟠", label: "Worse — in range" },
  getting_better: { icon: "🟡", label: "Getting better" },
  in_control: { icon: "✅", label: "In control" },
  no_reports: { icon: "🔵", label: "No reports" },
};

// Five groups, because "waiting on results" and "no reports at all" need
// different actions from the MO — the second is the only one they can unblock.
// Every group opens as full cards and every group collapses, the same way the
// vitals station's do — an MO on a full day shuts the pipeline to see their own
// queue, and nothing is hidden unless they ask for it.
const GROUPS = [
  { key: "withMe", icon: "🟢", title: "With me now" },
  { key: "waitingForMe", icon: "⏳", title: "Waiting for me" },
  { key: "awaitingResults", icon: "🔵", title: "Waiting on results" },
  { key: "missingReports", icon: "🔴", title: "Missing reports", sub: "can't proceed" },
  // Read-only: an MO cannot claim these, because claiming from a pre-vitals
  // status would skip the vitals station, and another SD's patient is theirs.
  // Shown rather than hidden so the floor stays legible.
  {
    key: "inPipeline",
    icon: "🔵",
    title: "In pipeline",
    sub: "vitals not done yet",
    readOnly: true,
  },
  { key: "withOtherSd", icon: "👥", title: "With another SD", readOnly: true },
  { key: "done", icon: "✅", title: "Passed on / closed" },
];

// Same control the vitals station uses: the button IS the heading, so it keeps
// heading semantics and states whether the section is open.
function GroupHead({ icon, title, sub, count, open, onToggle, id }) {
  return (
    <h2 className="sq-gh">
      <button
        type="button"
        className="sq-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span aria-hidden="true">{icon}</span> {title}
        {sub && <span className="sq-ghsub">— {sub}</span>}
        <span className="sq-count">{count}</span>
      </button>
    </h2>
  );
}

// Lab-track statuses that mean the sample has not been taken yet — the server
// refuses a repeat of any test still sitting in one of them.
const UNCOLLECTED = new Set(["ordered", "payment_pending", "paid"]);

const URGENCY = [
  { key: "today", label: "Today → lab now" },
  { key: "tomorrow", label: "Tomorrow → reception" },
  { key: "next_visit", label: "Next visit" },
];

// Plan §2.3: the same five stops on every row, so an MO can see at a glance how
// far down the floor a patient already is.
const RAIL = [
  { label: "Check-in", at: "checked_in" },
  { label: "Vitals", at: "vitals_pending" },
  { label: "MO", at: "sd_pending" },
  { label: "Doctor", at: "ready_for_doctor" },
  { label: "Pharmacy", at: "pharmacy_pending" },
];
const RAIL_END = ["vitals_done", "sd_pending", "ready_for_doctor", "pharmacy_pending", null];

function JourneyRail({ status }) {
  const here = CHAIN.indexOf(status);
  return (
    <div className="mo-rail">
      {RAIL.map((stop, i) => {
        const from = CHAIN.indexOf(stop.at);
        const doneAt = RAIL_END[i] ? CHAIN.indexOf(RAIL_END[i]) : CHAIN.length;
        const state = here < 0 || here < from ? "todo" : here >= doneAt ? "done" : "now";
        return (
          <span key={stop.label} className={`mr-stop mr-${state}`}>
            {stop.label}
            {state === "done" ? " ✓" : ""}
          </span>
        );
      })}
    </div>
  );
}

// The markers a Gini patient is managed on. Lower is better for every one of
// them, which is why a single `direction` is enough.
const MARKERS = [
  { key: "hba1c", label: "HbA1c", unit: "%", good: 7, watch: 9, dp: 1 },
  { key: "fg", label: "FBS", unit: "", good: 130, watch: 180, dp: 0 },
  { key: "creatinine", label: "Creatinine", unit: "", good: 1.3, watch: 1.6, dp: 2 },
  { key: "weight", label: "Weight", unit: "kg", dp: 1 },
];

const toneOf = (m, value) => {
  if (value == null || m.good == null) return "n";
  return value <= m.good ? "g" : value <= m.watch ? "a" : "r";
};

const readMarkers = (biomarkers, previous) =>
  MARKERS.map((m) => {
    const value = biomarkers?.[m.key] == null ? null : Number(biomarkers[m.key]);
    const prev = previous?.[m.key] == null ? null : Number(previous[m.key]);
    const delta = value != null && prev != null ? Number((value - prev).toFixed(m.dp)) : null;
    return { ...m, value, prev, delta, tone: toneOf(m, value) };
  }).filter((m) => m.value != null);

function TrendChart({ marker, history }) {
  const series = history
    .map((h) => ({
      date: h.date,
      value: h.biomarkers?.[marker.key] == null ? null : Number(h.biomarkers[marker.key]),
    }))
    .filter((p) => p.value != null);
  if (series.length < 2)
    return <div className="dp-hint">Only one reading on record — nothing to trend yet.</div>;
  return (
    <div className="mo-trend">
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <YAxis width={34} tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
          <Tooltip
            formatter={(v) => [`${v}${marker.unit}`, marker.label]}
            labelFormatter={(d) => d}
          />
          <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// The statuses a card can actually be opened from. Anywhere else, tapping it
// only earns a 409 from the server, so the row does not offer the action.
const CLAIMABLE = ["vitals_done", "sd_pending", "with_sd"];

function WaitChip({ card, now }) {
  const waited = minutesSince(card.statusSince, now) ?? card.waitMinutes ?? 0;
  const tone = budgetColour(waited, card.waitBudget);
  return (
    <div className="si-wait">
      <span className={`si-tmr si-tmr-${tone}`}>
        ⏱ {waited}m {WAIT_WORD[card.status] || "waiting"}
      </span>
      {card.checkedInAt && <span className="si-since">in since {clock(card.checkedInAt)}</span>}
    </div>
  );
}

function RowDetail({ card, now }) {
  const cat = CATEGORY[card.category];
  return (
    <>
      <div className="si-meta">
        {card.age}
        {(card.sex || "")[0] || ""} · {card.fileNo} · Visit {card.visitNumber}
        {cat ? ` · ${cat.icon} ${cat.label}` : ""}
      </div>
      {/* The wait is what the MO can act on, so it reads before the biomarkers
          — and it is judged against the same budget the board uses. */}
      <WaitChip card={card} now={now} />
      {card.bios?.length > 0 && (
        <div className="si-bios">
          {card.bios.map((b) => (
            <span key={b.label} className={`sbio sbio-${b.tone}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}
      <JourneyRail status={card.status} />
      <div className="si-foot">
        <span className={`si-reports si-reports-${card.reports.tone}`}>{card.reports.label}</span>
        {card.compliancePct != null && (
          <span className="si-compliance">{card.compliancePct}% compliance</span>
        )}
      </div>
    </>
  );
}

function QueueRow({ card, active, onOpen, readOnly, now }) {
  return (
    <button
      type="button"
      className={`sq-item${active ? " active" : ""}${readOnly ? " is-readonly" : ""}`}
      disabled={readOnly}
      title={readOnly ? "Not yours to work up yet" : undefined}
      onClick={() => onOpen(card.visitId)}
    >
      <div className="si-slot">{card.slot}</div>
      <div className="si-name">{card.name}</div>
      <RowDetail card={card} now={now} />
    </button>
  );
}

// Escape closes, click outside closes, focus returns — the same contract the
// board's modal and the lab pane follow. A station tablet has no business
// showing a browser confirm().
function ConfirmDialog({ open, title, body, confirmLabel, tone = "grn", onConfirm, onClose }) {
  const boxRef = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const onKey = (e) => e.key === "Escape" && onClose();
    const onDown = (e) => boxRef.current && !boxRef.current.contains(e.target) && onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="detail-overlay">
      <div className="confirm-box" ref={boxRef} role="dialog" aria-label={title}>
        <div className="cb-title">{title}</div>
        <div className="cb-body">{body}</div>
        <div className="cb-acts">
          <button className="st-btn st-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={`st-btn st-btn-${tone}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_PROPOSAL = { medicineName: "", fromDose: "", toDose: "", reason: "" };

// Does the plan ask for a test the MO never actually ordered?
//
// An MO can write "order HbA1c and TSH today", never tap the chips, and hand
// over. The consultant then reads a plan saying those tests were ordered while
// no lab order exists — reception sees no payment to collect and the lab sees no
// sample, so the tests simply do not happen. `readyForDoctor` only checks that a
// plan exists, not that it matches what was ordered.
//
// Matched against the catalogue rather than against loose verbs, so the
// vocabulary is exact. No AI call — the names are already on screen.
const ORDER_INTENT =
  /(\border\b|\bre-?check\b|\brepeat\b|\bsend for\b|\brequest\b|\barrange\b|\bask for\b|\bbook\b)/i;

// Escaped, because catalogue names carry "-" and "/" — hs-CRP, Urine R/M. The
// boundaries are groups rather than lookbehind: this runs on whatever tablet the
// desk has, and lookbehind is the one thing older Safari lacks.
const namePattern = (name) =>
  new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");

const mentionsUnordered = (plan, catalogue) => {
  const text = String(plan || "");
  if (!text.trim() || !catalogue) return [];

  // A panel is never discussed as a result — "kidney panel" in a plan is a
  // request — so naming one is intent on its own.
  const panels = (catalogue.panels || [])
    .map((p) => p.label)
    .filter((label) => label && namePattern(label).test(text));

  // A bare test name is NOT. An MO's note is mostly about results already in:
  // "HbA1c 5.8, all in control" names a test and asks for nothing, and firing on
  // that would train the desk to click through the box without reading it. So a
  // test only counts alongside a word that asks for something.
  const tests = ORDER_INTENT.test(text)
    ? (catalogue.tests || [])
        .map((t) => t.name)
        .filter((name) => name && namePattern(name).test(text))
    : [];

  return [...new Set([...panels, ...tests])];
};

export default function MoStationPage() {
  const [selected, setSelected] = useState(null);
  const [plan, setPlan] = useState("");
  const [urgency, setUrgency] = useState("today");
  const [picked, setPicked] = useState([]);
  const [pinned, setPinned] = useState(false);
  const [toast, setToast] = useState("");
  const [openMarker, setOpenMarker] = useState(null);
  const [draft, setDraft] = useState(EMPTY_PROPOSAL);
  // What the last read of the plan found, shown until the MO acts on it or
  // edits the plan again. Held here rather than applied silently: the point of
  // this feature is that the MO sees what was understood.
  const [extracted, setExtracted] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const toastTimer = useRef(null);
  const saveTimer = useRef(null);
  // The visit a pending save belongs to — not `activeId`, which may already have
  // moved on by the time the debounce fires.
  const pendingSave = useRef(null);

  // The search runs in Postgres, so it reaches the whole day and can match a
  // phone number the browser never receives. Debounced, because every keystroke
  // would otherwise be a query.
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const me = useAuthStore((st) => st.currentDoctor);
  const now = useTick();
  const { data: queue, isLoading } = useMoQueue(undefined, term);
  const searching = !!queue?.query;
  // Auto-select the head of the queue so the screen is usable without a click —
  // but stop following it the moment the MO types, or a 15-second refetch would
  // swap the patient out from under the textarea.
  const autoId = queue?.withMe?.[0]?.visitId ?? queue?.waitingForMe?.[0]?.visitId ?? null;
  const activeId = selected ?? (pinned ? null : autoId);
  const { data: patient } = useMoPatient(activeId);
  const { data: catalogue } = useTestPanels();

  // `paused` is the same guard the textarea already uses: a live refetch must
  // never pull the queue out from under an MO who is typing a plan.
  const live = useGiniflowLive({ date: queue?.date, paused: pinned });

  const start = useStartWorkup();
  const savePlan = useSavePlan();
  const orderTests = useOrderTests();
  // Typed in for THIS patient: the line goes on their order, never into the
  // clinic list every other patient is offered.
  const [custom, setCustom] = useState([]);
  const [newTest, setNewTest] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const ready = useReadyForDoctor();
  const release = useReleaseWorkup();
  const takeOver = useTakeOver();
  const close = useCloseWithoutDoctor();
  const addProposal = useAddProposal();
  const withdrawProposal = useWithdrawProposal();

  const toggleGroup = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  // A different patient means a fresh plan — never carry one patient's notes
  // onto another's record.
  useEffect(() => {
    if (!patient) return;
    setPlan(patient.plan || "");
    setPicked([]);
    setUrgency("today");
    setOpenMarker(null);
    setDraft(EMPTY_PROPOSAL);
    setExtracted(null);
  }, [patient?.visitId]);

  // Autosave: an MO interrupted mid-workup should find what they typed.
  const flushPlan = () => {
    clearTimeout(saveTimer.current);
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (pending) savePlan.mutate(pending);
  };

  const queueSave = (value, source) => {
    // Typing pins the selection: a refetch must not swap the patient out from
    // under the textarea.
    setPinned(true);
    pendingSave.current = { visitId: activeId, plan: value, source };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushPlan, 800);
  };

  const onPlanChange = (value) => {
    setPlan(value);
    queueSave(value, "typed");
    // What was read no longer describes what is written.
    setExtracted(null);
  };

  const extractPlan = useExtractPlan();

  const readPlan = () => {
    extractPlan.mutate(
      { visitId: activeId, plan },
      {
        onSuccess: (data) => {
          setExtracted(data);
          const found =
            (data.tests?.length || 0) +
            (data.proposals?.length || 0) +
            (data.unmatched?.length || 0);
          if (!found) showToast("Nothing to order or suggest in that plan");
        },
        onError: (e) => showToast(e?.response?.data?.error || "Could not read the plan"),
      },
    );
  };

  // Applying is one deliberate act, and it only ever ADDS: an MO who ticked a
  // chip by hand before pressing the button does not lose it.
  const applyExtracted = () => {
    if (!extracted) return;
    if (extracted.tests?.length) {
      setPicked((prev) => [...new Set([...prev, ...extracted.tests])]);
    }
    if (extracted.urgency) setUrgency(extracted.urgency);
    // Only the first suggestion: the form holds one, and silently dropping the
    // rest would be worse than leaving them on screen to be added by hand.
    const first = extracted.proposals?.[0];
    if (first) {
      setDraft({
        medicineName: first.medicineName,
        fromDose: first.fromDose,
        toDose: first.toDose,
        reason: first.reason,
      });
    }
    setExtracted(null);
    showToast("✓ Filled in below — check it before you send");
  };

  // Dictation appends rather than replaces: an MO speaks one finding, types the
  // next, and speaks again. Overwriting what is already there loses work.
  const appendSpoken = (text) =>
    setPlan((prev) => {
      const next = prev.trim() ? `${prev.trim()} ${text}` : text;
      queueSave(next, "spoken");
      return next;
    });

  // Never lose the last thing typed — flush on the way out of the screen.
  useEffect(() => () => flushPlan(), []);

  const askTakeOver = (card) =>
    setConfirm({
      key: "takeover",
      title: `Take ${card.name} over from ${card.sdName || "the other SD"}?`,
      body: "Their plan and any tests they ordered are kept. The hand-off is recorded against both of you.",
      confirmLabel: "Take over",
      tone: "tl",
      onConfirm: () => takeOverPatient(card.visitId, card.name),
    });

  const openPatient = (visitId) => {
    // Save whatever is in the textarea before the patient changes.
    flushPlan();
    setPinned(false);
    // Selection follows the claim rather than leading it: a patient already at
    // another MO's desk is refused, and the panel must not open their plan and
    // proposals anyway. Take over is the deliberate way in.
    start.mutate(visitId, {
      onSuccess: () => setSelected(visitId),
      onError: (e) => showToast(e?.response?.data?.error || "Could not open this patient"),
    });
  };

  const togglePanel = (panel) =>
    setPicked((prev) => {
      const all = panel.tests.every((t) => prev.includes(t));
      return all
        ? prev.filter((t) => !panel.tests.includes(t))
        : [...new Set([...prev, ...panel.tests])];
    });

  const toggleTest = (name) =>
    setPicked((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));

  const confirmTests = () => {
    const customNames = new Set(custom.map((t) => t.name));
    return orderTests.mutate(
      {
        visitId: activeId,
        urgency,
        tests: picked.filter((n) => !customNames.has(n)),
        customTests: custom.filter((t) => picked.includes(t.name)),
      },
      {
        onSuccess: (r) => {
          setPicked([]);
          setCustom([]);
          showToast(
            r.reachesReceptionToday
              ? `✓ ${r.tests.length} tests ordered — reception can collect ₹${r.total.toLocaleString("en-IN")}`
              : `✓ ${r.tests.length} tests saved for ${urgency.replace("_", " ")}`,
          );
        },
        onError: (e) => showToast(e?.response?.data?.error || "Could not order those tests"),
      },
    );
  };

  const sendToDoctor = () =>
    ready.mutate(activeId, {
      onSuccess: () => {
        showToast(`✓ ${patient.name} is ready for the doctor`);
        setSelected(null);
      },
      onError: (e) => showToast(e?.response?.data?.error || "Could not hand over"),
    });

  const handOver = () => {
    // Only when NOTHING was ordered for this visit — neither ticked now nor
    // ordered earlier in the session. An MO who ordered one test and wrote about
    // another has made a judgement, and second-guessing it would train them to
    // click through the box without reading it.
    const named =
      picked.length || patient?.orders?.length ? [] : mentionsUnordered(plan, catalogue);
    if (!named.length) return sendToDoctor();
    setConfirm({
      key: "unordered-tests",
      title: "Hand over without ordering those tests?",
      body: `Your plan mentions ${named.slice(0, 4).join(", ")}${named.length > 4 ? " and others" : ""}, but no tests are selected. The doctor will read the plan; reception and the lab will see nothing to do.`,
      confirmLabel: "Hand over anyway",
      tone: "tl",
      onConfirm: () => {
        setConfirm(null);
        sendToDoctor();
      },
    });
  };

  // The server refuses a write to somebody else's patient, so the screen offers
  // the one action that makes it yours — and says whose it was.
  const takeOverPatient = (visitId, name) =>
    takeOver.mutate(visitId, {
      onSuccess: () => {
        setConfirm(null);
        setSelected(visitId);
        showToast(`✓ ${name} is yours now`);
      },
      onError: (e) => showToast(e?.response?.data?.error || "Could not take this patient over"),
    });

  const releasePatient = () =>
    release.mutate(activeId, {
      onSuccess: () => {
        showToast(`${patient.name} is back in the queue`);
        setConfirm(null);
        setSelected(null);
      },
      onError: (e) => showToast(e?.response?.data?.error || "Could not put this patient back"),
    });

  const closePatient = () =>
    close.mutate(activeId, {
      onSuccess: () => {
        showToast(`✓ ${patient.name} closed — straight to pharmacy`);
        setConfirm(null);
        setSelected(null);
      },
      onError: (e) => showToast(e?.response?.data?.error || "Could not close this patient"),
    });

  const submitProposal = (e) => {
    e.preventDefault();
    if (!draft.medicineName.trim() || !draft.toDose.trim()) return;
    addProposal.mutate(
      { visitId: activeId, ...draft },
      {
        onSuccess: () => {
          setDraft(EMPTY_PROPOSAL);
          showToast("✓ Suggested to the doctor");
        },
        onError: (e) => showToast(e?.response?.data?.error || "Could not save that suggestion"),
      },
    );
  };

  const total = picked.reduce(
    (sum, name) => sum + (catalogue?.tests.find((t) => t.name === name)?.price ?? 0),
    0,
  );
  const cat = CATEGORY[patient?.category];
  const busy =
    ready.isPending ||
    close.isPending ||
    orderTests.isPending ||
    release.isPending ||
    takeOver.isPending;

  // A test already ordered and not yet collected must not be orderable again —
  // the server refuses it, and the chip says why before the MO taps it.
  const alreadyOrdered = useMemo(() => {
    const names = new Set();
    for (const o of patient?.orders || [])
      if (UNCOLLECTED.has(o.sample_status)) for (const t of o.tests) names.add(t);
    return names;
  }, [patient?.orders]);

  const markers = useMemo(
    () => readMarkers(patient?.biomarkers, patient?.previousBiomarkers),
    [patient?.biomarkers, patient?.previousBiomarkers],
  );
  const summary = useMemo(
    () => ({
      g: markers.filter((m) => m.tone === "g").length,
      a: markers.filter((m) => m.tone === "a").length,
      r: markers.filter((m) => m.tone === "r").length,
    }),
    [markers],
  );
  const activeMeds = (patient?.medications || []).filter((m) => m.is_active !== false);

  return (
    <div className="gf">
      <StationNotice station="mo" />
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--tl-l)", color: "var(--tl)" }}>
          👨‍⚕️ MO / SD Station
        </div>
        {/* Whose queue this is, and for which day — a station tablet is shared,
            and an MO must be able to see at a glance that it is signed in as
            them. Plan §2.1. */}
        <div className="tr-who">
          {me?.short_name || me?.name || "Not signed in as an SD"}
          {queue?.date ? ` · ${dayLabel(queue.date)}` : ""}
        </div>
        <div className="rail-right">
          {/* Colours are §2.2's table; "missing reports" is not in it and takes
              §2.3's 🔴, because it is the group nobody else can unblock. */}
          <span className="badge b-tl">{queue?.counters?.withMe ?? 0} with me now</span>
          <span className="badge b-red">{queue?.counters?.waitingForMe ?? 0} waiting for me</span>
          <span className="badge b-amb">{queue?.counters?.awaitingResults ?? 0} on results</span>
          <span className="badge b-red">{queue?.counters?.missingReports ?? 0} no reports</span>
          <span className="badge b-ink">{queue?.counters?.closedByMe ?? 0} passed on</span>
          <LiveBadge live={live} className="tr-live" />
          <a className="tr-back" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="station-layout">
        <div className="squeue">
          <div className="sq-header">
            <div className="sq-title">My patients</div>
            <div className="sq-sub">Tap a patient to start the workup</div>
            <div className="sq-search">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, file no. or phone"
                aria-label="Search today's patients"
              />
              {searching && (
                <span className="sqs-count">
                  {queue.matched} of {queue.total}
                </span>
              )}
            </div>
          </div>
          {isLoading && <div className="sq-foot">Loading…</div>}
          {GROUPS.map((g) => {
            const rows = queue?.[g.key] || [];
            if (!rows.length) return null;
            // A search opens whatever it matched: a hit inside a shut group
            // would read as no result.
            const open = searching || !collapsed.has(g.key);
            const id = `sq-group-${g.key}`;
            return (
              <div className="sq-sect" key={g.key}>
                <GroupHead
                  icon={g.icon}
                  title={g.title}
                  sub={g.sub}
                  count={rows.length}
                  open={open}
                  onToggle={() => toggleGroup(g.key)}
                  id={id}
                />
                <div id={id} hidden={!open}>
                  {rows.map((card) => (
                    <QueueRow
                      key={card.visitId}
                      card={card}
                      active={card.visitId === activeId}
                      onOpen={openPatient}
                      onTakeOver={askTakeOver}
                      readOnly={g.readOnly}
                      now={now}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {!isLoading && !GROUPS.some((g) => (queue?.[g.key] || []).length) && (
            <div className="sq-foot">
              {searching
                ? `Nobody on today's floor matches "${queue.query}".`
                : "Nobody is waiting for you right now."}
            </div>
          )}
        </div>

        <div className="station-detail mo-detail">
          {!patient && <div className="sd-empty">Select a patient from the queue.</div>}
          {patient && (
            <>
              <div className="sd-header">
                <div className="sdh-avatar">{initials(patient.name)}</div>
                <div className="sdh-body">
                  <div className="sdh-name">{patient.name}</div>
                  <div className="sdh-meta">
                    {patient.age}
                    {(patient.sex || "")[0] || ""} · {patient.fileNo} · Visit {patient.visitNumber}
                    {clock(patient.checkedInAt)
                      ? ` · Checked in ${clock(patient.checkedInAt)}`
                      : ""}
                  </div>
                  <JourneyRail status={patient.status} />
                </div>
                <div className="sdh-acts">
                  {cat && (
                    <span className="badge b-amb">
                      {cat.icon} {cat.label}
                    </span>
                  )}
                  {patient.status === "with_sd" && (
                    <button
                      className="st-btn st-btn-ghost"
                      onClick={() =>
                        setConfirm({
                          key: "release",
                          title: `Put ${patient.name} back in the queue?`,
                          body: "Anything you have written is kept. They return to the waiting list for any MO to pick up.",
                          confirmLabel: "Put back",
                          tone: "ghost",
                          onConfirm: releasePatient,
                        })
                      }
                    >
                      Not my patient
                    </button>
                  )}
                </div>
              </div>

              <div className="sd-body">
                {/* No allergy field exists in the database yet, so this says what
                    is true rather than "None recorded", which would read as a
                    check somebody performed. Plan §7. */}
                <div className="allergy-strip unknown">
                  ⚠ ALLERGIES: <strong>not recorded anywhere</strong> — ask the patient
                </div>

                {patient.vitals ? (
                  <div className="dp-sec">
                    {/* Where the reading came from, because there are two
                        places it can be: the Gini Flow vitals station, or
                        HealthRay's own screen, which is where most of the floor
                        still works. Saying "just taken" about a HealthRay
                        reading would credit a station that never saw them. */}
                    <div className="dp-sec-title">
                      {patient.vitals.readingSource === "healthray"
                        ? "Vitals — from HealthRay"
                        : "Vitals just taken"}
                      {clock(patient.vitals.recorded_at) && (
                        <span className="mo-vsrc"> · {clock(patient.vitals.recorded_at)}</span>
                      )}
                    </div>
                    <div className="mo-vitals">
                      {VITAL_ROWS.filter((r) => r.of(patient.vitals) != null).map((r) => {
                        const change = deltaText(patient.vitals, patient.lastVitals, r);
                        return (
                          <span key={r.key}>
                            {r.label}{" "}
                            <strong>
                              {r.of(patient.vitals)}
                              {r.unit}
                            </strong>
                            {change && <em className="mo-delta">{change}</em>}
                          </span>
                        );
                      })}
                      {patient.vitals.bmi && (
                        <span>
                          BMI <strong>{patient.vitals.bmi}</strong>
                        </span>
                      )}
                    </div>
                    {!patient.lastVitals && (
                      <div className="dp-hint">
                        No earlier reading on record to compare against.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="dp-sec">
                    <div className="dp-sec-title">Vitals</div>
                    {/* Both places have been looked in — the station's table and
                        HealthRay's — so this can say "no reading", not merely
                        "not taken here". */}
                    <div className="dp-hint">
                      No reading on file for today, at this station or on HealthRay.
                    </div>
                  </div>
                )}

                {markers.length > 0 && (
                  <div className="dp-sec">
                    <div className="dp-sec-title">Key numbers</div>
                    <div className="mo-concern-line">
                      ✓ {summary.g} in control · ⚠ {summary.a} to watch · ↑ {summary.r} out of range
                    </div>
                    <div className="mo-bios">
                      {markers.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          className={`mo-bio mo-bio-${m.tone}${openMarker === m.key ? " on" : ""}`}
                          aria-expanded={openMarker === m.key}
                          onClick={() => setOpenMarker(openMarker === m.key ? null : m.key)}
                        >
                          <div className="mb-val">
                            {m.value}
                            <span className="mb-unit">{m.unit}</span>
                          </div>
                          <div className="mb-lbl">{m.label}</div>
                          <div className="mb-prev">
                            {m.prev == null ? (
                              "first reading"
                            ) : (
                              <>
                                {m.delta > 0 ? "▲" : m.delta < 0 ? "▼" : "="}{" "}
                                {m.delta === 0 ? "no change" : `from ${m.prev}`}
                              </>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                    {openMarker && (
                      <TrendChart
                        marker={MARKERS.find((m) => m.key === openMarker)}
                        history={[
                          ...(patient.biomarkerHistory || []),
                          { date: "today", biomarkers: patient.biomarkers },
                        ]}
                      />
                    )}
                    {patient.compliancePct != null && (
                      <div className="dp-hint">{patient.compliancePct}% compliance reported</div>
                    )}
                  </div>
                )}

                <div className="dp-sec">
                  <div className="dp-sec-title">Today's concerns</div>
                  {markers.filter((m) => m.tone !== "g").length > 0 && (
                    <ul className="mo-concerns">
                      {markers
                        .filter((m) => m.tone !== "g")
                        .map((m) => (
                          <li key={m.key} className={`mc-${m.tone}`}>
                            <strong>
                              {m.label} {m.value}
                              {m.unit}
                            </strong>{" "}
                            — {m.tone === "r" ? "out of range" : "above target"}
                            {m.prev != null && ` (was ${m.prev})`}
                            <span className="mc-src">from reports</span>
                          </li>
                        ))}
                    </ul>
                  )}
                  {patient.compliance?.missed && (
                    <div className="mo-concern-note">
                      <strong>Since the last visit:</strong> {patient.compliance.missed}
                      <span className="mc-src">between visits</span>
                    </div>
                  )}
                  {patient.compliance?.diet && (
                    <div className="mo-concern-note">
                      <strong>Diet advised:</strong> {patient.compliance.diet}
                    </div>
                  )}
                  {/* The MyHealth Genie symptom tables are still unreconciled
                      (plan §7), so this says nothing was read rather than
                      implying the patient reported nothing. */}
                  <div className="dp-hint">
                    Patient-reported concerns from the MyHealth Genie app are not wired to this
                    screen yet — ask.
                  </div>
                </div>

                {patient.diagnoses?.length > 0 && (
                  <div className="dp-sec">
                    <div className="dp-sec-title">Diagnoses</div>
                    <div className="mo-dx">
                      {patient.diagnoses.map((d) => (
                        <span
                          key={d.id || d.label}
                          className={`dx-chip${/uncontrolled/i.test(d.status || "") ? " bad" : ""}`}
                        >
                          {d.label}
                          {d.status ? ` · ${d.status}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {activeMeds.length > 0 && (
                  <div className="dp-sec">
                    <div className="dp-sec-title">Current medicines</div>
                    <ul className="mo-meds">
                      {activeMeds.map((m, i) => (
                        <li key={`${m.name}-${i}`}>
                          <strong>{m.name}</strong>
                          {m.dose ? ` · ${m.dose}` : ""}
                          {m.frequency ? ` · ${m.frequency}` : ""}
                          {m.timing ? ` · ${m.timing}` : ""}
                        </li>
                      ))}
                    </ul>
                    {/* Plan §2.4 item 7: a dose proposal made without sight of
                        what another hospital prescribed is unsafe, and no
                        external_medicines table exists yet (brief §3, Phase 3). */}
                    <div className="dp-hint">
                      This is what Gini prescribed. Medicines from another hospital are not recorded
                      anywhere — ask before suggesting a change.
                    </div>
                  </div>
                )}

                <div className="dp-sec">
                  <div className="dp-sec-title">
                    Plan {savePlan.isPending ? "· saving…" : plan ? "· saved" : ""}
                  </div>
                  <textarea
                    className="mo-plan"
                    rows={5}
                    placeholder="What did you find, and what should the doctor know?"
                    value={plan}
                    onChange={(e) => onPlanChange(e.target.value)}
                  />
                  <div className="mo-dictate">
                    <VoiceButton
                      label="🎤 Dictate the plan"
                      title="Speak the plan — you can edit it before it is added"
                      onText={appendSpoken}
                    />
                  </div>

                  {/* Reads back what the MO wrote and points at the two panels
                      below — it never adds a test the plan did not name. The
                      result is shown, not applied: the MO sees what was
                      understood and can drop any of it. */}
                  <div className="mo-extract">
                    <button
                      type="button"
                      className="st-btn st-btn-g"
                      onClick={readPlan}
                      disabled={!plan.trim() || extractPlan.isPending}
                    >
                      {extractPlan.isPending
                        ? "Reading…"
                        : "✨ Pull tests & suggestions from my plan"}
                    </button>
                  </div>

                  {extracted && (
                    <div className="mo-xtr">
                      <div className="mo-xtr-head">From your plan — nothing is saved yet</div>
                      {extracted.tests?.length > 0 && (
                        <div className="mo-xtr-row">
                          <span className="mo-xtr-lbl">Tests</span>
                          <span className="mo-xtr-vals">{extracted.tests.join(" · ")}</span>
                        </div>
                      )}
                      {extracted.urgency && (
                        <div className="mo-xtr-row">
                          <span className="mo-xtr-lbl">When</span>
                          <span className="mo-xtr-vals">
                            {URGENCY.find((u) => u.key === extracted.urgency)?.label ||
                              extracted.urgency}
                          </span>
                        </div>
                      )}
                      {extracted.proposals?.map((pr, i) => (
                        <div className="mo-xtr-row" key={`${pr.medicineName}-${i}`}>
                          <span className="mo-xtr-lbl">{i === 0 ? "Suggest" : ""}</span>
                          <span className="mo-xtr-vals">
                            {pr.medicineName}
                            {pr.fromDose || pr.toDose
                              ? ` — ${pr.fromDose || "?"} → ${pr.toDose || "?"}`
                              : ""}
                            {pr.reason ? ` · ${pr.reason}` : ""}
                            {i > 0 && <em className="mo-xtr-note"> (add this one by hand)</em>}
                          </span>
                        </div>
                      ))}
                      {/* Named, not silently dropped: a test the catalogue does
                          not stock is something the MO has to do something
                          about, and hiding it would look like it was ordered. */}
                      {extracted.unmatched?.length > 0 && (
                        <div className="mo-xtr-row mo-xtr-warn">
                          <span className="mo-xtr-lbl">Not in the catalogue</span>
                          <span className="mo-xtr-vals">{extracted.unmatched.join(" · ")}</span>
                        </div>
                      )}
                      <div className="mo-xtr-acts">
                        <button type="button" className="st-btn st-btn-tl" onClick={applyExtracted}>
                          Fill these in
                        </button>
                        <button
                          type="button"
                          className="st-btn st-btn-g"
                          onClick={() => setExtracted(null)}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="dp-hint">
                    Autosaves as you type. The doctor cannot take this patient without a plan.
                  </div>
                </div>

                {/* The MO edits the actual prescription; their rows reach the
                    doctor as proposals to approve, adjust or reject (addendum
                    v1.1 §3). The same section the consultant uses — one inline
                    editor, not a second one that could drift from it. */}
                <div className="dp-sec mo-rx">
                  <RxSection
                    visitId={activeId}
                    station="mo"
                    readOnly={patient.status !== "with_sd"}
                    onToast={showToast}
                  />
                </div>

                <div className="dp-sec">
                  <div className="dp-sec-title">💊 Suggest to the doctor</div>
                  {patient.proposals.length > 0 && (
                    <ul className="mo-proposals">
                      {patient.proposals.map((p) => (
                        <li key={p.id}>
                          <span>
                            <strong>{p.medicine_name}</strong>
                            {p.from_dose ? ` ${p.from_dose} →` : " →"} {p.to_dose}
                            {p.reason ? ` · ${p.reason}` : ""}
                          </span>
                          <button
                            type="button"
                            className="prop-x"
                            aria-label={`Withdraw ${p.medicine_name}`}
                            onClick={() => withdrawProposal.mutate(p.id)}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form className="mo-prop-form" onSubmit={submitProposal}>
                    <input
                      list="mo-med-names"
                      placeholder="Medicine"
                      value={draft.medicineName}
                      onChange={(e) => {
                        const medicineName = e.target.value;
                        const known = activeMeds.find(
                          (m) => m.name.toLowerCase() === medicineName.toLowerCase(),
                        );
                        setDraft((d) => ({
                          ...d,
                          medicineName,
                          fromDose: known?.dose ?? d.fromDose,
                        }));
                      }}
                    />
                    <datalist id="mo-med-names">
                      {activeMeds.map((m, i) => (
                        <option key={`${m.name}-${i}`} value={m.name} />
                      ))}
                    </datalist>
                    <input
                      placeholder="From"
                      value={draft.fromDose}
                      onChange={(e) => setDraft((d) => ({ ...d, fromDose: e.target.value }))}
                    />
                    <input
                      placeholder="To"
                      value={draft.toDose}
                      onChange={(e) => setDraft((d) => ({ ...d, toDose: e.target.value }))}
                    />
                    <input
                      className="prop-reason"
                      placeholder="Why"
                      value={draft.reason}
                      onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
                    />
                    <button
                      className="st-btn st-btn-tl"
                      disabled={
                        addProposal.isPending || !draft.medicineName.trim() || !draft.toDose.trim()
                      }
                    >
                      Suggest
                    </button>
                  </form>
                  <div className="dp-hint">
                    A suggestion, not a prescription — the doctor decides. Withdraw it any time
                    before you hand over.
                  </div>
                </div>

                <div className="dp-sec">
                  <div className="dp-sec-title">🔬 Tests to order</div>
                  <div className="mo-urgency">
                    {URGENCY.map((u) => (
                      <button
                        key={u.key}
                        type="button"
                        className={`urg-btn${urgency === u.key ? " on" : ""}`}
                        onClick={() => setUrgency(u.key)}
                      >
                        {u.label}
                        {u.key === "next_visit" && patient.nextVisitDate
                          ? ` · ${monthLabel(patient.nextVisitDate)}`
                          : ""}
                      </button>
                    ))}
                  </div>
                  <div className="dp-hint">
                    Quick panels — tap to select every test in the panel
                  </div>
                  <div className="mo-panels">
                    {(catalogue?.panels || []).map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={`panel-btn${p.tests.every((t) => picked.includes(t)) ? " on" : ""}`}
                        onClick={() => togglePanel(p)}
                      >
                        <span className="pb-icon">{p.icon}</span>
                        <span className="pb-label">{p.label}</span>
                        <span className="pb-count">{p.tests.length} tests</span>
                      </button>
                    ))}
                  </div>
                  <div className="dp-hint">Add individual tests</div>
                  {/* The catalogue is never complete. A test nobody listed is
                      added to it here rather than written into the plan, where
                      reception and the lab would never see it. */}
                  <div className="mo-newtest">
                    <input
                      className="cp-inp"
                      value={newTest}
                      placeholder="Test not in the list? Type its name"
                      onChange={(e) => setNewTest(e.target.value)}
                    />
                    <input
                      className="cp-inp mo-newtest__price"
                      inputMode="decimal"
                      value={newPrice}
                      placeholder="₹ price"
                      onChange={(e) => setNewPrice(e.target.value)}
                    />
                    <button
                      type="button"
                      className="st-btn st-btn-g"
                      disabled={newTest.trim().length < 2}
                      onClick={() => {
                        const name = newTest.trim();
                        setCustom((prev) =>
                          prev.some((c) => c.name.toLowerCase() === name.toLowerCase())
                            ? prev
                            : [
                                ...prev,
                                { name, price: Number(newPrice) > 0 ? Number(newPrice) : 0 },
                              ],
                        );
                        setPicked((prev) => [...new Set([...prev, name])]);
                        setNewTest("");
                        setNewPrice("");
                      }}
                    >
                      + Add for this patient
                    </button>
                  </div>
                  {custom.length > 0 && (
                    <div className="mo-customlist">
                      {custom.map((t) => (
                        <span key={t.name} className="mo-custom">
                          {t.name} · {t.price ? `₹${t.price}` : "price not set"}
                          <button
                            type="button"
                            aria-label={`Remove ${t.name}`}
                            onClick={() => {
                              setCustom((prev) => prev.filter((c) => c.name !== t.name));
                              setPicked((prev) => prev.filter((n) => n !== t.name));
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mo-tests">
                    {(catalogue?.tests || []).map((t) => {
                      const dup = alreadyOrdered.has(t.name);
                      return (
                        <button
                          key={t.name}
                          type="button"
                          disabled={dup}
                          title={dup ? "Already ordered and not yet collected" : undefined}
                          className={`test-chip${picked.includes(t.name) ? " on" : ""}${dup ? " ordered" : ""}`}
                          onClick={() => toggleTest(t.name)}
                        >
                          <span className="tc-name">{t.name}</span>
                          {t.gloss && <span className="tc-sub">{t.gloss}</span>}
                          <span className="tc-price">{dup ? "ordered" : `₹${t.price}`}</span>
                        </button>
                      );
                    })}
                  </div>
                  {picked.length > 0 && (
                    <div className="mo-order-bar">
                      <span>
                        <strong>{picked.length} tests</strong> · ₹{total.toLocaleString("en-IN")} ·{" "}
                        {urgency === "today"
                          ? "goes to reception now"
                          : `saved for ${urgency.replace("_", " ")}`}
                      </span>
                      <button className="st-btn st-btn-tl" disabled={busy} onClick={confirmTests}>
                        Confirm →
                      </button>
                    </div>
                  )}
                  {patient.orders.length > 0 && (
                    <div className="dp-hint">
                      Already ordered:{" "}
                      {patient.orders
                        .map(
                          (o) => `${o.tests.length} tests (${o.sample_status.replace(/_/g, " ")})`,
                        )
                        .join(" · ")}
                    </div>
                  )}
                </div>
              </div>

              <div className="mo-actions">
                <button
                  className="st-btn st-btn-tl"
                  disabled={busy || !plan.trim()}
                  onClick={handOver}
                  title={!plan.trim() ? "Write a plan first" : undefined}
                >
                  Ready for the doctor →
                </button>
                {patient.canClose ? (
                  <button
                    className="st-btn st-btn-grn"
                    disabled={busy || !plan.trim()}
                    onClick={() =>
                      setConfirm({
                        key: "close",
                        title: `Close ${patient.name} without the doctor?`,
                        body: "They go straight to pharmacy. Only for green-category patients.",
                        confirmLabel: "Close — no doctor needed",
                        tone: "grn",
                        onConfirm: closePatient,
                      })
                    }
                  >
                    ✓ Close — no doctor needed
                  </button>
                ) : (
                  <span className="mo-close-note">Close is for green-category patients only</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone}
        onConfirm={confirm?.onConfirm}
        onClose={() => setConfirm(null)}
      />

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
