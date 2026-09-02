import { useRef, useState } from "react";
import {
  useReferrals,
  useCreateReferral,
  useRemoveReferral,
  useSendLetter,
  useBookReferralAppointment,
  useCompleteReferral,
  useRecordResponse,
} from "../../queries/hooks/useGiniflowReferrals";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import ReferralForm from "./referrals/ReferralForm";
import ReferralCard from "./referrals/ReferralCard";
import "../../styles/giniflow-station.css";

// The referrals station — gini-stations.html #s-referrals.
//
// docs/gini-flow/19-REFERRALS-STATION-PLAN.md §4. A bare list, deliberately: no
// `.stats` strip and no `.sec` card chrome, unlike Lab, Pharmacy and Reception.
// A referral has no SLA — the floor's time budgets measure how long a patient
// waits INSIDE the building, and a specialist appointment three weeks out is not
// a bottleneck a coordinator can clear — so the list is ordered by urgency and
// age, and nothing here is coloured by a budget.
//
// Three things the prototype lacks and this adds (§4): real counts instead of
// hard-coded strings, an empty note in each group, and a search — a referral
// list is looked at to answer "what happened to Mr Sandhu", which is a search.

// A group heading that opens and closes its own list. A real button inside the
// heading, so it keeps heading semantics for a screen reader and states whether
// the section is open — same shape as the vitals queue's GroupHead, and it
// reuses that chevron and count.
function GroupHead({ title, sub, count, open, onToggle, id }) {
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
        {title}
        {sub && <span className="sq-ghsub">— {sub}</span>}
        <span className="sq-count">{count}</span>
      </button>
    </h2>
  );
}

export default function ReferralsStationPage() {
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  // Today open, the last 30 days closed. The station is worked forward: past
  // referrals are what you go looking for, and they are twenty rows deep.
  const [groups, setGroups] = useState({ today: true, past: false });
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  // One character is not a search — it is an ILIKE over every referral of the
  // last month. Two is the floor every other Gini Flow search uses.
  const query = search.trim().length >= 2 ? search.trim() : "";
  const { data, isLoading } = useReferrals(undefined, query);
  const live = useGiniflowLive({ date: data?.date, paused: formOpen });

  const create = useCreateReferral();
  const remove = useRemoveReferral();
  const send = useSendLetter();
  const book = useBookReferralAppointment();
  const complete = useCompleteReferral();
  const respond = useRecordResponse();

  const busy =
    create.isPending ||
    remove.isPending ||
    send.isPending ||
    book.isPending ||
    complete.isPending ||
    respond.isPending;

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  };

  const fail = (e) => showToast(e?.response?.data?.error || "That did not go through");

  const onCreate = (body, reset) =>
    create.mutate(body, {
      onSuccess: (r) => {
        reset();
        setFormOpen(false);
        showToast(`✓ Referral created — ${r.specialtyLabel} for ${r.name}`);
      },
      onError: fail,
    });

  const onAction = (action, r, opts = {}) => {
    if (action === "letter") return showToast(`📄 Opening the letter for ${r.name}…`);

    if (action === "send") {
      return send.mutate(
        { id: r.id, to: opts.to },
        {
          onSuccess: (res) =>
            showToast(
              res.dev
                ? `⚠ ${res.reason}`
                : res.alreadySent
                  ? "This letter has already been sent — nothing was sent twice"
                  : `📱 Letter sent to ${opts.to === "doctor" ? r.toDoctor || "the specialist" : r.name}`,
            ),
          onError: fail,
        },
      );
    }

    if (action === "appointment") {
      return book.mutate(
        { id: r.id, date: opts.date, note: opts.note },
        {
          onSuccess: () => showToast(`📅 Appointment recorded for ${r.name}`),
          onError: fail,
        },
      );
    }

    if (action === "response") {
      return respond.mutate(
        { id: r.id, note: opts.note, medicines: opts.medicines, complete: true },
        {
          onSuccess: (res) => {
            const n = res.medicinesAdded?.length || 0;
            showToast(
              n
                ? `✓ Reply recorded — ${n} medicine${n === 1 ? "" : "s"} added to ${r.name}'s chart as external`
                : `✓ Reply recorded — ${r.specialtyLabel} referral closed`,
            );
          },
          onError: fail,
        },
      );
    }

    if (action === "complete") {
      return complete.mutate(r.id, {
        onSuccess: (res) =>
          showToast(
            res.unchanged
              ? "This referral was already closed"
              : `✓ ${r.specialtyLabel} referral closed — the specialist has seen ${r.name}`,
          ),
        onError: fail,
      });
    }

    if (action === "remove") {
      return remove.mutate(r.id, {
        onSuccess: () => showToast(`Referral removed — ${r.specialtyLabel} for ${r.name}`),
        onError: fail,
      });
    }
    return undefined;
  };

  const today = data?.today || [];
  const past = data?.past || [];

  return (
    <div className="gf">
      <div className="rail">
        <div className="rl">Referrals</div>
        <div className="rsep" />
        <span className="rail-title">Today&apos;s external referrals</span>
        <div className="rr">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name, file no, doctor…"
            aria-label="Search referrals"
            onChange={(e) => setSearch(e.target.value)}
          />
          <LiveBadge live={live} className="tr-live" />
          <button
            type="button"
            className={`rbtn grn${formOpen ? " act" : ""}`}
            onClick={() => setFormOpen((v) => !v)}
          >
            {formOpen ? "✕ Close" : "+ New referral"}
          </button>
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          <ReferralForm
            open={formOpen}
            date={data?.date}
            busy={create.isPending}
            onCreate={onCreate}
            onCancel={() => setFormOpen(false)}
          />

          {isLoading && <div className="empty-note">Loading referrals…</div>}

          {!isLoading && (
            <>
              <div className="ref-group">
                <GroupHead
                  id="ref-today"
                  title="Today's referrals"
                  count={today.length}
                  open={groups.today}
                  onToggle={() => setGroups((g) => ({ ...g, today: !g.today }))}
                />
                <div id="ref-today" className="ref-list" hidden={!groups.today}>
                  {today.length ? (
                    today.map((r) => (
                      <ReferralCard key={r.id} referral={r} busy={busy} onAction={onAction} />
                    ))
                  ) : (
                    <div className="empty-note">
                      {query
                        ? "No referral today matches that search."
                        : "No referrals today. A consultant raises one from the Care plan's referral chips, or start one with “+ New referral”."}
                    </div>
                  )}
                </div>
              </div>

              <div className="ref-group">
                <GroupHead
                  id="ref-past"
                  title="Past referrals"
                  sub="last 30 days"
                  count={past.length}
                  open={groups.past || !!query}
                  onToggle={() => setGroups((g) => ({ ...g, past: !g.past }))}
                />
                <div id="ref-past" className="ref-list" hidden={!groups.past && !query}>
                  {past.length ? (
                    past.map((r) => (
                      <ReferralCard key={r.id} referral={r} past busy={busy} onAction={onAction} />
                    ))
                  ) : (
                    <div className="empty-note">
                      {query
                        ? "Nothing in the last 30 days matches that search."
                        : "No referrals in the last 30 days."}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
