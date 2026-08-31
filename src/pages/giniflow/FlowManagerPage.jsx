import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import useAuthStore from "../../stores/authStore";
import { hasCapability, CAPABILITIES as CAP } from "../../../shared/permissions";
import { CHAIN, STATUS_LABEL, STATUS_TO_SLA_KEY } from "../../../shared/giniflowStatus";
import {
  useGiniflowBoard,
  useGiniflowSearch,
  useGiniflowTimeline,
} from "../../queries/hooks/useGiniflowBoard";
import "../../styles/giniflow.css";

// Each category needs its own mark: 🟡 for both "worse in range" and "getting
// better" made two clinically opposite states look identical (GF-30). The title
// carries the words, so the dot is never the only signal (GF-16).
const CATEGORY_DOT = {
  worse_out_of_range: { icon: "🔴", label: "Worse — out of range" },
  worse_in_range: { icon: "🟠", label: "Worse — still in range" },
  getting_better: { icon: "🟡", label: "Getting better" },
  in_control: { icon: "✅", label: "In control" },
  no_reports: { icon: "🔵", label: "No reports" },
};

// Queue statuses are folded into the station they feed, so the projected list
// names stations only — never "waiting for X" twice.
const WAIT_ONLY = new Set([
  "checked_in",
  "vitals_pending",
  "sd_pending",
  "ready_for_doctor",
  "vitals_done",
  "doctor_done",
  "dispensed",
  "booked",
  "confirmed",
]);

// The same three-way rule the server applies (statusEngine.budgetColour), kept
// here so a card that ticks past its budget between two polls turns red on the
// tick rather than up to 10s later (GF-09).
const budgetColour = (minutes, budget) => {
  if (!budget) return "neutral";
  const pct = (minutes / budget) * 100;
  if (pct > 100) return "red";
  if (pct >= 80) return "amber";
  return "green";
};

const AVATAR_COLOURS = ["#374151", "#1e3a5f", "#14532d", "#7c2d12", "#7f1d1d", "#b45309"];

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

// Deterministic so a patient keeps the same colour all day across refetches.
const avatarColour = (patientId) =>
  AVATAR_COLOURS[Math.abs(patientId ?? 0) % AVATAR_COLOURS.length];

const clockAt = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "—";

// Recomputed from the timestamp on every tick rather than incremented, so a
// backgrounded tab (where browsers throttle timers) self-corrects instead of drifting.
const minutesSince = (iso, now) =>
  iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000)) : null;

const colourClass = (colour) =>
  colour === "red" ? "tmr-r" : colour === "amber" ? "tmr-a" : "tmr-g";

// Escape closes the topmost overlay and focus returns to whatever opened it —
// without this a keyboard user who opens the timeline is stranded inside it (GF-16).
// Pass `ref` to also close on a click outside that element. The control that
// opened it is exempt, marked with data-gf-toggle, so clicking it again toggles
// rather than closing and immediately reopening.
function useDismissable(open, onClose, ref = null) {
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e) => {
      if (!ref?.current) return;
      if (ref.current.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[data-gf-toggle]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    if (ref) document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (ref) document.removeEventListener("pointerdown", onPointerDown);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose, ref]);
}

function useDebounced(value, delayMs = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}

