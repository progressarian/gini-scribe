import { useEffect, useState } from "react";
import {
  useRxQueue,
  useRxPatient,
  useStartRxExplain,
  useMarkRxExplained,
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
      </div>
      <div className="si-wait">
        <span className={`si-tmr ${toneClass(row.colour)}`}>⏱ {row.minutes ?? 0}m</span>
        <span className="si-since">{row.statusLabel}</span>
      </div>
      {!row.canPrint && (
        <div className="grp-hint">
          {row.rxStale
            ? "Prescription changed since the copy was made — ask the consultant to re-issue"
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

function Pane({ visitId, onClose, onExplained, onView, onReissue, reissuing, busy }) {
  const { data, isLoading } = useRxPatient(visitId);
  if (!visitId) return null;

  return (
    <div className="detail-pane" role="dialog" aria-label="Explain the prescription">
      <div className="dp-head">
        <div className="dp-name">{data?.name || "…"}</div>
        <div className="dp-meta">
          {data ? `${data.age}${(data.sex || "")[0] || ""} · ${data.fileNo || "—"}` : ""}
          {data?.doctorName ? ` · ${data.doctorName}` : ""}
        </div>
        <div className="dp-acts">
          <button className="rbtn" onClick={onClose}>
            ← Back
          </button>
          {data?.canPrint ? (
            <button className="st-btn st-btn-grn" onClick={() => onView(visitId, data.name)}>
              🖨 View / print prescription
            </button>
          ) : (
            <button
              className="st-btn"
              disabled={!data?.rxStale || reissuing}
              title={
                data?.rxStale
                  ? "The prescription changed after this copy was made — re-issue it"
                  : "The prescription is still being prepared"
              }
              onClick={() => data?.rxStale && onReissue(visitId)}
            >
              {reissuing
                ? "↻ Re-issuing…"
                : data?.rxStale
                  ? "↻ Re-issue prescription"
                  : "🖨 Preparing…"}
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
                The full card, including medicines from outside Gini — the patient takes those too.
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
  );
}

export default function RxStationPage() {
  const { data, isLoading } = useRxQueue(undefined, debounced);
  const live = useGiniflowLive();
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState("");
  const [viewing, setViewing] = useState(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const start = useStartRxExplain();
  const explained = useMarkRxExplained();
  const reissue = useReissueRx();

  const onReissue = (visitId) =>
    reissue.mutate(
      { visitId },
      {
        onSuccess: () => setToast("↻ Prescription re-issued — it is current now"),
        onError: (e) => setToast(e?.response?.data?.error || "Could not re-issue"),
      },
    );

  const atDesk = data?.atDesk || [];
  const waiting = data?.waiting || [];
  const done = data?.explained || [];

  const pick = (visitId) => {
    setOpenId(visitId);
    if (!atDesk.some((r) => r.visitId === visitId)) start.mutate({ visitId });
  };

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
                  </div>
                  {r.canPrint && (
                    <button className="st-btn" onClick={() => setViewing(r)}>
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
        onExplained={onExplained}
        onView={(visitId, name) => setViewing({ visitId, name })}
        onReissue={onReissue}
        reissuing={reissue.isPending}
        busy={explained.isPending}
      />

      {viewing && (
        <PdfViewerModal
          src={{
            url: printRxHref(viewing.visitId),
            mimeType: "application/pdf",
            fileName: `Prescription — ${viewing.name || "patient"}`,
            title: `Prescription — ${viewing.name || "patient"}`,
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
