import { useRef, useState } from "react";
import {
  useAdvanceSample,
  useOutsidePending,
  useUploadReport,
} from "../../../queries/hooks/useGiniflowLab";
import { OutsourcedTag } from "../OutsourcedTests.jsx";

const MAX_BYTES = 5 * 1024 * 1024;

const STATUS_TEXT = { collected: "Collected — not sent", sent: "Sent to outside lab" };

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

function UploadButton({ row, busy, onUpload }) {
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
        className="st-btn st-btn-tl"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        📤 Upload report
      </button>
    </>
  );
}

function PendingRow({ row, busy, onUpload, onSend }) {
  return (
    <tr>
      <td>
        <div className="op-name">{row.patient.name}</div>
        <div className="op-sub">
          {[row.patient.fileNo, row.patient.healthId && `Health ID ${row.patient.healthId}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
      <td>{day(row.visitDate)}</td>
      <td>
        {row.tests.map((name) => (
          <div key={name}>
            {name}
            <OutsourcedTag />
          </div>
        ))}
      </td>
      <td>
        <span className={`sp ${row.status === "sent" ? "sp-process" : "sp-sample"}`}>
          {STATUS_TEXT[row.status]}
        </span>
        <div className="op-sub">
          {row.status === "sent"
            ? `${when(row.sentAt)}${row.sentBy ? ` · ${row.sentBy}` : ""}`
            : `Collected ${when(row.collectedAt)}`}
        </div>
      </td>
      <td>{waitingText(row.daysWaiting)}</td>
      <td className="op-actions">
        {row.status === "collected" && (
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
      </td>
    </tr>
  );
}

export default function OutsidePendingPanel({ onToast }) {
  const [open, setOpen] = useState(true);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching, refetch } = useOutsidePending({
    ...filters,
    page,
  });
  const upload = useUploadReport();
  const advance = useAdvanceSample();
  const busy = upload.isPending || advance.isPending;
  const filtered =
    filters.q.trim().length >= 2 || filters.status !== "all" || filters.from || filters.to;
  const rows = data?.rows ?? [];
  const setFilter = (key) => (e) => {
    setFilters((was) => ({ ...was, [key]: e.target.value }));
    setPage(1);
  };

  const onUpload = (row, file) => {
    if (file.size > MAX_BYTES) return onToast("Report is larger than 5 MB — nothing was uploaded");
    return upload.mutate(
      { orderId: row.orderId, file, outside: true },
      {
        onSuccess: () =>
          onToast(`📤 ${row.patient.name}'s outside report uploaded — removed from this list`),
        onError: (e) =>
          onToast(e?.response?.data?.error || "Upload failed — the report was not saved"),
      },
    );
  };

  const onSend = (row) =>
    advance.mutate(
      { orderId: row.orderId, to: "sent_outside" },
      {
        onSuccess: () => onToast(`📮 ${row.patient.name}'s sample marked sent to the outside lab`),
        onError: (e) => onToast(e?.response?.data?.error || "Could not mark the sample sent"),
      },
    );

  return (
    <section className="cx-panel" aria-label="Outside reports pending">
      <div className="grp-lbl grp-lbl-sp">
        <button
          type="button"
          className="sq-toggle"
          aria-expanded={open}
          aria-controls="lab-outside-pending"
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
          📮 Outside reports pending — all days
        </button>
        <span className="grp-split">{data?.counts?.all ?? "…"}</span>
      </div>
      <div id="lab-outside-pending" hidden={!open}>
        <div className="op-filters">
          <input
            className="op-input"
            type="search"
            aria-label="Search outside reports"
            placeholder="Search by patient name, UHID, Health ID or test"
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
          </select>
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
              <table className="op-table" aria-label="Outside reports pending">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Visit</th>
                    <th scope="col">Tests</th>
                    <th scope="col">Status</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <PendingRow
                      key={row.orderId}
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
    </section>
  );
}