function useTick(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function PatientCard({ card, offsetMs, now, onOpen, flagged }) {
  const isLab = !!card.lab && card.column === "lab";
  const anchor = isLab ? card.lab.since : card.statusSince;
  const live = minutesSince(anchor, now - offsetMs);
  const minutes = live ?? (isLab ? card.lab.minutes : card.statusMinutes);
  const budget = isLab ? card.lab.budget : card.statusBudget;
  const colour = budgetColour(minutes, budget);
  const totalMinutes = card.finished
    ? card.totalMinutes
    : (minutesSince(card.journeyStartedAt, now - offsetMs) ?? card.totalMinutes);
  // Derived live rather than taken from the poll, so the red styling and the
  // number it describes can never disagree.
  const totalOver = !!card.totalBudget && totalMinutes !== null && totalMinutes > card.totalBudget;

  return (
    <button
      type="button"
      className={`pc${flagged ? " flagged" : ""}`}
      onClick={() => onOpen(card)}
      style={card.finished ? { opacity: 0.6 } : undefined}
    >
      <div className="pc-top">
        <div className="pc-av" style={{ background: avatarColour(card.patientId) }}>
          {initials(card.name)}
        </div>
        <div className="pc-name">{card.name}</div>
        <div className="pc-cat" title={CATEGORY_DOT[card.category]?.label || "Uncategorised"}>
          {CATEGORY_DOT[card.category]?.icon || ""}
        </div>
      </div>
      <div className="pc-id">
        {card.age}
        {(card.sex || "")[0] || ""} · {card.fileNo || "—"} · Visit {card.visitNumber ?? "—"}
      </div>
      <div className="pc-mid">{isLab ? card.lab.subtitle : card.subtitle}</div>
      <div className="pc-bot">
        <span className={`tmr ${colourClass(colour)}`}>⏱ {minutes ?? 0}m</span>
        {!isLab && totalMinutes !== null && (
          <span className={`tot${totalOver ? " over" : ""}`}>{totalMinutes}m total</span>
        )}
      </div>
      {isLab && <div className="pc-parallel">Lab track · also on the main board</div>}
      {!isLab && card.blockedReason && (
        <div className="wait4 blocked">
          <span className="w-ico">🚫</span> {card.blockedReason}
        </div>
      )}
      {isLab && card.lab.hint && (
        <div className={`wait4${card.lab.blocking ? " blocked" : ""}`}>
          <span className="w-ico">{card.lab.hintIcon}</span> {card.lab.hint}
        </div>
      )}
      {!isLab && !card.blockedReason && card.hint && (
        <div className="wait4">
          <span className="w-ico">{card.hintIcon}</span> {card.hint}
        </div>
      )}
    </button>
  );
}

function Column({ column, offsetMs, now, onOpen, flaggedId }) {
  return (
    <div className={`col${column.hot ? " hot" : ""}`}>
      <div className="col-hd">
        <span>{column.icon}</span>
        <span className="col-name" style={column.hot ? { color: "var(--red)" } : undefined}>
          {column.name}
        </span>
        <span
          className="col-count"
          style={column.hot ? { color: "var(--red)", borderColor: "var(--red-b)" } : undefined}
        >
          {column.count}
        </span>
      </div>
      {column.budgetMinutes && (
        <div className="col-sla" style={column.hot ? { color: "var(--red)" } : undefined}>
          Budget: <strong>{column.budgetMinutes} min</strong>
          {column.hot ? ` · avg now ${column.avgMinutes}m ⚠` : ""}
        </div>
      )}
      <div className="col-body">
        {column.cards.length === 0 && <div className="col-empty">—</div>}
        {[...column.cards]
          .sort((a, b) =>
            column.key === "done" ? 0 : (b.statusMinutes ?? 0) - (a.statusMinutes ?? 0),
          )
          .map((card) => (
            <PatientCard
              key={`${column.key}-${card.id}`}
              card={{ ...card, column: column.key }}
              offsetMs={offsetMs}
              now={now}
              onOpen={onOpen}
            />
          ))}
      </div>
    </div>
  );
}

function SlaDrawer({ open, slaConfig, canEdit, onClose, onSave, saving, error }) {
  const [draft, setDraft] = useState({});
  const panelRef = useRef(null);
  useDismissable(open, onClose, panelRef);
  const invalid = (v) => {
    if (v === undefined || v === "") return false;
    const n = Number(v);
    return !Number.isInteger(n) || n < 1 || n > 600;
  };
  const anyInvalid = Object.values(draft).some(invalid);
  useEffect(() => {
    if (open) setDraft(Object.fromEntries(slaConfig.map((s) => [s.station, s.budgetMinutes])));
  }, [open, slaConfig]);

  return (
    <div className={`drawer${open ? " open" : ""}`} ref={panelRef}>
      <div className="dr-hd">
        <div className="dr-title">⚙ Time budgets (SLA)</div>
        <div className="dr-sub">
          Set expected time per station — cards turn amber at 80%, red when over
        </div>
      </div>
      <div className="dr-body">
        {slaConfig.map((s, i) => (
          <div
            className="sla-row"
            key={s.station}
            style={i === slaConfig.length - 1 ? { borderBottom: "none" } : undefined}
          >
            <div>
              <div
                className="sla-name"
                style={s.station === "total_journey" ? { color: "var(--tl)" } : undefined}
              >
                {s.label}
              </div>
              <div className="sla-desc">{s.description}</div>
            </div>
            <input
              className="sla-inp"
              type="number"
              min="1"
              disabled={!canEdit}
              value={draft[s.station] ?? s.budgetMinutes}
              onChange={(e) => setDraft((d) => ({ ...d, [s.station]: e.target.value }))}
              style={
                s.station === "total_journey"
                  ? { borderColor: "var(--tl)", fontWeight: 700 }
                  : undefined
              }
            />
            <span className="sla-unit">min</span>
          </div>
        ))}
        <div className="sla-warn">
          ⚠ These budgets apply hospital-wide, to every station screen and every report — not just
          to your view of the board.
        </div>
        <div className="sla-hint">
          💡 Budgets can differ per patient category — red-category patients can get a longer doctor
          budget, green-category can be SD-closed with 0 doctor time. Per-category overrides are not
          built yet.
        </div>
      </div>
      <div className="dr-foot">
        {error && <div className="dr-err">{error}</div>}
        {canEdit && (
          <button
            className="btn btn-tl"
            disabled={saving || anyInvalid}
            onClick={() => onSave(draft)}
          >
            {saving ? "Saving…" : "Save budgets"}
          </button>
        )}
        <button className="btn btn-g" onClick={onClose}>
          {canEdit ? "Cancel" : "Close"}
        </button>
      </div>
    </div>
  );
}

function TimelineModal({ visitId, onClose, slaConfig }) {
  const { data, isLoading } = useGiniflowTimeline(visitId);
  const now = useTick();
  useDismissable(!!visitId, onClose);
  if (!visitId) return null;
  const visit = data?.visit;
  const steps = data?.steps || [];

  // The step the patient is standing in keeps counting while the modal is open;
  // finished steps are already fixed (GF-24).
  const liveWait = (step) =>
    step.isCurrent && step.stationMinutes === 0
      ? (minutesSince(step.enteredAt, now) ?? step.waitMinutes)
      : step.waitMinutes;
  const liveTotal = (step) =>
    step.isCurrent ? liveWait(step) + step.stationMinutes : step.totalMinutes;
  const liveOver = (step) =>
    step.budgetMinutes ? Math.max(0, liveTotal(step) - step.budgetMinutes) : 0;
  const liveColour = (step) => budgetColour(liveTotal(step), step.budgetMinutes);

  // GF-14: what has not happened yet, so the modal answers "what is left" as well
  // as "what has taken so long".
  const doneStatuses = new Set(steps.map((s) => s.status));
  const budgetFor = (status) =>
    slaConfig?.find((c) => c.station === STATUS_TO_SLA_KEY[status])?.budgetMinutes ?? null;
  const projected = CHAIN.slice(CHAIN.indexOf("checked_in"))
    .filter((status) => !doneStatuses.has(status) && !WAIT_ONLY.has(status))
    .map((status) => ({
      status,
      label: STATUS_LABEL[status] || status,
      budget: budgetFor(status),
    }));
  const journeySoFar = steps.reduce((sum, st) => sum + liveTotal(st), 0);
  const journeyTarget =
    slaConfig?.find((c) => c.station === "total_journey")?.budgetMinutes ?? null;

  return (
    <div className="tmodal open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tbox">
        <div className="tb-hd">
          <div>
            <div className="tb-name">{visit?.name || "Patient"}</div>
            <div className="tb-meta">
              {visit
                ? `${visit.age}${(visit.sex || "")[0] || ""} · ${visit.file_no} · Visit ${visit.visit_number}`
                : "—"}
            </div>
          </div>
          <button className="tb-cls" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="tb-body">
          {isLoading && <div className="ts-note">Loading…</div>}
          {steps.map((step, i) => (
            <div className="tstep" key={`${step.status}-${i}`}>
              <div className={`ts-dot ${step.isCurrent ? "tsd-now" : "tsd-done"}`}>
                {step.isCurrent ? "●" : "✓"}
              </div>
              <div className="ts-body">
                <div className="ts-name">{step.label}</div>
                <div className="ts-time">
                  {step.isCurrent ? `Since ${clockAt(step.enteredAt)}` : clockAt(step.enteredAt)}
                </div>
                <span
                  className={`ts-dur ${step.colour === "red" ? "tsd-r" : step.colour === "amber" ? "tsd-a" : "tsd-g"}`}
                >
                  {step.waitMinutes}m wait + {step.stationMinutes}m station
                  {step.overBy ? ` — ${step.overBy}m OVER budget` : ""}
                </span>
                {step.meta?.vitals && (
                  <div className="ts-note">
                    BP {step.meta.vitals.bp} · {step.meta.vitals.weight} kg
                  </div>
                )}
              </div>
            </div>
          ))}
          {visit?.blocked_reason && (
            <div className="ts-note ts-blocked">🚫 {visit.blocked_reason}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Clicking a stat tile filters the board to the patients that number counts, so
// "14 over budget" answers "which 14?" without leaving the screen. A tile with no
// patient list behind it (the booked total counts appointments, which have no
// visit row yet) is not clickable.
const STAT_FILTERS = {
  inBuilding: {
    label: "In building now",
    match: (card) => !card.finished,
  },
  completed: {
    label: "Completed",
    match: (card) => card.finished,
  },
  overBudget: {
    label: "Over time budget",
    match: (card) => !card.finished && card.statusColour === "red",
  },
  blocked: {
    label: "Blocked",
    // The status is authoritative; the reason is its text (GF-18).
    match: (card) => card.status === "blocked_reports",
  },
  withinSla: {
    label: "Within SLA",
    match: (card) => !card.finished && card.statusColour !== "red",
  },
  // The average is a number, not a set — but the journeys behind it are a set,
  // and those are what a coordinator wants when the average looks wrong. Making
  // it clickable keeps every tile in the strip behaving the same way; one inert
  // box among five buttons reads as broken rather than as different.
  avgJourney: {
    label: "Journeys behind today's average",
    match: (card) => card.finished,
  },
};

function StatTile({ value, unit, label, sub, colour, dark, filterKey, activeFilter, onFilter }) {
  const clickable = !!filterKey;
  const active = clickable && activeFilter === filterKey;
  const body = (
    <>
      <div className="sv" style={colour ? { color: colour } : undefined}>
        {value}
        {unit && <span className="sv-unit">{unit}</span>}
      </div>
      <div>
        <div className="sl">{label}</div>
        <div className="ss">{sub}</div>
      </div>
    </>
  );
  if (!clickable) return <div className={`stat${dark ? " dark" : ""}`}>{body}</div>;
  return (
    <button
      type="button"
      className={`stat clickable${dark ? " dark" : ""}${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={() => onFilter(active ? null : filterKey)}
    >
      {body}
    </button>
  );
}

export default function FlowManagerPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canEditSla = hasCapability(role, CAP.GINIFLOW_SLA_ADMIN);
  const queryClient = useQueryClient();
  const now = useTick();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statFilter, setStatFilter] = useState(null);
  const [openVisit, setOpenVisit] = useState(null);
  const [report, setReport] = useState(null);
  const [slaError, setSlaError] = useState("");
  const [date, setDate] = useState(null);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  const perfRef = useRef(null);
  const rootRef = useRef(null);
  const reportRef = useRef(null);
  const debouncedSearch = useDebounced(search, 250);
  const { data: searchData, isFetching: searching } = useGiniflowSearch(debouncedSearch, date);
  const { data, isLoading, isError, error, dataUpdatedAt } = useGiniflowBoard(date);
  const expired = error?.response?.status === 401;

  // A display left open overnight would keep asking for yesterday. When the IST
  // date rolls over, drop back to "today" and refetch (GF: day rollover).
  const istDay = new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  useEffect(() => {
    if (!date) queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  }, [istDay, date, queryClient]);

  // The wall display's own clock may drift; every timer is measured against the
  // server's, so the offset between the two is applied to each tick.
  const offsetMs = useMemo(
    () => (data?.serverTime ? dataUpdatedAt - new Date(data.serverTime).getTime() : 0),
    [data?.serverTime, dataUpdatedAt],
  );

  // The day-report panel is anchored above the performance strip; measure it
  // rather than guessing, so the panel cannot cover the footer tiles.
  useEffect(() => {
    const el = perfRef.current;
    const root = rootRef.current;
    if (!el || !root) return undefined;
    const apply = () => root.style.setProperty("--perf-h", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [report]);

  const closeReport = useCallback(() => setReport(null), []);
  useDismissable(!!report, closeReport, reportRef);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  const saveSla = useMutation({
    mutationFn: async (draft) => {
      const budgets = Object.entries(draft).map(([station, value]) => ({
        station,
        budgetMinutes: parseInt(value, 10),
      }));
      return (await api.patch("/api/giniflow/sla-config", { budgets })).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      setDrawerOpen(false);
      setSlaError("");
      showToast("✓ Time budgets saved — all timers recalculated");
    },
    onError: (e) =>
      setSlaError(
        e?.response?.status === 403
          ? "Your role cannot change time budgets."
          : e?.response?.data?.error || "Could not save budgets — nothing was changed.",
      ),
  });

  // GF-26: a toast that vanishes in 3s is no place for the day's numbers.
  const dayReport = async () => {
    try {
      const { data: r } = await api.get("/api/giniflow/day-report", {
        params: date ? { date } : {},
      });
      setReport(r);
    } catch {
      showToast("Day report unavailable");
    }
  };

  if (isLoading && !data) return <div className="gf gf-loading">Loading floor…</div>;
  if (expired)
    return (
      <div className="gf gf-loading">
        Session expired — sign in again to keep the floor board live.
      </div>
    );
  if (isError && !data) return <div className="gf gf-loading">Board unavailable — retrying…</div>;

  const { columns = [], stats = {}, bottleneck, stationAverages = [], slaConfig = [] } = data || {};
  const ageSeconds = Math.round((now - dataUpdatedAt) / 1000);
  const stale = ageSeconds > 45;

  const filter = statFilter ? STAT_FILTERS[statFilter] : null;
  const searchActive = debouncedSearch.trim().length >= 2;
  const searchIds = searchActive
    ? new Set((searchData?.results || []).map((r) => r.visitId))
    : null;

  const shownColumns =
    filter || searchIds
      ? columns.map((col) => {
          const cards = col.cards.filter(
            (c) => (!filter || filter.match(c)) && (!searchIds || searchIds.has(c.id)),
          );
          return { ...col, cards, count: cards.length };
        })
      : columns;
  const filteredCount = filter || searchIds ? shownColumns.reduce((sum, c) => sum + c.count, 0) : 0;

  return (
    <div className={`gf${stale ? " stale" : ""}`} ref={rootRef}>
      <div className="rail">
        <div className="rl">Gini Flow</div>
        <div className="rsep" />
        <span className="rail-title">Flow Manager</span>
        <span className="rail-live">
          <span className="live-dot" />{" "}
          {stale
            ? "Reconnecting…"
            : `Live · ${new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`}
        </span>
        <div className="rr">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name, file no, phone…"
            aria-label="Search today's patients"
            onChange={(e) => setSearch(e.target.value)}
          />
          <input
            className="rail-date"
            type="date"
            value={date || istDay}
            max={istDay}
            aria-label="Board date"
            onChange={(e) => setDate(e.target.value === istDay ? null : e.target.value || null)}
          />
          {date && (
            <button className="rbtn" onClick={() => setDate(null)}>
              Back to today
            </button>
          )}
          <button className="rbtn" data-gf-toggle onClick={dayReport}>
            📊 Day report
          </button>
          <button className="rbtn" data-gf-toggle onClick={() => setDrawerOpen(true)}>
            ⚙ Time budgets
          </button>
          {/* The prototype's own button only names the stations — it does not
              navigate, and there is nothing to navigate to yet. It must not link
              into the old /flow/* pages: that would reconnect the two systems in
              the UI (GF-13). */}
          <button
            className="rbtn"
            onClick={() =>
              showToast(
                "Station screens — Reception · Vitals · MO/SD · Doctor · Lab · Pharmacy — not built yet",
                4000,
              )
            }
          >
            Switch role
          </button>
          <span className="rail-clock">
            {new Date(now).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </span>
        </div>
      </div>

      <div className="stats" aria-label="Day totals — select one to filter the board">
        <StatTile
          value={stats.inBuilding ?? 0}
          label="In building now"
          sub={`of ${stats.booked ?? 0} booked`}
          filterKey="inBuilding"
          activeFilter={statFilter}
          onFilter={setStatFilter}
        />
        <StatTile
          value={stats.completed ?? 0}
          colour="var(--grn)"
          label="Completed"
          sub={stats.avgCompletedMinutes ? `avg ${stats.avgCompletedMinutes} min` : "—"}
          filterKey="completed"
          activeFilter={statFilter}
          onFilter={setStatFilter}
        />
        <StatTile
          value={stats.overBudget ?? 0}
          colour="var(--red)"
          label="Over time budget"
          sub="need attention"
          filterKey="overBudget"
          activeFilter={statFilter}
          onFilter={setStatFilter}
        />
        <StatTile
          value={stats.blocked ?? 0}
          colour="var(--amb)"
          label="Blocked"
          sub="missing reports / payment"
          filterKey="blocked"
          activeFilter={statFilter}
          onFilter={setStatFilter}
        />
        <StatTile
          dark
          value={stats.avgCompletedMinutes ?? "—"}
          unit="m"
          colour="#fff"
          label="Avg journey today"
          sub={`target ${stats.journeyTargetMinutes}m · ${
            stats.avgCompletedMinutes && stats.avgCompletedMinutes <= stats.journeyTargetMinutes
              ? "✓ on track"
              : "over target"
          }`}
          filterKey="avgJourney"
          activeFilter={statFilter}
          onFilter={setStatFilter}
        />
        {/* Measures completed station-to-station hops today, which is what the
            label says. The filter shows who is currently inside budget — related,
            but not the same set, so the sub-label spells out which is which. */}
        <StatTile
          value={stats.withinSlaPct === null ? "—" : `${stats.withinSlaPct}%`}
          colour="var(--tl)"
          label="Within SLA"
          sub={`${stats.slaTransitions ?? 0} completed transitions`}
          filterKey="withinSla"
          activeFilter={statFilter}
          onFilter={setStatFilter}
        />
      </div>

      {(filter || searchActive) && (
        <div className="filter-bar">
          <span className="fb-t">
            {searching && searchActive ? (
              "Searching…"
            ) : (
              <>
                Showing <strong>{filteredCount}</strong> patient
                {filteredCount === 1 ? "" : "s"}
                {filter ? ` · ${filter.label}` : ""}
                {searchActive ? ` · matching "${debouncedSearch.trim()}"` : ""}
                {searchActive && (searchData?.results?.length || 0) > filteredCount
                  ? ` — ${searchData.results.length - filteredCount} more matched but have left the floor`
                  : ""}
              </>
            )}
          </span>
          <button
            type="button"
            className="fb-clear"
            onClick={() => {
              setStatFilter(null);
              setSearch("");
            }}
          >
            ✕ Clear
          </button>
        </div>
      )}

      {bottleneck && (
        <div className="bottleneck">
          <div className="bn-ico">🚨</div>
          <div className="bn-t">
            <strong>Bottleneck: {bottleneck.label}</strong> — {bottleneck.count} patient
            {bottleneck.count === 1 ? "" : "s"} queued, avg wait{" "}
            <strong>{bottleneck.avgMinutes} min</strong> against {bottleneck.budgetMinutes} min
            budget.
            {bottleneck.longest
              ? ` Longest: ${bottleneck.longest.name} ${bottleneck.longest.minutes}m.`
              : ""}{" "}
            Suggest: {bottleneck.suggestion}
          </div>
          <button
            className="rbtn bn-btn"
            onClick={() =>
              showToast("Station screens are not built yet — tell the station directly")
            }
          >
            Notify stations
          </button>
        </div>
      )}

      <div className="too-narrow">
        <strong>The floor board needs a wider screen.</strong>
        <span>
          Eight columns of live timers do not survive a phone. Open Gini Flow on the floor display
          or a desktop (1024px or wider).
        </span>
      </div>

      <div className="board-wrap">
        <div className="board">
          {shownColumns.map((column) => (
            <Column
              key={column.key}
              column={column}
              offsetMs={offsetMs}
              now={now}
              onOpen={(c) => setOpenVisit(c.id)}
            />
          ))}
        </div>
      </div>

      <div className="perf" ref={perfRef}>
        {stationAverages.map((s) => (
          <div
            className="pf"
            key={s.station}
            style={
              s.station === "total_journey"
                ? { background: "var(--nv)", borderColor: "var(--nv)" }
                : undefined
            }
          >
            <div
              className="pf-name"
              style={s.station === "total_journey" ? { color: "rgba(255,255,255,.5)" } : undefined}
            >
              {s.label}
            </div>
            <div
              className={`pf-val ${s.colour === "red" ? "r" : s.colour === "amber" ? "a" : "g"}`}
              style={s.station === "total_journey" ? { color: "#fff" } : undefined}
            >
              {s.actualMinutes === null ? "—" : `${s.actualMinutes}m`}{" "}
              <span className="pf-sla">/ {s.budgetMinutes}m</span>
            </div>
            <div className="pf-bar">
              <div
                className="pf-fill"
                style={{
                  width: `${s.fillPct}%`,
                  background:
                    s.colour === "red"
                      ? "var(--red)"
                      : s.colour === "amber"
                        ? "var(--amb)"
                        : "var(--grn)",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <SlaDrawer
        open={drawerOpen}
        slaConfig={slaConfig}
        canEdit={canEditSla}
        saving={saveSla.isPending}
        onClose={() => setDrawerOpen(false)}
        onSave={saveSla.mutate}
        error={slaError}
      />
      {report && (
        <div className="report-panel" ref={reportRef} role="dialog" aria-label="Day report">
          <div className="rp-hd">
            <strong>Day report · {report.date}</strong>
            <button className="tb-cls" onClick={closeReport} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="rp-body">
            <div className="rp-line">{report.summary}</div>
            <div className="rp-grid">
              <span>In building</span>
              <span>{report.stats.inBuilding}</span>
              <span>Completed</span>
              <span>{report.stats.completed}</span>
              <span>Avg journey</span>
              <span>
                {report.stats.avgCompletedMinutes ?? "—"}m / {report.stats.journeyTargetMinutes}m
              </span>
              <span>Over budget</span>
              <span>{report.stats.overBudget}</span>
              <span>Blocked</span>
              <span>{report.stats.blocked}</span>
              <span>Within SLA</span>
              <span>
                {report.stats.withinSlaPct ?? "—"}% of {report.stats.slaTransitions} transitions
              </span>
            </div>
          </div>
        </div>
      )}
      {openVisit && (
        <TimelineModal
          visitId={openVisit}
          slaConfig={slaConfig}
          onClose={() => setOpenVisit(null)}
        />
      )}
      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
