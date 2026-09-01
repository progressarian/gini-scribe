import { useCallback, useEffect, useRef, useState } from "react";
import { useLabQueue, useAdvanceSample, useUploadReport } from "../../queries/hooks/useGiniflowLab";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
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

// Each bucket, its heading, the pill on the card and what the timer is counting.
const GROUPS = [
  {
    key: "pending",
    label: "⏳ Sample pending — reception cleared payment, collect now",
    pill: "sp-sample",
    pillText: "Collect now",
    timerLabel: "since order",
  },
  {
    key: "collecting",
    label: "🧪 Collected — sample taken",
    pill: "sp-sample",
    pillText: "Collected",
    timerLabel: "since collection",
  },
  {
    key: "processing",
    label: "⚙️ Processing — samples in analyzer",
    pill: "sp-process",
    pillText: "Processing",
    timerLabel: "in analyzer",
  },
  {
    key: "ready",
    label: "✅ Results ready — upload now to notify MO",
    pill: "sp-ready",
    pillText: "Upload now",
    timerLabel: "results waiting",
  },
  {
    key: "uploaded",
    label: "📤 Uploaded today — MO notified",
    pill: "sp-done",
    pillText: "Done",
    timerLabel: "uploaded",
  },
];

// How long a report may sit in "results ready" before the wait itself is the
// problem — the report exists, the MO just has not been told.
const UPLOAD_WAIT_AMBER = 15;

function LabCard({ order, group, onAdvance, onUpload, onOpen, busy }) {
  const mins = minutesSince(group.key === "uploaded" ? order.uploadedAt : order.since);
  const fileRef = useRef(null);
  const waitingTooLong = group.key === "ready" && mins !== null && mins >= UPLOAD_WAIT_AMBER;
  return (
    <div
      className={`pt-card${group.key === "uploaded" ? " is-uploaded" : ""}`}
      onClick={(e) => {
        // The card opens the detail pane; the action button and the file input
        // inside it do their own thing.
        if (e.target.closest("button, input, a")) return;
        onOpen(order);
      }}
    >
      <div className="pc-av" style={{ background: avatarColour(order.patientId) }}>
        {initials(order.name)}
      </div>
      <div className="pc-body">
        <div className="pc-name">
          {order.name}{" "}
          {group.key === "uploaded" && order.uploadedAt ? (
            <span className="badge b-grn">Uploaded {clock(order.uploadedAt)}</span>
          ) : (
            <span className="badge b-ink">{order.fileNo}</span>
          )}
        </div>
        <div className="pc-meta">
          {order.age}
          {(order.sex || "")[0] || ""}
          {order.orderedBy ? ` · Ordered by ${order.orderedBy}` : ""} · {clock(order.orderedAt)}
        </div>
        <div className="pc-tests">
          🔬 {order.tests.map((t) => t.name).join(" · ") || "no tests listed"} ·{" "}
          <strong>
            {order.tests.length} test{order.tests.length === 1 ? "" : "s"}
          </strong>
        </div>
        <div className="steps">
          {order.steps.map((s, i) => (
            <span key={s.name}>
              <span className={`step step-${s.state}`}>{s.name}</span>
              {i < order.steps.length - 1 && <span className="step-arr">›</span>}
            </span>
          ))}
        </div>
        {order.blockedReason && <div className="lab-blocked">💰 {order.blockedReason}</div>}
      </div>
      <div className="pc-r">
        {order.nextAction?.to === "uploaded" ? (
          <>
            {/* The last step needs a file, not just a tap: an order marked
                uploaded with no report tells the MO a result exists when it
                does not. */}
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(order, file);
                e.target.value = "";
              }}
            />
            <button
              className="st-btn st-btn-tl"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              📤 Upload report
            </button>
          </>
        ) : order.nextAction ? (
          <button
            className="st-btn st-btn-tl"
            disabled={busy}
            onClick={() => onAdvance(order, order.nextAction.to)}
          >
            {order.nextAction.label}
          </button>
        ) : (
          <div className={`sp ${group.pill}`}>{group.pillText}</div>
        )}
        {mins !== null && (
          <>
            <div className={`pc-time${waitingTooLong ? " late" : ""}`}>{mins}m</div>
            <div className="pc-tlbl">{group.timerLabel}</div>
          </>
        )}
      </div>
    </div>
  );
}

