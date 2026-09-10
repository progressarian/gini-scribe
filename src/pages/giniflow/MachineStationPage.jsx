import { useEffect, useRef, useState } from "react";
import {
  useMachineQueue,
  useMachineReconciliation,
  useAdvanceMachineTest,
  useUploadMachineReport,
  useMachineCandidates,
  useAddMachineTest,
} from "../../queries/hooks/useGiniflowMachine";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import StationNotice from "../../components/giniflow/StationNotice";
import LabResultsForm from "../../components/giniflow/LabResultsForm";
import PdfViewerModal from "../../components/visit/PdfViewerModal";
import { MACHINES, MACHINE_RUNGS, machineFor } from "../../../shared/machineStages.js";
import "../../styles/giniflow-station.css";
import "./MachineStationPage.css";

// The machine room: ABI, VPT, Fundus, TMT, ECG
// (docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md).
//
// A section per machine, not one flat queue. A bench runs twenty tubes at once;
// a treadmill takes one patient for twenty minutes, so the question this screen
// exists to answer is "how long until the TMT is free" — which needs the queues
// kept apart.

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "—";

const minutesSince = (iso) =>
  iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null;

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

const AVATAR = ["#374151", "#1e3a5f", "#14532d", "#7c2d12", "#7f1d1d", "#b45309"];
const avatarColour = (id) => AVATAR[Math.abs(id ?? 0) % AVATAR.length];

// A wait nobody can act on is worth saying out loud; one of five minutes is not.
const waitLabel = (m) =>
  m.waitMinutes >= 60
    ? `${Math.floor(m.waitMinutes / 60)}h ${m.waitMinutes % 60}m wait`
    : m.waitMinutes
      ? `${m.waitMinutes}m wait`
      : "free now";

