import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import useAuthStore from "../../stores/authStore";
import { hasCapability, CAPABILITIES as CAP } from "../../../shared/permissions";
import {
  CHAIN,
  STATUS_LABEL,
  STATUS_TO_SLA_KEY,
  BOARD_COLUMNS,
  ORDERED_COLUMNS,
  nextColumn,
  PRIORITIES,
  PRIORITY_LABEL,
  PRIORITY_ICON,
  canDropInColumn,
  compareQueue,
  CATEGORIES,
  CATEGORY_META,
} from "../../../shared/giniflowStatus";
import {
  useGiniflowBoard,
  useGiniflowSearch,
  useGiniflowTimeline,
} from "../../queries/hooks/useGiniflowBoard";
import {
  useGiniflowSetPriority,
  useGiniflowReorder,
  useGiniflowMove,
} from "../../queries/hooks/useGiniflowQueue";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
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

// How many categories carry an override for one station — the count on the
// drawer's toggle, so a folded row still says it holds something.
const countOverrides = (overrides, station) =>
  Object.entries(overrides).filter(
    ([k, v]) => k.startsWith(`${station}:`) && String(v).trim() !== "",
  ).length;

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

const COLUMN_NAME = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.name]));

// Where this card may legally be dragged. Computed from the same chain rule the
// server enforces, so an impossible drop is never offered rather than being
// offered and then refused (GF-16: never show an action that cannot work).
const dropTargetsFor = (card) => ORDERED_COLUMNS.filter((key) => canDropInColumn(card, key));

// Why this card has nowhere to go, in the words of the thing that stopped it.
// A drop target that greys out with no explanation is the worst of the options
// the review left open (BQ-02).
const noMoveReason = (card) => {
  if (card.blockedReason) return "Blocked — clear it at the station first";
  if (card.finished) return "This visit is finished";
  if (!nextColumn(card.column)) return "Last column — nothing after this";
  return null;
};

// Dragging is a mouse gesture and the floor board is also driven from a keyboard,
// so every drag has a menu equivalent: priority, a nudge up or down inside the
// column, and the same forward move a drop would make.
function CardMenu({ card, canMoveUp, canMoveDown, onPriority, onNudge, onMove, onClose }) {
  const ref = useRef(null);
  const [pending, setPending] = useState(null);
  const [reason, setReason] = useState(card.priorityReason || "");
  useDismissable(true, onClose, ref);
  const targets = dropTargetsFor(card);
  const blocked = noMoveReason(card);

  // Raising a priority asks why, the way blocking does (GF-18) — but does not
  // insist: an urgent patient is often self-evident at the desk, and a required
  // sentence would only produce empty ones. Returning to normal needs no reason
  // and applies straight away.
  const choose = (p) => (p === "normal" ? onPriority(p, null) : setPending(p));

  return (
    <div className="pc-menu" ref={ref} role="menu">
      <div className="pcm-hd">Priority</div>
      {PRIORITIES.map((p) => (
        <button
          key={p}
          type="button"
          role="menuitemradio"
          aria-checked={card.priority === p}
          className={`pcm-item${card.priority === p ? " on" : ""}${pending === p ? " pending" : ""}`}
          onClick={() => choose(p)}
        >
          <span className={`pri-dot pri-${p}`} aria-hidden="true">
            {PRIORITY_ICON[p] || "·"}
          </span>
          {PRIORITY_LABEL[p]}
        </button>
      ))}
      {pending && (
        <div className="pcm-reason">
          <label htmlFor={`why-${card.id}`}>Why? (optional)</label>
          <input
            id={`why-${card.id}`}
            type="text"
            maxLength={200}
            value={reason}
            autoFocus
            placeholder="e.g. chest pain, elderly, travelling far"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onPriority(pending, reason.trim() || null)}
          />
          <button
            type="button"
            className="pcm-apply"
            onClick={() => onPriority(pending, reason.trim() || null)}
          >
            Set {PRIORITY_LABEL[pending]}
          </button>
        </div>
      )}
      <div className="pcm-hd">Order in this column</div>
      <button
        type="button"
        role="menuitem"
        className="pcm-item"
        disabled={!canMoveUp}
        onClick={() => onNudge(-1)}
      >
        ↑ Move up
      </button>
      <button
        type="button"
        role="menuitem"
        className="pcm-item"
        disabled={!canMoveDown}
        onClick={() => onNudge(1)}
      >
        ↓ Move down
      </button>
      <div className="pcm-hd">Send to</div>
      {targets.length === 0 && <div className="pcm-note">{blocked || "Nowhere from here"}</div>}
      {targets.map((key) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          className="pcm-item"
          onClick={() => onMove(key)}
        >
          → {COLUMN_NAME[key]}
        </button>
      ))}
    </div>
  );
}

