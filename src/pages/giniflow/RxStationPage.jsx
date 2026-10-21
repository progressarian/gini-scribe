import { useEffect, useRef, useState } from "react";
import {
  useRxQueue,
  useHandOverEchoReport,
  useRxPatient,
  useStartRxExplain,
  useMarkRxExplained,
  useReturnRxToQueue,
  medicineCardHref,
  printRxHref,
  useReissueRx,
  useEndVisit,
} from "../../queries/hooks/useGiniflowRx";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions.js";
import LiveBadge from "../../components/giniflow/LiveBadge";
import StationNotice from "../../components/giniflow/StationNotice";
import PdfViewerModal, { printPdf } from "../../components/visit/PdfViewerModal";
import RxFollowupDialog from "../../components/giniflow/RxFollowupDialog";
import {
  RX_FOLLOWUP_LABEL,
  RX_FOLLOWUP_RESOLVES,
  RX_NOT_TAKEN_REASON_LABEL,
} from "../../../shared/rxFollowups.js";
import { isValidMobile, toLocal10 } from "../../../shared/phone.js";
import "../../styles/giniflow-station.css";

const AVATAR_COLOURS = ["#374151", "#1e3a5f", "#14532d", "#7c2d12", "#7f1d1d", "#b45309"];

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

const avatarColour = (id) => AVATAR_COLOURS[Math.abs(id ?? 0) % AVATAR_COLOURS.length];

const RESOLVE_ACTIONS = [...RX_FOLLOWUP_RESOLVES, "note"];

const DOCUMENT_TIMEOUT_MS = 60000;

const shiftDay = (day, by) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + by);
  return d.toLocaleDateString("en-CA");
};