function TestCard({ order, onAdvance, onOpen, busy }) {
  const mins = minutesSince(order.since);
  const machine = machineFor(order.machine);
  return (
    <div className={`mc-card${order.blockedReason ? " is-blocked" : ""}`}>
      <button type="button" className="mc-card__main" onClick={() => onOpen(order)}>
        <span className="mc-av" style={{ background: avatarColour(order.patientId) }}>
          {initials(order.name)}
        </span>
        <span className="mc-body">
          <span className="mc-name">
            {order.name}
            {order.fileNo && <span className="badge b-ink">{order.fileNo}</span>}
          </span>
          <span className="mc-meta">
            {[
              order.age && order.sex ? `${order.age}${order.sex[0]}` : order.age,
              machine ? `${machine.icon} ${machine.name}` : order.tests.join(" · "),
              order.orderedBy && `by ${order.orderedBy}`,
              clock(order.orderedAt),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {order.blockedReason && <span className="mc-blocked">⏸ {order.blockedReason}</span>}
        </span>
        <span className="mc-right">
          <span className={`sp ${MACHINE_RUNGS.find((r) => r.key === order.stage)?.pill || ""}`}>
            {order.stageLabel}
          </span>
          {mins !== null && <span className="mc-time">{mins}m</span>}
          <span className="mc-tlbl">{order.station}</span>
        </span>
      </button>
      {order.nextAction && (
        <button
          type="button"
          className="st-btn st-btn-tl mc-act"
          disabled={busy}
          onClick={() => onAdvance(order, order.nextAction.to)}
        >
          {order.nextAction.label}
        </button>
      )}
    </div>
  );
}

function TestPane({ order, onClose, onAdvance, onUpload, onView, busy }) {
  const paneRef = useRef(null);
  const fileRef = useRef(null);
  useEffect(() => {
    if (!order) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [order, onClose]);
  if (!order) return null;

  const machine = machineFor(order.machine);
  // Values are only offered where the machine produces them, and only once the
  // test has actually been run — a number typed against a test nobody has
  // started is a number nobody measured.
  const canEnterValues = !!machine?.values?.length && order.stage !== "ordered";
  const canUpload = order.stage !== "ordered";

  return (
    <div className="detail-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="detail-pane" ref={paneRef} role="dialog" aria-label="Machine test">
        <div className="dp-head">
          <div className="dp-name">{order.name}</div>
          <div className="dp-meta">
            {[order.age && order.sex ? `${order.age}${order.sex[0]}` : order.age, order.fileNo]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className="dp-acts">
            <button className="rbtn" type="button" onClick={onClose}>
              ← Back
            </button>
            <span className="sp sp-process">
              {machine ? `${machine.icon} ${machine.name}` : "Machine test"}
            </span>
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner">
            <div className="dp-sec">
              <div className="dp-sec-title">Where this test is</div>
              <div className="steps" style={{ marginTop: 8 }}>
                {order.steps.map((step, i) => (
                  <span key={step.name}>
                    <span className={`step step-${step.state}`}>
                      {step.name}
                      {step.state === "done" ? " ✓" : ""}
                    </span>
                    {i < order.steps.length - 1 && <span className="step-arr">›</span>}
                  </span>
                ))}
              </div>
              <div className="dp-hint">
                {machine ? `${machine.fullName} · about ${machine.durationMin} minutes` : ""}
              </div>
            </div>

            <div className="dp-sec">
              <div className="dp-sec-title">Update status</div>
              {order.blockedReason ? (
                <div className="dp-hint lab-blocked">⏸ {order.blockedReason}</div>
              ) : order.nextAction ? (
                <>
                  <div className="dp-hint">
                    {MACHINE_RUNGS.find((r) => r.advanceTo === order.nextAction.to)?.actionHint}
                  </div>
                  <button
                    type="button"
                    className="st-btn st-btn-tl btn-full"
                    disabled={busy}
                    onClick={() => onAdvance(order, order.nextAction.to)}
                  >
                    {order.nextAction.label}
                  </button>
                </>
              ) : (
                <div className="dp-hint">
                  ✓ Report filed — this patient reads “Results ready” on every dashboard.
                </div>
              )}
            </div>

            {canEnterValues && (
              <div className="dp-sec">
                <div className="dp-sec-title">Enter values — the doctor can trend these</div>
                <LabResultsForm orderId={order.orderId} onSaved={() => {}} onFailed={() => {}} />
              </div>
            )}

            {order.hasReport && (
              <div className="dp-sec">
                <div className="dp-sec-title">Report</div>
                <button
                  type="button"
                  className="st-btn st-btn-g"
                  disabled={!order.reportDocId}
                  onClick={() => onView(order)}
                >
                  📄 View report
                </button>
              </div>
            )}

            {canUpload && !order.hasReport && (
              <div className="dp-sec">
                <div className="dp-sec-title">Upload the report</div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,image/*"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) onUpload(order, file);
                  }}
                />
                <button
                  type="button"
                  className="upload-area"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  <div className="ua-ico">📄</div>
                  <div className="ua-t">Tap or drop the report here</div>
                  <div className="ua-s">PDF · JPG · PNG · Max 10MB</div>
                </button>
                <div className="dp-hint">
                  Filing the report closes this test and tells the MO the patient is released.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Raising a test for the patient standing at the machine. The alternative is
// that every machine test is ordered during the consultation, and today's floor
// says that does not happen — three patients had ABI, VPT and Fundus run with no
// order behind any of them.
// Off for now, at the floor's request.
const SHOW_ADD_TEST = false;

function AddTest({ onAdded, busy }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(null);
  const { data, isFetching } = useMachineCandidates(q);
  const add = useAddMachineTest();

  if (!open) {
    return (
      <button type="button" className="st-btn mroom__add-open" onClick={() => setOpen(true)}>
        + Add a test at the machine
      </button>
    );
  }

  return (
    <div className="mroom__add">
      <div className="mroom__add-head">
        <strong>Add a test</strong>
        <button
          type="button"
          className="rbtn"
          onClick={() => {
            setOpen(false);
            setPicked(null);
            setQ("");
          }}
        >
          Cancel
        </button>
      </div>
      {picked ? (
        <>
          <div className="dp-hint">
            {picked.name} · {picked.where} — which machine?
          </div>
          <div className="mroom__add-machines">
            {MACHINES.map((m) => (
              <button
                key={m.id}
                type="button"
                className="st-btn"
                disabled={busy || add.isPending}
                onClick={() =>
                  add.mutate(
                    { visitId: picked.visitId, machine: m.id },
                    {
                      onSuccess: (r) => {
                        onAdded(
                          r.alreadyThere
                            ? `${picked.name} already has a ${m.name} waiting`
                            : `✓ ${m.name} added for ${picked.name} — send them to reception to pay`,
                        );
                        setPicked(null);
                        setQ("");
                        setOpen(false);
                      },
                      onError: (e) =>
                        onAdded(e?.response?.data?.error || "Could not add that test"),
                    },
                  )
                }
              >
                {m.icon} {m.name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <input
            className="rail-search mroom__add-search"
            value={q}
            placeholder="Search the patient by name or file no…"
            aria-label="Find the patient"
            onChange={(e) => setQ(e.target.value)}
          />
          {q.trim().length >= 2 && (
            <div className="mroom__add-list">
              {isFetching && <div className="empty-note">Searching…</div>}
              {!isFetching && !(data?.rows || []).length && (
                <div className="empty-note">Nobody on the floor matches that.</div>
              )}
              {(data?.rows || []).map((c) => (
                <button
                  key={c.visitId}
                  type="button"
                  className="mroom__add-row"
                  onClick={() => setPicked(c)}
                >
                  <span className="mroom__add-name">{c.name}</span>
                  <span className="badge b-ink">{c.fileNo}</span>
                  <span className="mroom__add-where">{c.where}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function MachineStationPage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [machineFilter, setMachineFilter] = useState(null);
  const [openMachines, setOpenMachines] = useState({});
  const [group, setGroup] = useState("all");
  const [openId, setOpenId] = useState(null);
  const [viewingDoc, setViewingDoc] = useState(null);
  const [showRecon, setShowRecon] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useMachineQueue({ machine: machineFilter, group, q: debounced });
  const reconciliation = useMachineReconciliation();
  const live = useGiniflowLive({ date: data?.date });
  const advance = useAdvanceMachineTest();
  const upload = useUploadMachineReport();
  const busy = advance.isPending || upload.isPending;

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const rowsFor = (rung) => data?.[rung.bucket] || [];
  const allRows = MACHINE_RUNGS.flatMap((r) => rowsFor(r));
  const openOrder = allRows.find((o) => o.orderId === openId) || null;
  const machines = data?.machines || MACHINES.map((m) => ({ ...m, total: 0, waiting: 0 }));
  const counts = data?.counts || {};
  const unassigned = data?.unassigned || [];

  const onAdvance = (order, to) =>
    advance.mutate(
      { orderId: order.orderId, to },
      {
        onSuccess: (r) =>
          showToast(
            r.unchanged
              ? `${order.name} was already past that step`
              : to === "reported"
                ? `📤 ${order.name}'s report filed — the MO has been told`
                : `✓ ${order.name} — ${to.replace(/_/g, " ")}`,
          ),
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not update — nothing was changed"),
      },
    );

  const onUpload = (order, file) => {
    if (file.size > 10 * 1024 * 1024) return showToast("That file is larger than 10 MB");
    upload.mutate(
      { orderId: order.orderId, file },
      {
        onSuccess: () => showToast(`📤 ${order.name}'s report filed`),
        onError: (e) => showToast(e?.response?.data?.error || "Upload failed"),
      },
    );
  };

  return (
    <div className="gf mroom">
      <StationNotice station="machine" />
      <div className="rail">
        <div className="rl">Machine Room</div>
        <div className="rsep" />
        <span className="rail-title">
          ABI · VPT · Fundus · TMT · ECG ·{" "}
          {new Date().toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
          })}
        </span>
        <div className="rr">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name, file no, test…"
            aria-label="Search today's machine tests"
            onChange={(e) => setSearch(e.target.value)}
          />
          <LiveBadge live={live} className="tr-live" />
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          {/* One tile per machine: what is on it now, and how long the queue
              behind it will take. The only question this station can answer that
              nothing else on the floor can. */}
          <div className="mroom__machines">
            {machines.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mroom__machine${machineFilter === m.id ? " on" : ""}`}
                aria-pressed={machineFilter === m.id}
                onClick={() => setMachineFilter(machineFilter === m.id ? null : m.id)}
              >
                <span className="mroom__top">
                  <span className="mroom__icon" aria-hidden="true">
                    {m.icon}
                  </span>
                  <span className="mroom__mname">{m.name}</span>
                </span>
                <span className={`mroom__busy${m.onIt ? " is-busy" : ""}`}>
                  {m.onIt ? `▶ ${m.onIt.name}` : waitLabel(m)}
                </span>
                <span className="mroom__queue">
                  {m.total ? `${m.waiting} waiting · ${m.total} today` : "nothing today"}
                </span>
              </button>
            ))}
          </div>

          {/* Raising a test at the machine is built and tested, but off until the
              floor decides it wants it — a mistap here creates a real order and
              a real charge against a real patient. Flip to true to bring it
              back; nothing else has to change. */}
          {SHOW_ADD_TEST && <AddTest busy={busy} onAdded={showToast} />}

          {!isLoading && (
            <div className="sq-filters sq-filters--page" role="group" aria-label="Filter by stage">
              <button
                type="button"
                className={group === "all" ? "on" : ""}
                aria-pressed={group === "all"}
                onClick={() => setGroup("all")}
              >
                All<span className="sq-fcount">{data?.total ?? 0}</span>
              </button>
              {MACHINE_RUNGS.filter((r) => counts[r.filter] || group === r.filter).map((r) => (
                <button
                  key={r.filter}
                  type="button"
                  className={group === r.filter ? "on" : ""}
                  aria-pressed={group === r.filter}
                  onClick={() => setGroup(group === r.filter ? "all" : r.filter)}
                >
                  {r.filterLabel}
                  <span className="sq-fcount">{counts[r.filter] ?? 0}</span>
                </button>
              ))}
            </div>
          )}

          {isLoading && <div className="empty-note">Loading…</div>}

          {/* Grouped by MACHINE, not by stage — the machine is the category
              here, and the whole premise of this station is that each one is its
              own queue. Inside a machine the tests read in ladder order, so the
              technician sees who is on it, then who is next, then what is still
              waiting on a report. Collapsible like every other station's
              sections, and a machine with nothing today folds away. */}
          {!isLoading &&
            machines
              .filter((m) => m.total > 0 || machineFilter === m.id)
              .map((m) => {
                const mine = allRows.filter((o) => o.machine === m.id);
                const open = openMachines[m.id] ?? true;
                return (
                  <div key={m.id} className="mroom__stage">
                    <h2 className="sq-gh">
                      <button
                        type="button"
                        className="sq-toggle"
                        aria-expanded={open}
                        aria-controls={`machine-${m.id}`}
                        onClick={() => setOpenMachines((v) => ({ ...v, [m.id]: !open }))}
                      >
                        <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
                          ▸
                        </span>
                        {m.icon} {m.name}
                        <span className="sq-count">
                          {m.onIt ? `▶ ${m.onIt.name}` : waitLabel(m)} · {mine.length} today
                        </span>
                      </button>
                    </h2>
                    <div id={`machine-${m.id}`} hidden={!open}>
                      {!mine.length && <div className="empty-note">Nothing on this machine.</div>}
                      {MACHINE_RUNGS.map((rung) => {
                        const rows = mine.filter((o) => o.stage === rung.key);
                        if (!rows.length) return null;
                        return (
                          <div key={rung.key} className="mroom__sub">
                            <div className="grp-lbl grp-sub">
                              {rung.sectionLabel}
                              <span className="grp-split">{rows.length}</span>
                            </div>
                            <div className="mroom__list">
                              {rows.map((o) => (
                                <TestCard
                                  key={o.orderId}
                                  order={o}
                                  busy={busy}
                                  onAdvance={onAdvance}
                                  onOpen={(x) => setOpenId(x.orderId)}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

          {!isLoading && !allRows.length && !unassigned.length && (
            <div className="empty-note">
              No machine tests ordered today. A test reaches this screen when it is ordered as a
              machine test — an admin sets that beside its price in the test catalogue.
            </div>
          )}

          {unassigned.length > 0 && (
            <div className="mroom__stage">
              <h2 className="sq-gh">
                ❓ Not matched to a machine<span className="sq-count">{unassigned.length}</span>
              </h2>
              <div className="grp-hint">
                Ordered as machine tests, but the test name matches none of the five machines.
              </div>
              <div className="mroom__list">
                {unassigned.map((o) => (
                  <TestCard
                    key={o.orderId}
                    order={o}
                    busy={busy}
                    onAdvance={onAdvance}
                    onOpen={(x) => setOpenId(x.orderId)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* The tests that happened without ever touching this screen. Honest
              about the gap rather than pretending the queue is the whole story. */}
          {/* A RECORD of the day, not work to do — collapsed by default and
              last on the page, because every row is a test that already
              happened and almost always a patient who has already left. */}
          {(reconciliation.data?.rows || []).length > 0 && (
            <div className="mroom__stage mroom__recon">
              <h2 className="sq-gh">
                <button
                  type="button"
                  className="sq-toggle"
                  aria-expanded={showRecon}
                  aria-controls="machine-recon"
                  onClick={() => setShowRecon((v) => !v)}
                >
                  <span className={`sq-chev${showRecon ? " open" : ""}`} aria-hidden="true">
                    ▸
                  </span>
                  📥 Ran today without an order
                  <span className="sq-count">{reconciliation.data.rows.length}</span>
                </button>
              </h2>
              <div id="machine-recon" hidden={!showRecon}>
                <div className="grp-hint">
                  Reports that arrived from the hospital sync for patients with no test ordered
                  here. Nothing to do with them — the report is already on the chart, and nobody can
                  say afterwards who ran the test or when. Kept as the day&apos;s record.
                </div>
                <div className="mroom__recon-list">
                  {reconciliation.data.rows.map((r) => (
                    <div key={r.docId} className="mroom__recon-row">
                      <span className="badge b-ink">
                        {machineFor(r.machine)?.icon} {machineFor(r.machine)?.name || r.docType}
                      </span>
                      <span className="mroom__recon-name">{r.name}</span>
                      <span className={`mroom__recon-where${r.gone ? " is-gone" : ""}`}>
                        {r.where}
                      </span>
                      <span className="mroom__recon-at">{clock(r.at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}

      <TestPane
        order={openOrder}
        busy={busy}
        onClose={() => setOpenId(null)}
        onAdvance={onAdvance}
        onUpload={onUpload}
        onView={(o) =>
          setViewingDoc({ id: o.reportDocId, title: "Machine test report", doc_type: "lab_report" })
        }
      />

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
