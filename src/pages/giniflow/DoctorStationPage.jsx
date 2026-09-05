import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDoctorQueue, useStartConsult } from "../../queries/hooks/useGiniflowDoctor";
import "../../styles/giniflow-station.css";
import StationNotice from "../../components/giniflow/StationNotice";

// The consultant's day list — gini-doctor-v3.html.
//
// Design: docs/gini-flow/13-CONSULTANT-STATION-PLAN.md §4. Four groups, in the
// order the consultant acts on them, and a waiting time on every card: this is
// the floor's bottleneck queue, so the wait is the first thing it must say.

const CATEGORY_BADGE = {
  worse_out_of_range: { cls: "b-red", label: "🔴 Worse" },
  worse_in_range: { cls: "b-amb", label: "🟠 Watch" },
  getting_better: { cls: "b-amb", label: "🟡 Flag" },
  in_control: { cls: "b-grn", label: "✅ In control" },
  no_reports: { cls: "b-blu", label: "🔵 No reports" },
};

const PRIORITY_CHIP = {
  urgent: { cls: "pri-urgent", label: "❗ Urgent" },
  high: { cls: "pri-high", label: "⬆ High" },
};

const GROUPS = [
  { key: "withMe", icon: "🟢", title: "With me now", sub: "in visit" },
  // A colleague's patient who is in a room right now. Only ever populated on
  // the All scope, and only because "With me now" must mean *me* — an admin
  // with no patients was being shown one as theirs.
  {
    key: "withOtherDoctor",
    icon: "👥",
    title: "In consultation elsewhere",
    sub: "another doctor's room",
    readOnly: true,
  },
  { key: "resultsReady", icon: "⏳", title: "Results ready", sub: "waiting for me" },
  { key: "pipeline", icon: "🔵", title: "In pipeline", sub: "not ready yet" },
  { key: "done", icon: "✅", title: "Done today", sub: "" },
];

const useTick = (intervalMs = 1000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

const minutesSince = (iso, now) =>
  iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000)) : null;

const budgetColour = (minutes, budget) => {
  if (!budget) return "neutral";
  const pct = (minutes / budget) * 100;
  if (pct > 100) return "r";
  if (pct >= 80) return "a";
  return "g";
};

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

function StatTile({ value, label, sub, tone }) {
  return (
    <div className={`dstat${tone ? ` ds-${tone}` : ""}`}>
      <div className="ds-val">{value}</div>
      <div className="ds-lab">{label}</div>
      {sub && <div className="ds-sub">{sub}</div>}
    </div>
  );
}

// A group heading that opens and closes its own section. A real button inside
// the heading, so it keeps the heading semantics for a screen reader and states
// whether the section is open.
function GroupHead({ icon, title, sub, count, open, onToggle, id }) {
  return (
    <h2 className="dg-head">
      <button
        type="button"
        className="dg-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={`dg-chev${open ? " open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span>{icon}</span> {title}
        {sub && <span className="dg-sub">— {sub}</span>}
        <span className="dg-count">{count}</span>
      </button>
    </h2>
  );
}