const visitLabel = (visitDate, today) => {
  if (!visitDate) return "";
  if (visitDate === today) return "Today";
  if (today && visitDate === shiftDay(today, -1)) return "Yesterday";
  return new Date(`${visitDate}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
};

const clock = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

const whatsappHref = (phone, name) => {
  const local = toLocal10(phone);
  if (!isValidMobile(local)) return null;
  const text = encodeURIComponent(
    `Namaste ${name || ""}, this is Gini Advanced Care Hospital. Sharing your prescription from your visit.`,
  );
  return `https://wa.me/91${local}?text=${text}`;
};

function ExplainedBadge({ explained, online }) {
  if (!explained && online) return <span className="badge b-ink">📱 Online visit</span>;
  return explained ? (
    <span className="badge b-grn">✓ Explained</span>
  ) : (
    <span className="badge b-amb">⚠ Not explained</span>
  );
}

const toneClass = (colour) =>
  colour === "red" ? "si-tmr-r" : colour === "amber" ? "si-tmr-a" : "si-tmr-g";

function CoordinatorBadge({ hold }) {
  if (!hold?.waiting) return null;
  return (
    <span className="badge b-amb">
      🤝 With Care Coordinator{hold.minutes != null ? ` · ${hold.minutes}m` : ""}
    </span>
  );
}

function QueueRow({ row, active, onPick }) {
  return (
    <button
      type="button"
      className={`sq-item${active ? " active" : ""}`}
      onClick={() => onPick(row.visitId)}
    >
      <div className="si-name">{row.name}</div>
      <div className="si-meta">
        {row.age}
        {(row.sex || "")[0] || ""} · {row.fileNo || "—"} · {row.medicineCount} medicine
        {row.medicineCount === 1 ? "" : "s"}
        {row.doctorName ? ` · ${row.doctorName}` : ""}
        {row.rxFromHealthray && <span className="badge b-ink"> HealthRay Rx</span>}
      </div>
      <div className="si-wait">
        <span className={`si-tmr ${toneClass(row.colour)}`}>⏱ {row.minutes ?? 0}m</span>
        <span className="si-since">{row.statusLabel}</span>
      </div>
      {row.coordinator?.waiting && (
        <div className="rxq-row__tags">
          <CoordinatorBadge hold={row.coordinator} />
        </div>
      )}
      {!row.canPrint && (
        <div className="grp-hint">
          {row.rxStale
            ? "Prescription changed since the copy was made — open them and re-issue it"
            : "Prescription still being prepared"}
        </div>
      )}
    </button>
  );
}

function MedicineGroup({ group }) {
  return (
    <div className="hr-case-block">
      <div className="hr-case-top">
        <span className="badge b-ink">{group.label || group.key}</span>
        <span className="sp sp-process">{group.medicines.length}</span>
      </div>
      {group.medicines.map((m) => (
        <div className="test-row" key={m.medicationId || m.name}>
          <div className="tr-name">
            {m.name}
            {m.external && <span className="badge b-ink"> Ext</span>}
            <div className="pc-meta">
              {[m.dose, m.frequency, (m.whenToTake || []).join(", ")].filter(Boolean).join(" · ")}
            </div>
          </div>
          {m.changeType && (
            <div className="tr-status">
              <span className="badge b-ink">{m.changeType}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Pane({
  visitId,
  readOnly,
  canEndVisit,
  onEndVisit,
  onClose,
  onReturn,
  onExplained,
  onView,
  onPrint,
  printing,
  onReissue,
  onFollowup,
  listed,
  today,
  reissuing,
  returning,
  busy,
}) {
  const { data, isLoading } = useRxPatient(visitId);
  const followupPatient = data && {
    visitId,
    name: data.name,
    fileNo: data.fileNo,
    phone: data.phone,
    doctorName: data.doctorName,
    visitLabel: visitLabel(data.visitDate, today),
  };
  const wa = data && whatsappHref(data.phone, data.name);
  if (!visitId) return null;

  return (
    <div className="detail-overlay">
      <div className="detail-pane" role="dialog" aria-label="Explain the prescription">
        <div className="dp-head">
          <div className="dp-title-row">
            <button type="button" className="rbtn" onClick={onClose}>
              ← Back
            </button>
            <div className="dp-name">{data?.name || "…"}</div>
          </div>
          <div className="dp-meta">
            {data ? `${data.age}${(data.sex || "")[0] || ""} · ${data.fileNo || "—"}` : ""}
            {data?.doctorName ? ` · ${data.doctorName}` : ""}
            {readOnly && data && (
              <>
                {" "}
                <ExplainedBadge explained={data.explained} online={data.online} />
              </>
            )}
          </div>
          {data?.coordinator?.waiting && (
            <div className="dp-hint" role="status">
              <CoordinatorBadge hold={data.coordinator} />{" "}
              {data.coordinator.blocking
                ? "Referred — the Care Coordinator sees them first. Explain the prescription once the coordinator sends them on."
                : "Referred — send the patient to the Care Coordinator as well."}
            </div>
          )}
          {data?.rxFromHealthray && (
            <div className="dp-hint">
              Written in HealthRay, not here — the copy below is the doctor's own document. It
              cannot be re-issued from this station.
            </div>
          )}
          <div className="dp-acts dp-acts--row">
            {!readOnly && data?.status === "with_rx" && (
              <button
                className="rbtn"
                disabled={returning}
                title="Opening a patient puts them at the desk — this puts them back in the queue"
                onClick={() => onReturn(visitId)}
              >
                {returning ? "↩ Returning…" : "↩ Not this patient"}
              </button>
            )}
            {data?.canPrint ? (
              <>
                <button
                  className="st-btn"
                  onClick={() => onView(visitId, data.name, data.rxFromHealthray)}
                >
                  {data.rxFromHealthray ? "View HealthRay Rx" : "View prescription"}
                </button>
                <button
                  className="st-btn st-btn-grn"
                  disabled={!!printing}
                  onClick={() => onPrint(visitId, data.name, "rx")}
                >
                  {printing === `${visitId}:rx`
                    ? "🖨 Preparing…"
                    : data.rxFromHealthray
                      ? "🖨 Print HealthRay Rx"
                      : "🖨 Print prescription"}
                </button>
              </>
            ) : (
              /* No printable copy is two situations and only one of them had a
                 way out. A stale copy offered "re-issue"; a missing one read
                 "🖨 Preparing…", disabled, with nothing the desk could do but
                 wait for a file that in some cases never arrives. Both are the
                 same fix — build it from the consultation — so both offer it. */
              <button
                className="st-btn"
                disabled={!data || reissuing}
                title={
                  data?.rxStale
                    ? "The prescription changed after this copy was made — re-issue it"
                    : "No printable copy yet — build one from the consultation"
                }
                onClick={() => onReissue(visitId)}
              >
                {reissuing
                  ? "↻ Working…"
                  : data?.rxStale
                    ? "↻ Re-issue prescription"
                    : "🖨 Generate prescription"}
              </button>
            )}
            {data && (
              <>
                <button
                  className="st-btn"
                  disabled={!data.card?.counts?.total}
                  title={
                    data.card?.counts?.total
                      ? "The patient's medicines by time of day, to take home with the prescription"
                      : "No medicines on the card"
                  }
                  onClick={() => onView(visitId, data.name, false, "card")}
                >
                  View medicine card
                </button>
                <button
                  className="st-btn"
                  disabled={!data.card?.counts?.total || !!printing}
                  title={data.card?.counts?.total ? undefined : "No medicines on the card"}
                  onClick={() => onPrint(visitId, data.name, "card")}
                >
                  {printing === `${visitId}:card` ? "🖨 Preparing…" : "🖨 Print medicine card"}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner">
            {isLoading && <div className="empty-note">Loading…</div>}

            {data?.counselling?.hasChanges && (
              <div className="dp-sec">
                <div className="dp-sec-title">Read this to the patient</div>
                <p className="dp-hint">{data.counselling.hindi}</p>
                <p className="dp-hint">{data.counselling.english}</p>
              </div>
            )}

            {data?.card?.groups?.length > 0 && (
              <div className="dp-sec">
                <div className="dp-sec-title">Medicine card</div>
                <div className="dp-hint">
                  The full card, including medicines from outside Gini — the patient takes those
                  too.
                </div>
                {data.card.groups.map((g) => (
                  <MedicineGroup group={g} key={g.key || g.label} />
                ))}
              </div>
            )}

            {data?.stopped?.length > 0 && (
              <div className="dp-sec">
                <div className="dp-sec-title">Stopped today</div>
                {data.stopped.map((m) => (
                  <div className="test-row" key={m.medicationId || m.name}>
                    <div className="tr-name">{m.name}</div>
                  </div>
                ))}
              </div>
            )}

            {data?.followups?.length > 0 && (
              <div className="dp-sec">
                <div className="dp-sec-title">Prescription follow-up</div>
                {data.followups.map((f) => (
                  <div className="test-row" key={f.id}>
                    <div className="tr-name">
                      {RX_FOLLOWUP_LABEL[f.action] || f.action}
                      <div className="pc-meta">{f.remark}</div>
                    </div>
                    <div className="tr-status">
                      <span className="pc-meta">
                        {f.by || "—"} · {clock(f.at)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="dp-sec">
              <div className="dp-sec-title">What this station can and cannot do</div>
              <div className="dp-hint">
                Explaining only. The prescription cannot be edited here — a correction goes back to
                the consultant as an addendum — and medicines are handed over at the pharmacy, not
                here.
              </div>
            </div>
          </div>
        </div>

        {readOnly && data && (
          <div className="dp-foot">
            {wa && (
              <a className="st-btn" href={wa} target="_blank" rel="noopener noreferrer">
                📱 Open WhatsApp
              </a>
            )}
            {listed ? (
              <button
                type="button"
                className="st-btn st-btn-grn"
                onClick={() => onFollowup(followupPatient, RESOLVE_ACTIONS)}
              >
                ✓ Mark done / remark
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="st-btn"
                  onClick={() => onFollowup(followupPatient, ["not_taken"])}
                  title="The patient left without the prescription — keep them in Prescription not given"
                >
                  ⚠ Not taken
                </button>
                <button
                  type="button"
                  className="st-btn"
                  onClick={() => onFollowup(followupPatient, ["note"])}
                >
                  Add remark
                </button>
              </>
            )}
          </div>
        )}

        {!readOnly && (
          <div className="dp-foot">
            <button
              className="st-btn st-btn-grn"
              disabled={busy || data?.status === "pharmacy_pending"}
              onClick={() => onExplained(visitId)}
            >
              ✓ Explained — send to pharmacy
            </button>
            {/* Most patients never reach a dispense: they take the prescription
              from the counter and go, buying medicines elsewhere or having none
              to collect. HealthRay's checkout used to close those; the counter
              says it now (38-MANUAL-FLOOR-PLAN.md). */}
            {canEndVisit && (
              <button
                className="st-btn"
                disabled={busy}
                onClick={() => onEndVisit(visitId, data?.name)}
                title="The patient has taken the prescription and gone"
              >
                🚪 Explained — patient leaving
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RxStationPage() {
  const [openId, setOpenId] = useState(null);
  const [openReadOnly, setOpenReadOnly] = useState(false);
  const [printing, setPrinting] = useState(null);
  const printFrame = useRef(null);
  const printUrl = useRef(null);
  useEffect(
    () => () => {
      printFrame.current?.remove();
      if (printUrl.current) URL.revokeObjectURL(printUrl.current);
    },
    [],
  );
  const [toast, setToast] = useState("");
  const [viewing, setViewing] = useState(null);
  const [followup, setFollowup] = useState(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useRxQueue(undefined, debounced);
  const live = useGiniflowLive();
  const start = useStartRxExplain();
  const explained = useMarkRxExplained();
  const returnToQueue = useReturnRxToQueue();
  const reissue = useReissueRx();
  const handOver = useHandOverEchoReport();

  const onReissue = (visitId) =>
    reissue.mutate(
      { visitId },
      {
        onSuccess: () => setToast("✓ Prescription ready — it is current now"),
        onError: (e) => setToast(e?.response?.data?.error || "Could not build the prescription"),
      },
    );

  const atDesk = data?.atDesk || [];
  const waiting = data?.waiting || [];
  const done = data?.explained || [];
  const handovers = data?.echoHandovers || [];
  const notTaken = data?.notTaken || [];
  const today = data?.date;
  const followupFor = (r) => ({
    visitId: r.visitId,
    name: r.name,
    fileNo: r.fileNo,
    phone: r.phone,
    doctorName: r.doctorName,
    visitLabel: visitLabel(r.visitDate, today),
  });

  const onHandOver = (row) =>
    handOver.mutate(
      { visitId: row.visitId },
      {
        onSuccess: () => {
          setToast(
            `✓ Echo report handed over — ${row.name} goes to vitals, then ${row.doctorName || "their doctor"}`,
          );
          setTimeout(() => setToast(""), 3500);
        },
        onError: (e) => setToast(e?.response?.data?.error || "Could not hand over the report"),
      },
    );

  const fetchDocument = async (visitId, kind, verb) => {
    const what = kind === "card" ? "medicine card" : "prescription";
    try {
      const res = await fetch(kind === "card" ? medicineCardHref(visitId) : printRxHref(visitId), {
        signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setToast(body.error || `Could not ${verb} the ${what}`);
        return null;
      }
      return await res.blob();
    } catch (e) {
      setToast(
        e?.name === "TimeoutError"
          ? `The ${what} is taking too long — try again`
          : `Could not reach the server to ${verb} the ${what} — try again`,
      );
      return null;
    }
  };

  const onPrint = async (visitId, name, kind) => {
    if (printing) return;
    const label = `${kind === "card" ? "Medicine card" : "Prescription"} — ${name || "patient"}`;
    setPrinting(`${visitId}:${kind}`);
    try {
      const blob = await fetchDocument(visitId, kind, "print");
      if (!blob) return;
      if (printUrl.current) URL.revokeObjectURL(printUrl.current);
      printUrl.current = URL.createObjectURL(blob);
      printFrame.current = printPdf(printUrl.current, label, printFrame.current);
    } finally {
      setPrinting(null);
    }
  };

  const onDownload = async (visitId, name) => {
    if (printing) return;
    setPrinting(`${visitId}:download`);
    try {
      const blob = await fetchDocument(visitId, "rx", "download");
      if (!blob) return;
      const extension = blob.type.startsWith("image/") ? blob.type.split("/")[1] : "pdf";
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `Prescription — ${name || "patient"}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } finally {
      setPrinting(null);
    }
  };

  const openExplained = (visitId) => {
    setOpenReadOnly(true);
    setOpenId(visitId);
  };

  const pick = (visitId) => {
    const held = waiting.find((r) => r.visitId === visitId)?.coordinator?.blocking;
    setOpenReadOnly(!!held);
    setOpenId(visitId);
    if (held) return;
    if (!atDesk.some((r) => r.visitId === visitId)) {
      start.mutate(
        { visitId },
        {
          onError: (e) => {
            setOpenReadOnly(true);
            setToast(e?.response?.data?.error || "Could not call this patient to the desk");
          },
        },
      );
    }
  };

  const onReturn = (visitId) =>
    returnToQueue.mutate(
      { visitId },
      {
        onSuccess: () => {
          setOpenId(null);
          setToast("↩ Put back in the queue — nothing was recorded");
          setTimeout(() => setToast(""), 3500);
        },
        onError: (e) => setToast(e?.response?.data?.error || "Could not return them to the queue"),
      },
    );

  // The counter ends the visit; a station that cannot see the patient leave
  // cannot honestly say they have.
  const canEndVisit = hasCapability(
    useAuthStore((st) => st.currentDoctor),
    CAP.GINIFLOW_END_VISIT,
  );
  const endVisit = useEndVisit("rx");
  const onEndVisit = (visitId, name) =>
    endVisit.mutate(
      { visitId },
      {
        onSuccess: (r) =>
          setToast(
            r.unchanged
              ? `${name || "That patient"}'s visit was already closed`
              : `🚪 ${name || "Patient"} — visit closed`,
          ),
        onError: (e) => setToast(e?.response?.data?.error || "Could not close that visit"),
      },
    );

  const onExplained = (visitId) => {
    explained.mutate(
      { visitId },
      {
        onSuccess: () => {
          setOpenId(null);
          setToast("✓ Explained — the patient is on their way to the pharmacy");
          setTimeout(() => setToast(""), 3500);
        },
        onError: (e) => setToast(e?.response?.data?.error || "Could not record that"),
      },
    );
  };

  return (
    <div className="gf">
      <StationNotice station="rx" />
      <div className="rail">
        <div className="rl">Prescription Explain</div>
        <div className="rsep" />
        <span className="rail-title">Prescription explained to the patient</span>
        <div className="rr">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name, file no, doctor, medicine…"
            aria-label="Search today's Prescription Explain queue"
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
          <div className="workflow-note lab-note">
            <span className="wn-ico">⚡</span>
            <span>
              <strong>Workflow:</strong> the consultant finalises → the patient arrives here → you
              explain the medicines and hand them the printed prescription → they go to the pharmacy
              to collect.
            </span>
          </div>

          {isLoading && <div className="empty-note">Loading…</div>}

          {!isLoading && !atDesk.length && !waiting.length && !done.length && !notTaken.length && (
            <div className="empty-note">
              {debounced.trim()
                ? `Nobody matches “${debounced.trim()}”.`
                : "Nobody here yet. A patient appears the moment the consultant finalises their prescription."}
            </div>
          )}

          <div className="ar-split ar-split--three">
            <div className="ar-col">
              {handovers.length > 0 && (
                <>
                  <div className="grp-lbl grp-lbl-sp">
                    🫀 Echo reports to hand over
                    <span className="grp-split">{handovers.length}</span>
                  </div>
                  <div className="grp-hint">
                    Referred only for an echo — give them the report, then send them to vitals and
                    their doctor.
                  </div>
                  {handovers.map((r) => (
                    <div className="rxq-row" key={r.visitId}>
                      <div className="rxq-row__body">
                        <div className="si-name">{r.name}</div>
                        <div className="si-meta">
                          {r.fileNo || "—"} · {r.echoTests.join(", ") || "Echo"} · then{" "}
                          {r.doctorName || "their doctor"}
                        </div>
                      </div>
                      <div className="rxq-row__acts">
                        <button
                          type="button"
                          className={`st-btn ${r.reportReady ? "st-btn-grn" : "st-btn-g"}`}
                          disabled={!r.reportReady || handOver.isPending}
                          aria-label={`Hand over the echo report to ${r.name}`}
                          onClick={() => onHandOver(r)}
                        >
                          {r.reportReady ? "Hand over report" : "Waiting for echo report"}
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}

              <div className="grp-lbl grp-lbl-sp">
                🟢 At the desk<span className="grp-split">{atDesk.length}</span>
              </div>
              {!atDesk.length && <div className="empty-note">Nobody at the desk.</div>}
              {atDesk.map((r) => (
                <QueueRow key={r.visitId} row={r} active={r.visitId === openId} onPick={pick} />
              ))}

              <div className="grp-lbl grp-sub">
                ⏳ Waiting<span className="grp-split">{waiting.length}</span>
              </div>
              <div className="grp-hint">Longest wait first — call them in.</div>
              {!waiting.length && <div className="empty-note">Nobody waiting.</div>}
              {waiting.map((r) => (
                <QueueRow key={r.visitId} row={r} active={r.visitId === openId} onPick={pick} />
              ))}
            </div>

            <div className="ar-col">
              <div className="grp-lbl grp-lbl-sp">
                📱 Prescription not given<span className="grp-split">{notTaken.length}</span>
              </div>
              <div className="grp-hint">
                Left without their prescription. Send it on WhatsApp, then mark done — they stay
                here until someone does.
              </div>
              {!notTaken.length && <div className="empty-note">Nothing to send.</div>}
              {notTaken.map((r) => {
                const wa = whatsappHref(r.phone, r.name);
                return (
                  <div className="rxq-row rxq-row--stack" key={r.visitId}>
                    <div className="pc-av" style={{ background: avatarColour(r.patientId) }}>
                      {initials(r.name)}
                    </div>
                    <div className="rxq-row__body">
                      <div className="si-name">{r.name}</div>
                      <div className="si-meta">
                        {r.fileNo || "—"} · {visitLabel(r.visitDate, today)}
                        {r.doctorName ? ` · ${r.doctorName}` : ""}
                        {r.phone ? ` · ${r.phone}` : " · no phone"}
                      </div>
                      <div className="rxq-row__tags">
                        <span className="badge b-amb">⚠ {RX_NOT_TAKEN_REASON_LABEL[r.reason]}</span>
                      </div>
                      {r.lastFollowup && (
                        <div className="rx-fu-last">
                          {RX_FOLLOWUP_LABEL[r.lastFollowup.action]}: {r.lastFollowup.remark} —{" "}
                          {r.lastFollowup.by || "—"}, {clock(r.lastFollowup.at)}
                        </div>
                      )}
                    </div>
                    <div className="rxq-row__acts">
                      <button
                        type="button"
                        className="st-btn"
                        aria-label={`Open ${r.name}'s prescription and medicine card`}
                        onClick={() => openExplained(r.visitId)}
                      >
                        Open
                      </button>
                      {r.canPrint && (
                        <>
                          <button
                            type="button"
                            className="st-btn"
                            aria-label={`Print ${r.name}'s prescription`}
                            disabled={!!printing}
                            onClick={() => onPrint(r.visitId, r.name, "rx")}
                          >
                            {printing === `${r.visitId}:rx` ? "🖨 Preparing…" : "🖨 Print"}
                          </button>
                          <button
                            type="button"
                            className="st-btn"
                            aria-label={`Download ${r.name}'s prescription`}
                            disabled={!!printing}
                            onClick={() => onDownload(r.visitId, r.name)}
                          >
                            {printing === `${r.visitId}:download` ? "⬇ Preparing…" : "⬇ Download"}
                          </button>
                        </>
                      )}
                      {wa && (
                        <a
                          className="st-btn"
                          href={wa}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open WhatsApp chat with ${r.name}`}
                        >
                          📱 WhatsApp
                        </a>
                      )}
                      <button
                        type="button"
                        className="st-btn st-btn-grn"
                        aria-label={`Mark ${r.name}'s prescription done or add a remark`}
                        onClick={() =>
                          setFollowup({ patient: followupFor(r), actions: RESOLVE_ACTIONS })
                        }
                      >
                        ✓ Mark done
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="ar-col">
              <div className="grp-lbl grp-lbl-sp">
                ✅ Done today<span className="grp-split">{done.length}</span>
              </div>
              <div className="grp-hint">
                Passed the desk or left. ⚠ Not explained ones move to Prescription not given once
                they leave.
              </div>
              {!done.length && <div className="empty-note">Nobody yet.</div>}
              {done.map((r) => (
                <div className="rxq-row" key={r.visitId}>
                  <div className="pc-av" style={{ background: avatarColour(r.patientId) }}>
                    {initials(r.name)}
                  </div>
                  <div className="rxq-row__body">
                    <div className="si-name">{r.name}</div>
                    <div className="si-meta">
                      {r.fileNo || "—"} · {r.statusLabel}
                    </div>
                    <div className="rxq-row__tags">
                      <ExplainedBadge explained={r.explained} online={r.online} />
                      {r.rxFromHealthray && <span className="badge b-ink">HealthRay Rx</span>}
                    </div>
                  </div>
                  <div className="rxq-row__acts">
                    <button
                      type="button"
                      className="st-btn"
                      aria-label={`Open ${r.name}'s prescription and medicine card`}
                      onClick={() => openExplained(r.visitId)}
                    >
                      Open
                    </button>
                    {r.canPrint && (
                      <button
                        type="button"
                        className="st-btn"
                        aria-label={`Print ${r.name}'s prescription`}
                        disabled={!!printing}
                        onClick={() => onPrint(r.visitId, r.name, "rx")}
                      >
                        {printing === `${r.visitId}:rx` ? "🖨 Preparing…" : "🖨 Print"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Pane
        visitId={openId}
        readOnly={openReadOnly}
        onClose={() => setOpenId(null)}
        onReturn={onReturn}
        onExplained={onExplained}
        canEndVisit={canEndVisit}
        onEndVisit={onEndVisit}
        onView={(visitId, name, fromHealthray, kind = "rx") =>
          setViewing({ visitId, name, fromHealthray, kind })
        }
        onPrint={onPrint}
        printing={printing}
        onFollowup={(patient, actions) => setFollowup({ patient, actions })}
        today={today}
        listed={notTaken.some((r) => r.visitId === openId)}
        onReissue={onReissue}
        reissuing={reissue.isPending}
        returning={returnToQueue.isPending}
        busy={explained.isPending}
      />

      {viewing && (
        <PdfViewerModal
          src={
            viewing.kind === "card"
              ? {
                  url: medicineCardHref(viewing.visitId),
                  mimeType: "application/pdf",
                  fileName: `Medicine card — ${viewing.name || "patient"}`,
                  title: `Medicine card — ${viewing.name || "patient"}`,
                }
              : {
                  url: printRxHref(viewing.visitId),
                  mimeType: "application/pdf",
                  fileName: `Prescription — ${viewing.name || "patient"}`,
                  title: `${viewing.fromHealthray ? "HealthRay prescription" : "Prescription"} — ${
                    viewing.name || "patient"
                  }`,
                }
          }
          printable
          onClose={() => setViewing(null)}
        />
      )}

      {followup && (
        <RxFollowupDialog
          patient={followup.patient}
          actions={followup.actions}
          onClose={() => setFollowup(null)}
          onDone={(message) => {
            setFollowup(null);
            setToast(`✓ ${message}`);
            setTimeout(() => setToast(""), 3500);
          }}
        />
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
