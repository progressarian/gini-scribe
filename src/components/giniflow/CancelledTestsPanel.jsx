import { useRef, useState } from "react";
import ConfirmModal from "../ui/ConfirmModal";
import { useCancelledTests, useRestoreTest } from "../../queries/hooks/useGiniflowCancelled";

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const paidText = (row) =>
  row.amountPaid > 0 ? `${rupees(row.amountPaid)} paid` : `Not paid · ${rupees(row.price)}`;

function RestoreBody({ row }) {
  return (
    <dl className="cx-confirm">
      <div>
        <dt>Patient</dt>
        <dd>
          {row.patient.name} · {row.patient.fileNo}
        </dd>
      </div>
      <div>
        <dt>Test</dt>
        <dd>
          {row.tests} · {row.visitDate}
        </dd>
      </div>
      <div>
        <dt>Payment</dt>
        <dd>
          {row.amountPaid > 0
            ? `${rupees(row.amountPaid)} already paid — it comes back as paid, nothing is collected again`
            : `Not paid — ${rupees(row.price)} goes back on the patient's bill`}
        </dd>
      </div>
      <div>
        <dt>Afterwards</dt>
        <dd>
          {row.visitDate === todayIso()
            ? "The test is back in this station's queue."
            : "The report can be uploaded from this list."}
        </dd>
      </div>
    </dl>
  );
}

function UploadReport({ row, onUpload, busy }) {
  const input = useRef(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        hidden
        aria-label={`Report file for ${row.patient.name}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onUpload(row, file);
        }}
      />
      <button
        type="button"
        className="st-btn st-btn-grn"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        Upload report
      </button>
    </>
  );
}

function RowState({ row, canRestore, busy, onAsk, onUpload }) {
  if (row.restoredAt) {
    const past = row.visitDate !== todayIso();
    return (
      <>
        <div className="sp sp-ready">Restored</div>
        <div className="pc-tlbl">
          {when(row.restoredAt)}
          {row.restoredBy ? ` · ${row.restoredBy}` : ""}
        </div>
        {row.reported ? (
          <div className="pc-tlbl">Report uploaded</div>
        ) : past && onUpload ? (
          <UploadReport row={row} onUpload={onUpload} busy={busy} />
        ) : (
          !past && <div className="pc-tlbl">Back in the queue</div>
        )}
      </>
    );
  }
  return (
    <>
      <div className="sp sp-process">Cancelled</div>
      {canRestore && row.canRestore && (
        <button
          type="button"
          className="st-btn st-btn-g"
          disabled={busy}
          onClick={() => onAsk(row)}
        >
          Restore
        </button>
      )}
      {row.whyNot && <div className="pc-tlbl">{row.whyNot}</div>}
    </>
  );
}

export default function CancelledTestsPanel({
  station,
  canRestore,
  onToast,
  onUpload,
  uploading,
  inTab = false,
}) {
  const { data: rows = [], isLoading, isError, refetch } = useCancelledTests(station);
  const restore = useRestoreTest(station);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(null);
  const [error, setError] = useState(null);
  const waiting = rows.filter((r) => !r.restoredAt).length;
  const panelId = `${station}-cancelled`;

  const confirm = () =>
    restore.mutate(
      { orderId: asking.orderId },
      {
        onSuccess: () => {
          onToast?.(`${asking.tests} restored for ${asking.patient.name}`);
          setAsking(null);
          setError(null);
        },
        onError: (e) =>
          setError(e?.response?.data?.error || "Could not restore — nothing was changed"),
      },
    );

  return (
    <section className="cx-panel" aria-label="Cancelled tests">
      {inTab ? (
        <p className="op-intro">
          Tests cancelled at this station in the last 3 days. Restore one cancelled by mistake.
        </p>
      ) : (
        <div className="grp-lbl grp-lbl-sp">
          <button
            type="button"
            className="sq-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
              ▸
            </span>
            Cancelled — last 3 days
          </button>
          <span className="grp-split">{waiting}</span>
        </div>
      )}
      <div id={panelId} hidden={!inTab && !open}>
        {isLoading ? (
          <div className="empty-note">Loading cancelled tests…</div>
        ) : isError ? (
          <div className="empty-note">
            Could not load cancelled tests.{" "}
            <button type="button" className="st-btn st-btn-g" onClick={() => refetch()}>
              Try again
            </button>
          </div>
        ) : !rows.length ? (
          <div className="empty-note">No tests were cancelled here in the last 3 days.</div>
        ) : (
          <div className="mroom__stage pt-list">
            {rows.map((row) => (
              <div key={row.orderId} className="pt-card is-readonly">
                <div className="pc-body">
                  <div className="pc-name">
                    {row.patient.name}
                    {row.patient.fileNo && (
                      <span className="badge b-ink">{row.patient.fileNo}</span>
                    )}
                  </div>
                  <div className="pc-meta">
                    {[
                      row.patient.age && row.patient.sex
                        ? `${row.patient.age}${row.patient.sex[0]}`
                        : row.patient.age,
                      row.visitDate === todayIso() ? "Today" : row.visitDate,
                      paidText(row),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="pc-tests">
                    <span className="pc-test">{row.tests}</span>
                  </div>
                  <div className="pc-tlbl">
                    Cancelled {when(row.cancelledAt)}
                    {row.cancelledBy
                      ? ` by ${row.cancelledBy}`
                      : row.source === "healthray"
                        ? " by HealthRay"
                        : ""}
                    {` · ${row.reasonLabel}`}
                    {row.note ? ` — ${row.note}` : ""}
                  </div>
                </div>
                <div className="pc-r">
                  <RowState
                    row={row}
                    canRestore={canRestore}
                    busy={restore.isPending || uploading}
                    onAsk={(r) => {
                      setError(null);
                      setAsking(r);
                    }}
                    onUpload={onUpload}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmModal
        open={!!asking}
        title={asking ? `Restore ${asking.tests} for ${asking.patient.name}?` : ""}
        message={asking ? <RestoreBody row={asking} /> : null}
        confirmLabel={restore.isPending ? "Restoring…" : "Restore test"}
        variant="primary"
        busy={restore.isPending}
        error={error}
        onConfirm={confirm}
        onCancel={() => {
          if (!restore.isPending) setAsking(null);
        }}
      />
    </section>
  );
}
