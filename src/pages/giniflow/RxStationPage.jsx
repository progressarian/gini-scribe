import { useEffect, useState } from "react";
import {
  useRxQueue,
  useRxPatient,
  useStartRxExplain,
  useMarkRxExplained,
  useReturnRxToQueue,
  printRxHref,
  useReissueRx,
} from "../../queries/hooks/useGiniflowRx";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import StationNotice from "../../components/giniflow/StationNotice";
import PdfViewerModal from "../../components/visit/PdfViewerModal";
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

const toneClass = (colour) =>
  colour === "red" ? "si-tmr-r" : colour === "amber" ? "si-tmr-a" : "si-tmr-g";

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
  onClose,
  onReturn,
  onExplained,
  onView,
  onReissue,
  reissuing,
  returning,
  busy,
}) {
  const { data, isLoading } = useRxPatient(visitId);
  if (!visitId) return null;

  return (
    <div className="detail-overlay">
      <div className="detail-pane" role="dialog" aria-label="Explain the prescription">
        <div className="dp-head">
          <div className="dp-name">{data?.name || "…"}</div>
          <div className="dp-meta">
            {data ? `${data.age}${(data.sex || "")[0] || ""} · ${data.fileNo || "—"}` : ""}
            {data?.doctorName ? ` · ${data.doctorName}` : ""}
          </div>
          {data?.rxFromHealthray && (
            <div className="dp-hint">
              Written in HealthRay, not here — the copy below is the doctor's own document. It
              cannot be re-issued from this station.
            </div>
          )}
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
            {data?.status === "with_rx" && (
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
              <button
                className="st-btn st-btn-grn"
                onClick={() => onView(visitId, data.name, data.rxFromHealthray)}
              >
                {data.rxFromHealthray
                  ? "🖨 View / print HealthRay Rx"
                  : "🖨 View / print prescription"}
              </button>
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

        <div className="dp-foot">
          <button
            className="st-btn st-btn-grn"
            disabled={busy || data?.status === "pharmacy_pending"}
            onClick={() => onExplained(visitId)}
          >
            ✓ Explained — send to pharmacy
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RxStationPage() {
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState("");
  const [viewing, setViewing] = useState(null);
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

  const pick = (visitId) => {
    setOpenId(visitId);
    if (!atDesk.some((r) => r.visitId === visitId)) start.mutate({ visitId });
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

          {!isLoading && !atDesk.length && !waiting.length && !done.length && (
            <div className="empty-note">
              {debounced.trim()
                ? `Nobody matches “${debounced.trim()}”.`
                : "Nobody here yet. A patient appears the moment the consultant finalises their prescription."}
            </div>
          )}

          <div className="ar-split">
            <div className="ar-col">
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
                ✅ Explained today<span className="grp-split">{done.length}</span>
              </div>
              <div className="grp-hint">Already sent on to the pharmacy.</div>
              {!done.length && <div className="empty-note">Nobody yet.</div>}
              {done.map((r) => (
                <div className="sq-done" key={r.visitId}>
                  <div className="pc-av" style={{ background: avatarColour(r.patientId) }}>
                    {initials(r.name)}
                  </div>
                  <div className="si-name">{r.name}</div>
                  <div className="si-meta">
                    {r.fileNo || "—"} · {r.statusLabel}
                    {r.rxFromHealthray && <span className="badge b-ink"> HealthRay Rx</span>}
                  </div>
                  {r.canPrint && (
                    <button
                      className="st-btn"
                      onClick={() => setViewing({ ...r, fromHealthray: r.rxFromHealthray })}
                    >
                      🖨 View
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Pane
        visitId={openId}
        onClose={() => setOpenId(null)}
        onReturn={onReturn}
        onExplained={onExplained}
        onView={(visitId, name, fromHealthray) => setViewing({ visitId, name, fromHealthray })}
        onReissue={onReissue}
        reissuing={reissue.isPending}
        returning={returnToQueue.isPending}
        busy={explained.isPending}
      />

      {viewing && (
        <PdfViewerModal
          src={{
            url: printRxHref(viewing.visitId),
            mimeType: "application/pdf",
            fileName: `Prescription — ${viewing.name || "patient"}`,
            title: `${viewing.fromHealthray ? "HealthRay prescription" : "Prescription"} — ${
              viewing.name || "patient"
            }`,
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
