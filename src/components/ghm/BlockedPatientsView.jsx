import { useEffect, useState } from "react";
import { Ban, CheckCircle2, X } from "lucide-react";
import ConfirmModal from "../ui/ConfirmModal";
import Pagination, { DEFAULT_PAGE_SIZES } from "../ui/Pagination";
import {
  useBlockedPatients,
  usePatientBlockHistory,
  useUnblockPatient,
} from "../../queries/hooks/usePatientBlocks";

// Admin-only review screen for the blocklist: who is blocked, who they are,
// why, and the one place a block is lifted. Reached as the "Blocked" tab on
// /ghm and as the standalone /admin/blocklist page.
//
// Full personal detail is shown here deliberately — an administrator deciding
// whether to lift a block has to be able to recognise the person. The endpoint
// behind it is ADMIN-gated for exactly that reason.
export default function BlockedPatientsView() {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [unblocking, setUnblocking] = useState(null);
  const [msg, setMsg] = useState(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZES[1]);

  // Search runs server-side, so hold the keystrokes back — without this every
  // character is its own request and its own ILIKE scan. Same 300ms the other
  // search boxes in the app use (AppPatientsPage).
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // A new search term restarts at page 1 — page 4 of the old results means
  // nothing against the new ones.
  useEffect(() => setPage(1), [debouncedQ]);

  const listQuery = useBlockedPatients({ q: debouncedQ || undefined, page, limit: pageSize });

  const total = listQuery.data?.total || 0;
  const rows = listQuery.data?.data || [];
  const isPending = listQuery.isPending;

  // Unblocking the last row on the last page shrinks the list under the reader,
  // leaving them on a page the server no longer has. Step back into range.
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (!isPending && page > totalPages) setPage(totalPages);
  }, [isPending, page, totalPages]);

  return (
    <div>
      <div className="qfilter">
        <span className="qfilter__hint">
          Blocked patients cannot book new appointments, receive no SMS / WhatsApp / push messages,
          and cannot sign in to the patient app. Only an administrator can lift a block.
        </span>
      </div>

      <div style={{ margin: "10px 0 14px" }}>
        <label htmlFor="blocked-search" className="blocked__sr">
          Search blocked patients
        </label>
        <input
          id="blocked-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, file no or phone…"
          className="blocked__search"
        />
      </div>

      {msg && (
        <div className={`reassign-msg reassign-msg--${msg.ok ? "ok" : "err"}`}>
          {msg.ok ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : (
            <X size={14} aria-hidden="true" />
          )}
          {msg.text}
        </div>
      )}

      {isPending ? (
        <div className="ghm__loading">
          <div className="spinner" />
          Loading…
        </div>
      ) : total === 0 ? (
        <div className="ghm__empty">
          <div className="ghm__empty-icon">
            <Ban size={34} aria-hidden="true" />
          </div>
          <div className="ghm__empty-title">
            {q ? "No blocked patients match that search" : "No patients are blocked"}
          </div>
          <div className="ghm__empty-sub">
            {q ? "Try a different name, file number or phone." : "Nothing to review."}
          </div>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="tc" style={{ width: 52 }}>
                  Sr No
                </th>
                <th style={{ minWidth: 170 }}>Patient</th>
                <th style={{ width: 110 }}>File No</th>
                <th style={{ width: 130 }}>Phone</th>
                <th style={{ width: 80 }}>Age / Sex</th>
                <th style={{ minWidth: 160 }}>Address</th>
                <th style={{ width: 110 }}>Last visit</th>
                <th style={{ minWidth: 170 }}>Reason</th>
                <th style={{ width: 130 }}>Blocked by</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <BlockedRow
                  key={r.id}
                  row={r}
                  serial={(page - 1) * pageSize + i + 1}
                  expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  onUnblock={() => setUnblocking(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={listQuery.isFetching}
        unit="blocked patients"
      />

      {unblocking && (
        <UnblockModal
          patient={unblocking}
          onClose={() => setUnblocking(null)}
          onDone={(name) => setMsg({ ok: true, text: `${name} is no longer blocked` })}
        />
      )}
    </div>
  );
}

function BlockedRow({ row, serial, expanded, onToggle, onUnblock }) {
  const { data: history = [] } = usePatientBlockHistory(row.id, expanded);
  const altPhones = Array.isArray(row.alt_phone) ? row.alt_phone.filter(Boolean) : [];

  return (
    <>
      <tr>
        <td className="tc">
          <span className="rnum">{serial}</span>
        </td>
        <td>
          <strong>{row.name}</strong>
          {row.email ? <small style={{ display: "block" }}>{row.email}</small> : null}
        </td>
        <td>{row.file_no || "—"}</td>
        <td>
          {row.phone || "—"}
          {altPhones.length > 0 && (
            <small style={{ display: "block" }}>alt: {altPhones.join(", ")}</small>
          )}
        </td>
        <td>
          {row.age != null ? `${row.age}Y` : "—"}
          {row.sex ? ` / ${String(row.sex)[0]}` : ""}
        </td>
        <td>
          <span style={{ fontSize: 12 }}>{row.address || "—"}</span>
        </td>
        <td>
          {fmtDate(row.last_visit_date)}
          {row.visit_count ? (
            <small style={{ display: "block" }}>{row.visit_count} visits</small>
          ) : null}
        </td>
        <td>
          <span className="blocked__reason">{row.blocked_label || "—"}</span>
          {row.blocked_note && <small style={{ display: "block" }}>{row.blocked_note}</small>}
        </td>
        <td>
          {row.blocked_by || "—"}
          <small style={{ display: "block" }}>{fmtDate(row.blocked_at)}</small>
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button type="button" className="btn btn--ghost" onClick={onToggle}>
            {expanded ? "Hide" : "History"}
          </button>{" "}
          <button type="button" className="btn btn--ghost blocked__unblock" onClick={onUnblock}>
            Unblock
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} style={{ background: "#f9fafb" }}>
            {history.length === 0 ? (
              <span style={{ fontSize: 12, color: "#6b7280" }}>No history recorded.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#374151" }}>
                {history.map((h) => (
                  <li key={h.id} style={{ marginBottom: 3 }}>
                    <strong>{h.action}</strong>
                    {h.label ? ` — ${h.label}` : ""}
                    {h.note ? ` — ${h.note}` : ""} · {h.actor_name || "system"} ·{" "}
                    {fmtDate(h.created_at)}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// Uses the shared ConfirmModal rather than a bespoke dialog. The note is
// mandatory, so it rides in the modal's `message` slot and gates its confirm
// button — a lifted block always leaves a reasoned record.
function UnblockModal({ patient, onClose, onDone }) {
  const [note, setNote] = useState("");
  const unblock = useUnblockPatient();
  const canSubmit = note.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || unblock.isPending) return;
    try {
      await unblock.mutateAsync({ patientId: patient.id, note: note.trim() });
      onDone?.(patient.name);
      onClose();
    } catch {
      // surfaced by the modal's error prop
    }
  };

  return (
    <ConfirmModal
      open
      variant="danger"
      title={`Unblock ${patient.name}?`}
      confirmLabel={unblock.isPending ? "Unblocking…" : "Unblock"}
      cancelLabel="Cancel"
      confirmDisabled={!canSubmit}
      busy={unblock.isPending}
      error={
        unblock.isError
          ? unblock.error?.response?.data?.error || "Could not unblock this patient."
          : null
      }
      onConfirm={submit}
      onCancel={unblock.isPending ? undefined : onClose}
      message={
        <>
          <div style={{ marginBottom: 10 }}>
            {[patient.file_no, patient.phone].filter(Boolean).join(" · ")}
          </div>
          <div style={{ marginBottom: 10 }}>
            They will be able to book appointments, receive messages and sign in to the patient app
            again.
          </div>
          <label htmlFor="unblock-note" className="blocked__label" style={{ marginTop: 0 }}>
            Why is this block being lifted? (required)
          </label>
          <textarea
            id="unblock-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="blocked__textarea"
            autoFocus
          />
        </>
      }
    />
  );
}

function fmtDate(v) {
  if (!v) return "—";
  try {
    return new Date(String(v).slice(0, 10) + "T12:00:00").toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
    });
  } catch {
    return "—";
  }
}