const TEST_STATUS_LABEL = {
  ordered: "Ordered",
  paid: "Ordered",
  sample_collected: "Sample taken",
  processing: "In analyzer",
  results_ready: "Result ready",
  uploaded: "Uploaded",
};

// Escape closes, focus returns, click outside closes — the same contract the
// board's modal and drawer follow.
function useDismiss(open, onClose, ref) {
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const onKey = (e) => e.key === "Escape" && onClose();
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose, ref]);
}

function LabDetailPane({ order, group, onClose, onAdvance, onUpload, busy }) {
  const paneRef = useRef(null);
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  useDismiss(!!order, onClose, paneRef);
  if (!order) return null;

  const canUpload = ["processing", "results_ready"].includes(order.sampleStatus) && order.paid;

  // Refuse an oversized file here rather than spending a minute base64-encoding
  // it only for the service to reject it. The limit is the one the zone states.
  const take = (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      onUpload(order, file, "Report is larger than 10 MB — nothing was uploaded");
      return;
    }
    onUpload(order, file);
  };

  return (
    <div className="detail-overlay">
      <div className="detail-pane" ref={paneRef} role="dialog" aria-label="Lab order">
        <div className="dp-head">
          <div className="dp-name">{order.name}</div>
          <div className="dp-meta">
            {order.age}
            {(order.sex || "")[0] || ""} · {order.fileNo} · Tests:{" "}
            {order.tests.map((t) => t.name).join(" · ") || "none listed"}
          </div>
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
            <span className={`sp ${group.pill}`}>{group.pillText}</span>
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner">
            <div className="dp-sec">
              <div className="dp-sec-title">Tests ordered</div>
              {order.tests.map((t) => (
                <div className="test-row" key={t.name}>
                  <div className="tr-name">{t.name}</div>
                  <div className="tr-status">
                    <span className="badge b-ink">
                      {TEST_STATUS_LABEL[t.status] || t.status || "Ordered"}
                    </span>
                  </div>
                </div>
              ))}
              {order.tests.length === 0 && <div className="dp-hint">No tests on this order.</div>}
            </div>

            <div className="dp-sec">
              <div className="dp-sec-title">Update status</div>
              {order.blockedReason ? (
                <div className="dp-hint lab-blocked">💰 {order.blockedReason}</div>
              ) : order.nextAction && order.nextAction.to !== "uploaded" ? (
                <>
                  <div className="dp-hint">
                    {order.sampleStatus === "paid"
                      ? "Mark that you have collected the sample from this patient."
                      : order.sampleStatus === "sample_collected"
                        ? "Mark the sample as running in the analyzer."
                        : "Mark results as done when the analyzer completes."}
                  </div>
                  <button
                    className="st-btn st-btn-tl btn-full"
                    disabled={busy}
                    onClick={() => onAdvance(order, order.nextAction.to)}
                  >
                    {order.nextAction.label}
                  </button>
                </>
              ) : (
                <div className="dp-hint">
                  {order.sampleStatus === "uploaded"
                    ? "✓ Report uploaded and the MO has been notified. This patient reads “Results ready” on every dashboard."
                    : "Upload the report below to notify the MO instantly."}
                </div>
              )}
            </div>

            {canUpload && (
              <div className="dp-sec">
                <div className="dp-sec-title">Upload report — triggers MO notification</div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  hidden
                  onChange={(e) => {
                    take(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className={`upload-area${dragging ? " drag" : ""}`}
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    take(e.dataTransfer.files?.[0]);
                  }}
                >
                  <div className="ua-ico">📄</div>
                  <div className="ua-t">
                    {busy ? "Uploading…" : "Tap or drop the lab report here"}
                  </div>
                  <div className="ua-s">PDF · JPG · PNG accepted · Max 10MB</div>
                </button>
                <div className="dp-trigger">
                  <span className="wn-ico">⚡</span>
                  Uploading this report automatically changes this patient's status to{" "}
                  <strong>“Results ready”</strong> on the MO and SD dashboards.
                </div>
              </div>
            )}

            {order.reportUrl && (
              <div className="dp-sec">
                <div className="dp-sec-title">Report</div>
                <a
                  className="st-btn st-btn-g"
                  href={order.reportUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  📄 View uploaded report
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LabStationPage() {
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const { data, isLoading } = useLabQueue();
  const live = useGiniflowLive({ date: data?.date });
  const advance = useAdvanceSample();
  const upload = useUploadReport();
  const [openOrderId, setOpenOrderId] = useState(null);

  const counts = {
    pending: data?.pending?.length ?? 0,
    collecting: data?.collecting?.length ?? 0,
    processing: data?.processing?.length ?? 0,
    ready: data?.ready?.length ?? 0,
    uploaded: data?.uploaded?.length ?? 0,
  };

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const onAdvance = (order, to) =>
    advance.mutate(
      { orderId: order.orderId, to },
      {
        onSuccess: (r) =>
          showToast(
            r.unchanged
              ? `${order.name} was already past that step`
              : to === "uploaded"
                ? `📤 ${order.name}'s report uploaded — MO and doctor now see "Results ready"`
                : `✓ ${order.name} — ${to.replace(/_/g, " ")}`,
          ),
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not update — nothing was changed"),
      },
    );

  const onUpload = (order, file, refuseWith) => {
    if (refuseWith) return showToast(refuseWith);
    return upload.mutate(
      { orderId: order.orderId, file },
      {
        onSuccess: () =>
          showToast(`📤 ${order.name}'s report uploaded — MO and doctor now see "Results ready"`),
        onError: (e) =>
          showToast(e?.response?.data?.error || "Upload failed — the report was not saved"),
      },
    );
  };

  // Resolved from the live queue, not held in state: the pane then follows the
  // order as it moves buckets instead of showing a stale copy of it.
  const allOrders = GROUPS.flatMap((g) => (data?.[g.key] || []).map((o) => ({ o, g })));
  const openPair = allOrders.find(({ o }) => o.orderId === openOrderId) || null;
  const openOrder = openPair?.o || null;
  const openGroup = openPair?.g || GROUPS[0];
  const closePane = useCallback(() => setOpenOrderId(null), []);

  return (
    <div className="gf">
      <div className="rail">
        <div className="rl">Lab Station</div>
        <div className="rsep" />
        <span className="rail-title">
          Gini Lab ·{" "}
          {new Date().toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
        <div className="rr">
          <LiveBadge live={live} className="tr-live" />
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          <div className="stats">
            {[
              ["pending", "Sample pending", "not yet collected", "var(--tl)"],
              ["collecting", "Collecting", "sample taken", "var(--blu)"],
              ["processing", "Processing", "in analyzer", "var(--pu)"],
              ["ready", "Ready to upload", "results done", "var(--amb)"],
              ["uploaded", "Uploaded", "MO notified", "var(--grn)"],
            ].map(([key, label, sub, colour]) => (
              <div className="stat" key={key}>
                <div className="sv" style={{ color: colour }}>
                  {counts[key]}
                </div>
                <div>
                  <div className="sl">{label}</div>
                  <div className="ss">{sub}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="workflow-note lab-note">
            <span className="wn-ico">⚡</span>
            <span>
              <strong>Workflow:</strong> When you upload a report → the patient's status on the MO
              and SD dashboard changes to <strong>"Results ready"</strong> automatically. MO sees it
              in real time.
            </span>
          </div>

          {isLoading && <div className="empty-note">Loading…</div>}

          {!isLoading &&
            GROUPS.map((group) => {
              const orders = data?.[group.key] || [];
              if (!orders.length) return null;
              return (
                <div key={group.key}>
                  <div className="grp-lbl" style={{ marginBottom: 7 }}>
                    {group.label}
                  </div>
                  <div className="pt-list">
                    {(group.key === "uploaded" ? orders.slice(0, 3) : orders).map((order) => (
                      <LabCard
                        key={order.orderId}
                        order={order}
                        group={group}
                        onAdvance={onAdvance}
                        onUpload={onUpload}
                        onOpen={(o) => setOpenOrderId(o.orderId)}
                        busy={advance.isPending || upload.isPending}
                      />
                    ))}
                    {group.key === "uploaded" && orders.length > 3 && (
                      <div className="more-note">+ {orders.length - 3} more uploaded today</div>
                    )}
                  </div>
                </div>
              );
            })}

          {!isLoading && Object.values(counts).every((c) => c === 0) && (
            <div className="empty-note">
              No lab orders today. Orders appear here once an MO orders tests and reception clears
              payment.
            </div>
          )}
        </div>
      </div>

      <LabDetailPane
        order={openOrder}
        group={openGroup}
        busy={advance.isPending || upload.isPending}
        onClose={closePane}
        onAdvance={onAdvance}
        onUpload={onUpload}
      />

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