function PatientCard({
  card,
  offsetMs,
  now,
  onOpen,
  flagged,
  canManage,
  dragging,
  onDragStart,
  onDragEnd,
  canMoveUp,
  canMoveDown,
  onPriority,
  onNudge,
  onMove,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
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
  // The lab track is keyed on a lab order rather than on a point in the chain,
  // and a finished visit has no next station — neither can be dragged anywhere.
  const draggable = canManage && !isLab && !card.finished;
  const act =
    (fn) =>
    (...args) => {
      setMenuOpen(false);
      fn(...args);
    };

  return (
    <div
      className={`pc${flagged ? " flagged" : ""}${dragging ? " dragging" : ""}${
        card.priority && card.priority !== "normal" ? ` pri-${card.priority}` : ""
      }`}
      data-card-id={card.id}
      draggable={draggable}
      onDragStart={(e) => {
        // Text/plain as well, so a card dragged into a text field or another
        // window degrades to the patient's name rather than to nothing.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.name);
        onDragStart(card);
      }}
      onDragEnd={onDragEnd}
      style={card.finished && !isLab ? { opacity: 0.6 } : undefined}
    >
      <button type="button" className="pc-open" onClick={() => onOpen(card)}>
        <div className="pc-top">
          <div className="pc-av" style={{ background: avatarColour(card.patientId) }}>
            {initials(card.name)}
          </div>
          <div className="pc-name">{card.name}</div>
          {card.priority && card.priority !== "normal" && (
            <span
              className={`pc-pri pri-${card.priority}`}
              title={`${PRIORITY_LABEL[card.priority]} priority${
                card.priorityReason ? ` — ${card.priorityReason}` : ""
              }`}
            >
              {PRIORITY_ICON[card.priority]} {PRIORITY_LABEL[card.priority]}
            </span>
          )}
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
          {!isLab && card.queuePosition != null && (
            <span className="pc-pos" title="Manually placed in this queue">
              #{card.queuePosition}
            </span>
          )}
        </div>
        {isLab && card.finished && !card.lab.atLab && (
          <div className="wait4 blocked">
            <span className="w-ico">🚫</span> Left without giving a sample
          </div>
        )}
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
      {canManage && !isLab && (
        <button
          type="button"
          className="pc-menu-btn"
          data-gf-toggle
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Priority and position for ${card.name}`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋮
        </button>
      )}
      {menuOpen && (
        <CardMenu
          card={card}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onPriority={act(onPriority)}
          onNudge={act(onNudge)}
          onMove={act(onMove)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

// Columns the manager can rearrange by hand. The lab track is ordered by its own
// timers rather than by the chain, and "Done today" is a record of what already
// happened — neither has a queue to arrange.
const ORDERABLE = (key) => key !== "lab" && key !== "done";

function Column({
  column,
  offsetMs,
  now,
  onOpen,
  canManage,
  drag,
  onDragStart,
  onDragEnd,
  onReorder,
  onMove,
  onPriority,
}) {
  const bodyRef = useRef(null);
  const [dropIndex, setDropIndex] = useState(null);
  const cards = useMemo(
    () => (ORDERABLE(column.key) ? [...column.cards].sort(compareQueue) : column.cards),
    [column.cards, column.key],
  );
  const sameColumn = drag?.column === column.key;
  const accepts =
    canManage && !!drag && (sameColumn ? ORDERABLE(column.key) : canDropInColumn(drag, column.key));

  // Which gap the card would land in, measured against the rendered cards rather
  // than tracked per card: one handler on the column body stays correct while the
  // list re-sorts underneath the pointer.
  const gapAt = (clientY) => {
    const els = [...(bodyRef.current?.querySelectorAll("[data-card-id]") || [])];
    const i = els.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return i === -1 ? els.length : i;
  };

  const handleDragOver = (e) => {
    if (!accepts) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(sameColumn ? gapAt(e.clientY) : cards.length);
  };

  const handleDrop = (e) => {
    if (!accepts) return;
    e.preventDefault();
    const gap = dropIndex ?? cards.length;
    setDropIndex(null);
    if (!sameColumn) return onMove(drag.id, column.key, drag.name);
    const from = cards.findIndex((c) => c.id === drag.id);
    const to = gap > from ? gap - 1 : gap;
    if (from === -1 || from === to) return;
    const ids = cards.map((c) => c.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorder(column.key, ids);
  };

  const nudge = (card, delta) => {
    const ids = cards.map((c) => c.id);
    const from = ids.indexOf(card.id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorder(column.key, ids);
  };

  return (
    <div
      className={`col${column.hot ? " hot" : ""}${accepts ? " drop-ok" : ""}${
        accepts && dropIndex !== null ? " drop-active" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDropIndex(null);
      }}
      onDrop={handleDrop}
    >
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
          {column.key === "lab" ? "Sample→upload budget: " : "Budget: "}
          <strong>{column.budgetMinutes} min</strong>
          {column.hot ? ` · avg now ${column.avgMinutes}m ⚠` : ""}
        </div>
      )}
      <div className="col-body" ref={bodyRef}>
        {cards.length === 0 && <div className="col-empty">{accepts ? "Drop here" : "—"}</div>}
        {cards.map((card, i) => (
          <Fragment key={`${column.key}-${card.id}`}>
            {accepts && sameColumn && dropIndex === i && <div className="drop-line" />}
            <PatientCard
              card={{ ...card, column: column.key }}
              offsetMs={offsetMs}
              now={now}
              onOpen={onOpen}
              canManage={canManage}
              dragging={drag?.id === card.id}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              canMoveUp={ORDERABLE(column.key) && i > 0}
              canMoveDown={ORDERABLE(column.key) && i < cards.length - 1}
              onPriority={(priority, reason) => onPriority(card.id, priority, reason)}
              onNudge={(delta) => nudge(card, delta)}
              onMove={(key) => onMove(card.id, key, card.name)}
            />
          </Fragment>
        ))}
        {accepts && sameColumn && dropIndex === cards.length && <div className="drop-line" />}
      </div>
    </div>
  );
}

