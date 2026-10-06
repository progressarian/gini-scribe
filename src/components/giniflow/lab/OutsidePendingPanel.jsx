import { useRef, useState } from "react";
import {
  useAdvanceSample,
  useMarkCaseSentOutside,
  useOutsidePending,
  useUploadLabCaseReport,
  useUploadReport,
} from "../../../queries/hooks/useGiniflowLab";
import ConfirmModal from "../../ui/ConfirmModal";
import { OutsourcedTag } from "../OutsourcedTests.jsx";

const MAX_BYTES = 5 * 1024 * 1024;

const STATUS_TEXT = {
  collected: "Collected — not sent",
  sent: "Sent to outside lab",
  uploaded: "✓ Report uploaded",
};

const STATUS_PILL = { collected: "sp-sample", sent: "sp-process", uploaded: "sp-ready" };

const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

const day = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const waitingText = (days) => (days <= 0 ? "Today" : days === 1 ? "1 day" : `${days} days`);

const NO_FILTERS = { q: "", status: "all", from: "", to: "" };

function UploadButton({ row, busy, onUpload, label = "📤 Upload report", tone = "st-btn-tl" }) {
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
        className={`st-btn ${tone}`}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {label}
      </button>
    </>
  );
}

const statusNote = (row) =>
  row.status === "uploaded"
    ? `${when(row.uploadedAt)}${row.uploadedBy ? ` · ${row.uploadedBy}` : ""}`
    : row.status === "sent"
      ? `${when(row.sentAt)}${row.sentBy ? ` · ${row.sentBy}` : ""}`
      : `Collected ${when(row.collectedAt)}`;