function QueueCard({ card, now, group, onOpen }) {
  const waited = minutesSince(card.statusSince, now) ?? card.waitMinutes ?? 0;
  const tone = group === "done" ? "neutral" : budgetColour(waited, card.waitBudget);
  const chip = PRIORITY_CHIP[card.priority];
  const badge = CATEGORY_BADGE[card.category];
  const missing = card.results.status === "missing";

  // An anchor, not a button, because this navigates to a URL.
  //
  // A consultant reviewing two or three patients side by side had no way to do
  // it: a button cannot be ctrl-clicked, middle-clicked, or right-clicked into
  // a new tab, and the browser could not show the destination on hover. Making
  // it a real link hands all of that back for free.
  //
  // A modified click is left entirely to the browser. That matters clinically:
  // the plain click below claims the room, and opening three patients in three
  // tabs must not claim three rooms — one consultant with four consultations at
  // once is the exact fiction startConsult was written to prevent. Reading a
  // patient in another tab records nothing, which is what reading ahead is.
  return (
    <a
      href={`/giniflow/station/doctor/${card.visitId}`}
      className={`dcard${chip ? ` ${chip.cls}` : ""}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onOpen(card);
      }}
    >
      <div className="dc-time">{card.appointmentTime || "—"}</div>
      <div className="dc-av">{initials(card.name)}</div>
      <div className="dc-main">
        <div className="dc-name">
          {card.name}
          {chip && <span className={`si-pri ${chip.cls}`}>{chip.label}</span>}
          {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
          <span className="dc-visit">Visit {card.visitNumber ?? "—"}</span>
        </div>
        <div className="dc-meta">
          {card.age}
          {(card.sex || "")[0] || ""} · {card.fileNo || "—"}
          {card.sdName ? ` · SD ${card.sdName}` : ""}
        </div>

        {/* The journey rail — the element that makes this a flow screen rather
            than a list. Read from the event log, so a step that never happened
            never shows a tick. */}
        <div className="dc-rail">
          {card.journey.map((step, i) => (
            <span key={step.key} className={`dr-step dr-${step.state}`}>
              {i > 0 && <span className="dr-sep">›</span>}
              {step.label}
              {step.state === "done" ? " ✓" : ""}
            </span>
          ))}
        </div>

        <div className="dc-bottom">
          <span className={`dc-res dc-res-${card.results.status}`}>{card.results.label}</span>
          {card.keyNumbers.map((k) => (
            <span key={k.test} className="dc-num">
              <strong>{k.value}</strong> {k.test}
            </span>
          ))}
          {card.priorityReason && <span className="si-reason">❗ {card.priorityReason}</span>}
        </div>
      </div>
      <div className="dc-right">
        <span className={`si-tmr si-tmr-${tone}`}>⏱ {waited}m</span>
        <span className="dc-state">
          {group === "withMe"
            ? "in room"
            : group === "done"
              ? card.statusLabel
              : missing
                ? "blocked"
                : "waiting"}
        </span>
      </div>
    </a>
  );
}

export default function DoctorStationPage() {
  const navigate = useNavigate();
  const now = useTick();
  const [scope, setScope] = useState("mine");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [toast, setToast] = useState("");
  // Done today is closed to begin with: it is a record of work finished, and on
  // a full day it is the longest list on the screen — the two groups a
  // consultant acts on should not start below fifty cards of history.
  const [collapsed, setCollapsed] = useState(() => new Set(["done"]));
  const toastTimer = useRef(null);

  const toggleGroup = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  const { data, isLoading } = useDoctorQueue({ scope, q: debounced });
  const startConsult = useStartConsult();

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const counts = data?.counts || {};
  const groups = data?.groups || {};
  const pipelineOthers = data?.pipelineOthers || [];
  const othersTotal = pipelineOthers.reduce((n, g) => n + g.cards.length, 0);

  // Opening a queued patient claims the room; opening a finished or
  // still-in-pipeline one is reading ahead, which is exactly what a consultant
  // does between patients — so it must not move anybody's status.
  const open = (card, group) => {
    if (group === "resultsReady" || group === "pipeline") {
      startConsult.mutate(card.visitId, {
        onSuccess: () => navigate(`/giniflow/station/doctor/${card.visitId}`),
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not start — nothing was changed"),
      });
      return;
    }
    navigate(`/giniflow/station/doctor/${card.visitId}`);
  };

  return (
    <div className="gf">
      <StationNotice station="doctor" />
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--blu-l)", color: "var(--blu)" }}>
          🧑‍⚕️ Consultant
        </div>
        <div className="rail-right">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name or file no…"
            aria-label="Search today's patients"
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="scope-toggle" role="group" aria-label="Whose patients">
            <button
              type="button"
              className={scope === "mine" ? "on" : ""}
              onClick={() => setScope("mine")}
            >
              My patients
            </button>
            <button
              type="button"
              className={scope === "all" ? "on" : ""}
              onClick={() => setScope("all")}
            >
              All
            </button>
          </div>
          <a className="tr-back" href="/giniflow/stations">
            ← Stations
          </a>
          <a className="tr-back" href="/giniflow/manager">
            ← Board
          </a>
        </div>
      </div>

      <div className="dstats">
        <StatTile value={counts.total ?? 0} label="Today's patients" sub={data?.date || ""} />
        <StatTile value={counts.withMe ?? 0} label="With me now" sub="in visit" tone="grn" />
        <StatTile
          value={counts.resultsReady ?? 0}
          label="Results ready"
          sub="waiting for me"
          tone="blu"
        />
        <StatTile value={counts.completed ?? 0} label="Completed" sub="today" tone="grn" />
        <StatTile
          value={counts.missingResults ?? 0}
          label="Missing results"
          sub="can't proceed"
          tone="red"
        />
        <StatTile
          value={counts.avgVisitMinutes == null ? "—" : `${counts.avgVisitMinutes}m`}
          label="Avg visit time"
          sub={counts.visitBudgetMinutes ? `target ${counts.visitBudgetMinutes}m` : ""}
        />
      </div>

      <div className="dlist">
        {isLoading && !data && <div className="sq-foot">Loading the day…</div>}
        {GROUPS.map((g) => {
          const list = groups[g.key] || [];
          if (!list.length && g.key === "done") return null;
          // Only ever populated on the All scope, so an empty heading on "My
          // patients" would be a permanent piece of furniture saying nothing.
          if (!list.length && g.key === "withOtherDoctor") return null;

          // The pipeline answers two different questions, so it is two columns:
          // who is coming to ME, and who is on the floor waiting for somebody
          // else. The second is what tells a consultant why the doctor queue is
          // empty while the waiting room is full, and who to ask about it.
          if (g.key === "pipeline") {
            const open = !collapsed.has(g.key);
            return (
              <section className="dgroup" key={g.key}>
                <GroupHead
                  icon={g.icon}
                  title={g.title}
                  sub="not ready yet"
                  count={list.length + othersTotal}
                  open={open}
                  onToggle={() => toggleGroup(g.key)}
                  id="dgroup-pipeline"
                />
                <div className="dsplit" id="dgroup-pipeline" hidden={!open}>
                  <div className="dcol">
                    <h3 className="dcol-head">
                      Mine <span className="dg-count">{list.length}</span>
                    </h3>
                    {/* Unassigned patients sit here, not with another
                        consultant: nobody has claimed them, so they are yours
                        to pick up. */}
                    {list.length === 0 && (
                      <div className="sq-foot">Nobody in your pipeline right now.</div>
                    )}
                    {list.map((card) => (
                      <QueueCard
                        key={card.visitId}
                        card={card}
                        now={now}
                        group={g.key}
                        onOpen={(c) => open(c, g.key)}
                      />
                    ))}
                  </div>

                  <div className="dcol dcol-others">
                    <h3 className="dcol-head">
                      Waiting for another consultant <span className="dg-count">{othersTotal}</span>
                    </h3>
                    {pipelineOthers.length === 0 && (
                      <div className="sq-foot">
                        Nobody on the floor is assigned to another consultant.
                      </div>
                    )}
                    {pipelineOthers.map((doc) => {
                      const key = `other:${doc.doctorId}`;
                      const openDoc = !collapsed.has(key);
                      return (
                        <div className="dsub" key={doc.doctorId}>
                          <h4 className="dsub-head">
                            <button
                              type="button"
                              className="dsub-toggle"
                              aria-expanded={openDoc}
                              aria-controls={`dsub-${doc.doctorId}`}
                              onClick={() => toggleGroup(key)}
                            >
                              <span
                                className={`dg-chev${openDoc ? " open" : ""}`}
                                aria-hidden="true"
                              >
                                ▸
                              </span>
                              🧑‍⚕️ {doc.doctorName}
                              <span className="dg-count">{doc.cards.length}</span>
                            </button>
                          </h4>
                          <div id={`dsub-${doc.doctorId}`} hidden={!openDoc}>
                            {doc.cards.map((card) => (
                              <QueueCard
                                key={card.visitId}
                                card={card}
                                now={now}
                                group="otherConsultant"
                                onOpen={(c) => navigate(`/giniflow/station/doctor/${c.visitId}`)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            );
          }

          const isOpen = !collapsed.has(g.key);
          return (
            <section className="dgroup" key={g.key}>
              <GroupHead
                icon={g.icon}
                title={g.title}
                sub={g.sub}
                count={list.length}
                open={isOpen}
                onToggle={() => toggleGroup(g.key)}
                id={`dgroup-${g.key}`}
              />
              <div id={`dgroup-${g.key}`} hidden={!isOpen}>
                {list.length === 0 && (
                  <div className="sq-foot">
                    {g.key === "resultsReady"
                      ? "Nobody is ready for you yet."
                      : g.key === "withMe"
                        ? "No patient in the room."
                        : "—"}
                  </div>
                )}
                {list.map((card) => (
                  <QueueCard
                    key={card.visitId}
                    card={card}
                    now={now}
                    group={g.key}
                    onOpen={(c) => open(c, g.key)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