function SlaDrawer({ open, slaConfig, canEdit, onClose, onSave, saving, error }) {
  const [draft, setDraft] = useState({});
  const panelRef = useRef(null);
  const [overrides, setOverrides] = useState({});
  // One station open at a time — five categories under ten stations is fifty
  // inputs, and the drawer is used to change one number.
  const [expanded, setExpanded] = useState(null);
  useDismissable(open, onClose, panelRef);
  const invalid = (v) => {
    if (v === undefined || v === "") return false;
    const n = Number(v);
    return !Number.isInteger(n) || n < 1 || n > 600;
  };
  const anyInvalid = Object.values(draft).some(invalid) || Object.values(overrides).some(invalid);
  useEffect(() => {
    if (!open) return;
    setDraft(Object.fromEntries(slaConfig.map((s) => [s.station, s.budgetMinutes])));
    // Flattened to "station:category" keys so one <input> owns one value and
    // the nesting is rebuilt once, at save.
    setOverrides(
      Object.fromEntries(
        slaConfig.flatMap((s) =>
          Object.entries(s.categoryOverrides || {}).map(([cat, min]) => [
            `${s.station}:${cat}`,
            min,
          ]),
        ),
      ),
    );
    setExpanded(null);
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

            {/* Per-category budgets (brief §3 `category_overrides`).
                
                A red-category patient is MEANT to take the doctor longer than an
                in-control follow-up. Judged against one number the board lies
                twice: the careful consultation shows red, the rushed one green.
                
                `total_journey` is excluded — it is the sum of the others, and an
                override there would silently disagree with them. */}
            {s.station !== "total_journey" && (
              <button
                type="button"
                className="sla-cat-toggle"
                aria-expanded={expanded === s.station}
                disabled={!canEdit}
                onClick={() => setExpanded((e) => (e === s.station ? null : s.station))}
              >
                {countOverrides(overrides, s.station)
                  ? `${countOverrides(overrides, s.station)} per-category`
                  : "Per category"}
              </button>
            )}

            {expanded === s.station && (
              <div className="sla-cats">
                {CATEGORIES.map((cat) => (
                  <label className="sla-cat" key={cat}>
                    <span>
                      {CATEGORY_META[cat]?.icon} {CATEGORY_META[cat]?.short || cat}
                    </span>
                    <input
                      className="sla-inp"
                      type="number"
                      min="1"
                      disabled={!canEdit}
                      placeholder={String(draft[s.station] ?? s.budgetMinutes)}
                      value={overrides[`${s.station}:${cat}`] ?? ""}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, [`${s.station}:${cat}`]: e.target.value }))
                      }
                    />
                    <span className="sla-unit">min</span>
                  </label>
                ))}
                <div className="sla-cat-hint">
                  Blank means this category uses the station budget above.
                </div>
              </div>
            )}
          </div>
        ))}
        <div className="sla-warn">
          ⚠ These budgets apply hospital-wide, to every station screen and every report — not just
          to your view of the board.
        </div>
        <div className="sla-hint">
          💡 <strong>Per category</strong> sets a different budget for one kind of patient — a
          longer doctor budget for red-category, a shorter one for in-control follow-ups. Anything
          left blank uses the station budget.
        </div>
      </div>
      <div className="dr-foot">
        {error && <div className="dr-err">{error}</div>}
        {canEdit && (
          <button
            className="btn btn-tl"
            disabled={saving || anyInvalid}
            onClick={() => onSave({ draft, overrides })}
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
  const canManageQueue = hasCapability(role, CAP.GINIFLOW_MANAGE_QUEUE);
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
  const [drag, setDrag] = useState(null);
  const [pendingMove, setPendingMove] = useState(null);
  const toastTimer = useRef(null);

  const perfRef = useRef(null);
  const rootRef = useRef(null);
  const reportRef = useRef(null);
  const debouncedSearch = useDebounced(search, 250);
  const { data: searchData, isFetching: searching } = useGiniflowSearch(debouncedSearch, date);
  const { data, isLoading, isError, error, dataUpdatedAt } = useGiniflowBoard(date);
  const expired = error?.response?.status === 401;
  const setPriorityMutation = useGiniflowSetPriority(date);
  const reorderMutation = useGiniflowReorder(date);
  const moveMutation = useGiniflowMove(date, data?.slaConfig || []);

  // A display left open overnight would keep asking for yesterday. When the IST
  // date rolls over, drop back to "today" and refetch (GF: day rollover).
  const istDay = new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  useEffect(() => {
    if (!date) queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  }, [istDay, date, queryClient]);

  // One connection for the whole board: the server says a visit moved, the
  // queries it affects refetch through the API (12-REALTIME-PLAN.md).
  const live = useGiniflowLive({ date: date || istDay });

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

  const [notifying, setNotifying] = useState(false);

  // Which desk a bottleneck column belongs to. The board's columns and the
  // station screens are different vocabularies — `wait_doctor` is a queue and
  // `doctor` is a desk — so the mapping is written once, here, against the
  // actual keys in BOARD_COLUMNS.
  const NOTIFY_TARGET = {
    // Checked in but not yet seen: the queue is the vitals desk's to call from.
    checked_in: ["vitals"],
    vitals: ["vitals"],
    sd: ["mo"],
    wait_doctor: ["doctor"],
    doctor: ["doctor"],
    pharmacy: ["pharmacy"],
    // The lab track stalls at either of two desks — an unpaid order is
    // reception's, an uncollected sample is the lab's — and the column does not
    // say which. Both are told rather than guessing and telling the wrong one.
    lab: ["lab", "reception"],
    // `done` is not a queue and has no desk, so it falls through to the refusal
    // below rather than being silently mapped somewhere.
  };

  const notifyStations = async (bn) => {
    const stations = NOTIFY_TARGET[bn?.station];
    if (!stations?.length) return showToast("No station desk owns that column");
    const station = stations.join(" and ");
    setNotifying(true);
    try {
      const text = `${bn.label}: ${bn.count} waiting, avg ${bn.avgMinutes} min against a ${bn.budgetMinutes} min budget.`;
      const { data } = await api.post("/api/giniflow/notify", { stations, text });
      // Said plainly when nothing went out. A green tick over an undelivered
      // message is worse than an honest failure — the coordinator would think
      // the desk had been told.
      showToast(
        !data?.delivered
          ? "Could not reach the station screens — tell them directly"
          : data.reachable
            ? `✓ Sent to ${station}`
            : // Published, but no screen can subscribe yet. Saying "sent" here
              // would stop the coordinator walking over, which is the one thing
              // that still works.
              `Sent, but no ${station} screen can receive it yet — tell them directly`,
      );
    } catch (e) {
      showToast(e?.response?.data?.error || "Could not send that");
    } finally {
      setNotifying(false);
    }
  };

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  // A rejected rearrangement is the manager's mis-drop, not a fault: say what the
  // floor can do about it instead of echoing the chain's internal status names.
  const queueError = (e) => {
    const message = e?.response?.data?.error || "";
    if (e?.response?.status === 403)
      return showToast("Your role cannot rearrange the floor board.");
    if (message.startsWith("Illegal transition"))
      return showToast("Move one station at a time — a patient cannot skip a station.");
    return showToast(message || "That move was not accepted — the board is unchanged.");
  };

  const onPriority = (visitId, priority, reason) =>
    setPriorityMutation.mutate({ visitId, priority, reason }, { onError: queueError });

  const onReorder = (columnKey, visitIds) =>
    reorderMutation.mutate(
      { columnKey, visitIds },
      {
        onError: queueError,
        // A reorder that silently drops the cards that moved on mid-drag would
        // tell the manager the board did what they asked when it did not (BQ-08).
        onSuccess: (r) =>
          r?.ignored?.length &&
          showToast(
            `${r.ignored.length} patient${r.ignored.length === 1 ? " had" : "s had"} already moved on — the rest were reordered`,
          ),
      },
    );

  const runMove = (visitId, column) => {
    setDrag(null);
    moveMutation.mutate({ visitId, column }, { onError: queueError });
  };

  // Done is the one drop that ends a visit on the board. Under append-only rules
  // a correction can only be a further forward event, and there are none left —
  // so a mis-drop on a touch wall display would be permanent. It asks first
  // (BQ-03); every other column applies straight away.
  const onMove = (visitId, column, name) => {
    if (column !== "done") return runMove(visitId, column);
    setDrag(null);
    setPendingMove({ visitId, column, name });
  };

  const saveSla = useMutation({
    mutationFn: async ({ draft, overrides }) => {
      // Flat "station:category" keys back into the {category: minutes} shape the
      // column holds. A blank input drops out, which is how a category is
      // returned to the station budget — the server COALESCEs an absent field
      // but honours an explicit {}.
      const budgets = Object.entries(draft).map(([station, value]) => {
        const categoryOverrides = Object.fromEntries(
          Object.entries(overrides)
            .filter(([k, v]) => k.startsWith(`${station}:`) && String(v).trim() !== "")
            .map(([k, v]) => [k.slice(station.length + 1), parseInt(v, 10)]),
        );
        return { station, budgetMinutes: parseInt(value, 10), categoryOverrides };
      });
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
  // A reorder sends the column's whole order, so it can only be done against the
  // whole column. Dragging a filtered column would write positions for the cards
  // that happen to be visible and leave everyone else unplaced beneath them.
  const hiding = !!filter || searchActive;
  const canRearrange = canManageQueue && !hiding && !date;

  return (
    <div className={`gf${stale ? " stale" : ""}`} ref={rootRef}>
      <div className="rail">
        <div className="rl">Gini Flow</div>
        <div className="rsep" />
        <span className="rail-title">Flow Manager</span>
        <LiveBadge live={live} stale={stale} />
        <span className="rail-date-label">
          {new Date().toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
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
          {/* The launcher, which is where the station screens are chosen from.
              A plain link, matching every station's own way back: it survives
              without JS and keeps the rail free of a router dependency. Still
              never the old /flow/* pages — linking those would reconnect the two
              systems in the UI (GF-13). */}
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
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
                {canManageQueue ? " · rearranging is off while the board is filtered" : ""}
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
          {/* Real now. The toast used to say "station screens are not built yet",
              which stopped being true some time ago — but rewording it would
              have been lipstick, because there was no way to send a sentence
              nobody had inserted into a table. That is what Realtime Broadcast
              added (21-SUPABASE-REALTIME-PLAN.md §3). */}
          <button
            className="rbtn bn-btn"
            disabled={notifying}
            onClick={() => notifyStations(bottleneck)}
          >
            {notifying ? "Sending…" : "Notify stations"}
          </button>
        </div>
      )}

      <div className="too-narrow">
        <strong>The floor board needs a wider screen.</strong>
        <span>
          Eight columns of live timers do not survive a phone. Open Gini Flow on the floor display
          or a desktop (900px or wider).
        </span>
      </div>

      <div className="board-wrap">
        <div className={`board${drag ? " dragging" : ""}`}>
          {shownColumns.map((column) => (
            <Column
              key={column.key}
              column={column}
              offsetMs={offsetMs}
              now={now}
              onOpen={(c) => setOpenVisit(c.id)}
              canManage={canRearrange}
              drag={drag}
              onDragStart={(card) =>
                setDrag({
                  id: card.id,
                  name: card.name,
                  column: card.column,
                  status: card.status,
                  resumeStatus: card.resumeStatus,
                })
              }
              onDragEnd={() => setDrag(null)}
              onReorder={onReorder}
              onMove={onMove}
              onPriority={onPriority}
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
      {pendingMove && (
        <div
          className="tmodal open"
          onClick={(e) => e.target === e.currentTarget && setPendingMove(null)}
        >
          <div className="tbox confirm" role="alertdialog" aria-label="Confirm end of visit">
            <div className="tb-hd">
              <div>
                <div className="tb-name">Send {pendingMove.name} to Done?</div>
                <div className="tb-meta">Records the medicines as dispensed</div>
              </div>
            </div>
            <div className="tb-body">
              <p className="cf-warn">
                This ends {pendingMove.name}&apos;s journey on the board. Gini Flow&apos;s log only
                moves forward, so it cannot be undone from here.
              </p>
              <div className="cf-actions">
                <button className="btn btn-g" onClick={() => setPendingMove(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-tl"
                  autoFocus
                  onClick={() => {
                    runMove(pendingMove.visitId, pendingMove.column);
                    setPendingMove(null);
                  }}
                >
                  Yes — dispensed, done
                </button>
              </div>
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