function PendingRow({ row, busy, canSend, onUpload, onSend, onView, onReplace }) {
  const uploaded = row.status === "uploaded";
  return (
    <tr role="row">
      <td role="cell" data-label="Patient">
        <div className="op-name">{row.patient.name}</div>
        <div className="op-sub">
          {[
            row.patient.fileNo,
            [row.patient.age, (row.patient.sex || "")[0]].filter(Boolean).join(""),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
      <td role="cell" data-label="Visit">
        {day(row.visitDate)}
      </td>
      <td role="cell" data-label="Tests">
        {row.tests.map((name) => (
          <div key={name}>
            {name}
            <OutsourcedTag />
          </div>
        ))}
      </td>
      <td role="cell" data-label="Status">
        <div>
          <span className={`sp ${STATUS_PILL[row.status]}`}>{STATUS_TEXT[row.status]}</span>
          <div className="op-sub">{statusNote(row)}</div>
        </div>
      </td>
      <td role="cell" data-label="Waiting">
        {uploaded ? "Done" : waitingText(row.daysWaiting)}
      </td>
      <td role="cell" className="op-actions">
        {uploaded ? (
          <>
            {row.docId && (
              <button
                type="button"
                className="st-btn st-btn-g"
                disabled={busy}
                onClick={() => onView(row)}
              >
                View report
              </button>
            )}
            <UploadButton
              row={row}
              busy={busy}
              onUpload={onReplace}
              label="Replace report"
              tone="st-btn-g"
            />
          </>
        ) : (
          <>
            {canSend && row.status === "collected" && (
              <button
                type="button"
                className="st-btn st-btn-g"
                disabled={busy}
                onClick={() => onSend(row)}
              >
                📮 Mark sent
              </button>
            )}
            <UploadButton row={row} busy={busy} onUpload={onUpload} />
          </>
        )}
      </td>
    </tr>
  );
}

export default function OutsidePendingPanel({ onToast, onViewReport, canSend = true }) {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [replacing, setReplacing] = useState(null);
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching, refetch } = useOutsidePending({
    ...filters,
    page,
  });
  const upload = useUploadReport();
  const uploadCase = useUploadLabCaseReport();
  const advance = useAdvanceSample();
  const sendCase = useMarkCaseSentOutside();
  const busy = upload.isPending || uploadCase.isPending || advance.isPending || sendCase.isPending;
  const filtered =
    filters.q.trim().length >= 2 || filters.status !== "all" || filters.from || filters.to;
  const rows = data?.rows ?? [];
  const setFilter = (key) => (e) => {
    setFilters((was) => ({ ...was, [key]: e.target.value }));
    setPage(1);
  };

  const send = (row, file, replace, done) =>
    row.kind === "case"
      ? uploadCase.mutate({ caseNo: row.caseNo, file, outside: true, replace }, done)
      : upload.mutate({ orderId: row.orderId, file, outside: true, replace }, done);

  const onUpload = (row, file) => {
    if (file.size > MAX_BYTES) return onToast("Report is larger than 5 MB — nothing was uploaded");
    return send(row, file, false, {
      onSuccess: () =>
        onToast(
          `📤 ${row.patient.name}'s outside report uploaded — it stays here as done for today`,
        ),
      onError: (e) =>
        onToast(e?.response?.data?.error || "Upload failed — the report was not saved"),
    });
  };

  const onReplace = (row, file) => {
    if (file.size > MAX_BYTES) return onToast("Report is larger than 5 MB — nothing was uploaded");
    return setReplacing({ row, file });
  };

  const confirmReplace = () =>
    send(replacing.row, replacing.file, true, {
      onSuccess: () => {
        onToast(`📤 ${replacing.row.patient.name}'s report replaced`);
        setReplacing(null);
      },
      onError: (e) => {
        onToast(e?.response?.data?.error || "Replace failed — the earlier report is unchanged");
        setReplacing(null);
      },
    });

  const onSend = (row) => {
    const done = {
      onSuccess: () => onToast(`📮 ${row.patient.name}'s sample marked sent to the outside lab`),
      onError: (e) => onToast(e?.response?.data?.error || "Could not mark the sample sent"),
    };
    return row.kind === "case"
      ? sendCase.mutate({ caseNo: row.caseNo }, done)
      : advance.mutate({ orderId: row.orderId, to: "sent_outside" }, done);
  };

  return (
    <section className="cx-panel" aria-label="Outside reports pending">
      <p className="op-intro">
        Outsourced tests from every day whose report has not been uploaded yet, and the ones
        uploaded today. Mark the sample sent when it leaves, and upload the report when it comes
        back.
      </p>
      <div>
        <div className="op-filters">
          <input
            className="op-input"
            type="search"
            aria-label="Search outside reports"
            placeholder="Search by patient name, UHID or test"
            value={filters.q}
            onChange={setFilter("q")}
          />
          <select
            className="op-input"
            aria-label="Status"
            value={filters.status}
            onChange={setFilter("status")}
          >
            <option value="all">All ({data?.counts?.all ?? 0})</option>
            <option value="collected">Collected — not sent ({data?.counts?.collected ?? 0})</option>
            <option value="sent">Sent to outside lab ({data?.counts?.sent ?? 0})</option>
            <option value="uploaded">Uploaded today ({data?.counts?.uploaded ?? 0})</option>
          </select>
          <div className="op-dates">
            <label className="op-date">
              From
              <input
                className="op-input"
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={setFilter("from")}
              />
            </label>
            <label className="op-date">
              To
              <input
                className="op-input"
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={setFilter("to")}
              />
            </label>
          </div>
          {filtered && (
            <button
              type="button"
              className="sq-clearfilter"
              onClick={() => {
                setFilters(NO_FILTERS);
                setPage(1);
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="empty-note">Loading outside reports…</div>
        ) : isError ? (
          <div className="empty-note">
            Could not load the outside reports.{" "}
            <button type="button" className="st-btn st-btn-g" onClick={() => refetch()}>
              Try again
            </button>
          </div>
        ) : !rows.length ? (
          <div className="empty-note">
            {filtered
              ? "No outside reports match these filters."
              : "No outside reports pending. A test appears here once its sample is collected and stays until its report is uploaded."}
          </div>
        ) : (
          <>
            <div className="ltablewrap">
              <table
                role="table"
                className="op-table op-cards"
                aria-label="Outside reports pending"
              >
                <thead role="rowgroup">
                  <tr role="row">
                    <th role="columnheader" scope="col">
                      Patient
                    </th>
                    <th role="columnheader" scope="col">
                      Visit
                    </th>
                    <th role="columnheader" scope="col">
                      Tests
                    </th>
                    <th role="columnheader" scope="col">
                      Status
                    </th>
                    <th role="columnheader" scope="col">
                      Waiting
                    </th>
                    <th role="columnheader" scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {rows.map((row) => (
                    <PendingRow
                      key={row.key}
                      canSend={canSend}
                      onView={onViewReport}
                      onReplace={onReplace}
                      row={row}
                      busy={busy}
                      onUpload={onUpload}
                      onSend={onSend}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="op-pager">
              <span>
                {data.total} pending{isFetching ? " · updating…" : ""}
              </span>
              {data.pages > 1 && (
                <>
                  <button
                    type="button"
                    className="st-btn st-btn-g"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ‹ Previous
                  </button>
                  <span>
                    Page {data.page} of {data.pages}
                  </span>
                  <button
                    type="button"
                    className="st-btn st-btn-g"
                    disabled={page >= data.pages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next ›
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmModal
        open={!!replacing}
        title={replacing ? `Replace the report for ${replacing.row.patient.name}?` : ""}
        message={
          replacing ? (
            <>
              <strong>{replacing.file.name}</strong> replaces the report already on{" "}
              {replacing.row.patient.name}&apos;s chart for {replacing.row.tests.join(", ")} (
              {day(replacing.row.visitDate)}). The earlier file is removed from the chart.
            </>
          ) : null
        }
        confirmLabel={busy ? "Replacing…" : "Replace report"}
        variant="primary"
        busy={busy}
        onConfirm={confirmReplace}
        onCancel={() => {
          if (!busy) setReplacing(null);
        }}
      />
    </section>
  );
}
