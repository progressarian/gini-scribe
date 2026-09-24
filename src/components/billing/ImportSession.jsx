import { useEffect, useId, useState } from "react";
import {
  useAbandonBillingImportSession,
  useBillingImportFailedRows,
  useBillingImportRows,
  useBillingImportSession,
  useCommitBillingImportSession,
  useDecideBillingImportRows,
} from "../../queries/hooks/useBillingMaster";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";
import useDebounced from "../../hooks/useDebounced";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import ConfirmModal from "../ui/ConfirmModal";
import ImportRows from "./ImportRows";
import useDialog from "./useDialog";
import { requestErrorOf } from "./format";
import { OUTCOME_TEXT, STATUS_TEXT, labelOf, ordered, plural, saveBlob, when } from "./importText";

const GONE = new Set([404, 410]);

const planLines = (plan) => [
  `${plural(plan.save, "row")} will be saved — new rows, and the changes you chose to override`,
  `${plural(plan.keep, "row")} will be kept as they are in Scribe, not saved — ${plan.undecided} of them undecided`,
  `${plural(plan.failed, "failed row")} will be skipped — nothing from them is saved`,
  `${plural(plan.unchanged, "row")} already ${plan.unchanged === 1 ? "matches" : "match"} Scribe — nothing to do`,
];

const outcomeLines = (outcome) => [
  `${outcome.saved} saved`,
  `${outcome.kept} kept as they were — not changed`,
  `${outcome.failed} failed — skipped`,
  `${outcome.unchanged} unchanged`,
];

function Summary({ counts, text, label }) {
  const keys = ordered(counts, text).filter((key) => counts[key]);
  return (
    <ul className="bill-import__counts" aria-label={label}>
      {keys.length ? (
        keys.map((key) => (
          <li key={key} className={`bill-import__count bill-import__count--${key}`}>
            {counts[key]} {labelOf(key, text).toLowerCase()}
          </li>
        ))
      ) : (
        <li className="bill-import__count">No rows</li>
      )}
    </ul>
  );
}

function CommitDialog({ open, session, busy, error, onCancel, onConfirm }) {
  const ref = useDialog(open, onCancel);
  if (!open) return null;
  const { plan } = session.live;
  return (
    <div className="flow-dialog-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={ref}
        className="flow-card bill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-commit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="import-commit-title" className="bill-dialog__title">
          Commit {session.file_name}?
        </h2>
        <p>
          Only the rows counted as saved change Scribe. Kept rows stay exactly as they are in
          Scribe, whatever this file says.
        </p>
        <ul className="bill-dialog__list" aria-label="What will happen">
          {planLines(plan).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {plan.undecided ? (
          <p className="flow-muted">
            {plural(plan.undecided, "change")} you haven't decided will be kept, not saved. Choose
            Override on a row to save its change.
          </p>
        ) : null}
        <p className="flow-muted">
          A row that changed in Scribe since the upload fails instead of being overwritten, and is
          listed afterwards.
        </p>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-primary"
            disabled={busy || !plan.save}
            onClick={onConfirm}
          >
            Yes, save {plural(plan.save, "row")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Pager({ data, onPage }) {
  if (!data.total) return null;
  const first = (data.page - 1) * data.page_size + 1;
  const last = first + data.rows.length - 1;
  return (
    <nav className="bill-import__pager" aria-label="Row pages">
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
      >
        Previous
      </button>
      <span className="flow-muted">
        Page {data.page} of {Math.max(data.pages, 1)} · rows {data.rows.length ? first : 0}–
        {data.rows.length ? last : 0} of {data.total}
      </span>
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        disabled={data.page >= data.pages}
        onClick={() => onPage(data.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

function Missing({ error, onClose, onUploadAgain }) {
  return (
    <section className="flow-card" aria-labelledby="import-session-title">
      <div className="fset__cardhead">
        <h2 id="import-session-title" className="flow-sec-title">
          Import
        </h2>
      </div>
      <p className="bill-dialog__error" role="alert">
        {error}
      </p>
      <div className="bill-import__actions">
        <button type="button" className="flow-btn flow-btn-primary" onClick={onUploadAgain}>
          Upload a fresh file
        </button>
        <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

export default function ImportSession({ id, filters, setFilters, onClose, onUploadAgain }) {
  const formId = useId();
  const me = useAuthStore((s) => s.currentDoctor);
  const sessionQuery = useBillingImportSession(id);
  const session = sessionQuery.data;
  const committed = session?.status === "committed";
  const facet = committed ? "outcome" : "status";
  const facetText = committed ? OUTCOME_TEXT : STATUS_TEXT;
  const readable = session && session.status !== "abandoned";
  const rowsQuery = useBillingImportRows(readable ? id : null, {
    status: filters.status,
    outcome: filters.outcome,
    sheet: filters.sheet,
    q: filters.q,
    page: filters.page,
  });
  const decide = useDecideBillingImportRows();
  const commit = useCommitBillingImportSession();
  const abandon = useAbandonBillingImportSession();
  const failedFile = useBillingImportFailedRows();
  const [text, setText] = useState(filters.q);
  const settled = useDebounced(text, 300);
  const [actionError, setActionError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [abandoning, setAbandoning] = useState(false);

  useEffect(() => {
    if (settled.trim() !== filters.q) setFilters({ q: settled.trim() }, true);
  }, [settled]);

  useEffect(() => {
    setText((current) => (current.trim() === filters.q ? current : filters.q));
  }, [filters.q]);

  const data = rowsQuery.data;
  useEffect(() => {
    if (data?.pages && data.page > data.pages) setFilters({ page: String(data.pages) }, true);
  }, [data?.page, data?.pages]);

  if (sessionQuery.isError) {
    return (
      <Missing
        error={requestErrorOf(sessionQuery.error, "Could not load this import")}
        onClose={onClose}
        onUploadAgain={onUploadAgain}
      />
    );
  }
  if (!session) {
    return (
      <section className="flow-card" aria-label="Import">
        <p className="fset__cardsub" role="status">
          Loading the import…
        </p>
      </section>
    );
  }
  if (session.status === "abandoned") {
    return (
      <Missing
        error="This import was abandoned; nothing from it was saved. Upload the file again to start over."
        onClose={onClose}
        onUploadAgain={onUploadAgain}
      />
    );
  }

  const { live } = session;
  const open = session.status === "open" && !session.expired;
  const mayAct =
    Boolean(me) && (me.id === session.uploaded_by || hasCapability(me.role, CAPABILITIES.ADMIN));
  const canChange = open && mayAct;
  const totalRows = Object.values(live.status).reduce((sum, n) => sum + n, 0);
  const failedCount = committed ? live.outcome.failed : live.status.failed;
  const counts = data?.counts;
  const current = filters[facet];
  const bulkShown =
    canChange &&
    counts &&
    (!filters.status || filters.status === "override") &&
    counts.status.override > 0;
  const busy = decide.isPending || commit.isPending || abandon.isPending;

  const failWith = (err, fallback) => {
    const message = requestErrorOf(err, fallback);
    setActionError(message);
    if (GONE.has(err?.response?.status)) setConfirming(false);
    return message;
  };

  const onDecide = async (rowIds, decision) => {
    setActionError("");
    try {
      await decide.mutateAsync({ id, decision, row_ids: rowIds });
    } catch (err) {
      failWith(err, "Could not save the decision");
    }
  };

  const decideAll = async (decision) => {
    setActionError("");
    try {
      const result = await decide.mutateAsync({
        id,
        decision,
        filter: { ...(filters.sheet ? { sheet: filters.sheet } : {}), q: filters.q || undefined },
      });
      toast(
        `${decision === "override" ? "Override" : "Keep"}: ${plural(result.matched, "row")}`,
        "success",
      );
    } catch (err) {
      failWith(err, "Could not save the decisions");
    }
  };

  const openCommit = async () => {
    setActionError("");
    setCommitError("");
    const fresh = await sessionQuery.refetch();
    if (fresh.data?.status === "open" && !fresh.data.expired) setConfirming(true);
  };

  const commitNow = async () => {
    setCommitError("");
    try {
      const result = await commit.mutateAsync({ id });
      setConfirming(false);
      setFilters({ status: "", outcome: "", sheet: "", q: "" });
      toast(`Imported ${session.file_name}: ${result.outcome.saved} saved`, "success");
    } catch (err) {
      const message = requestErrorOf(err, "Could not commit the import");
      if (GONE.has(err?.response?.status) || err?.response?.status === 403) {
        setConfirming(false);
        failWith(err, "Could not commit the import");
      } else {
        setCommitError(message);
      }
    }
  };

  const abandonNow = async () => {
    try {
      await abandon.mutateAsync({ id });
      setAbandoning(false);
      toast(`Abandoned ${session.file_name}; nothing was saved`, "success");
      onClose();
    } catch (err) {
      setAbandoning(false);
      failWith(err, "Could not abandon the import");
    }
  };

  const downloadFailed = async () => {
    try {
      saveBlob(await failedFile.mutateAsync({ id, fileName: session.file_name }));
    } catch (err) {
      toast(requestErrorOf(err, "Could not download the failed rows"), "error", 6000);
    }
  };

  const parentLink = (dep) => {
    const next = new URLSearchParams({ session: id, sheet: dep.sheet, row: String(dep.id) });
    if (dep.key) next.set("q", dep.key);
    return `?${next}`;
  };

  const sheetOptions = counts
    ? Object.keys(counts.sheet).filter(
        (name) => name !== "all" && (counts.sheet[name] || name === filters.sheet),
      )
    : [];
  const filtered = Boolean(filters.status || filters.outcome || filters.sheet || filters.q);

  return (
    <section className="flow-card" aria-labelledby="import-session-title">
      <div className="fset__cardhead">
        <h2 id="import-session-title" className="flow-sec-title">
          {committed ? "Import report" : "Import"}
        </h2>
        <span className="bill-import__file flow-muted">{session.file_name}</span>
      </div>
      <div className="fset__cardsub">
        Uploaded by {session.uploaded_by_name ?? "someone"} on {when(session.uploaded_at)}.{" "}
        {committed
          ? `Saved by ${session.committed_by_name ?? "someone"} on ${when(session.committed_at)} (import ${session.import_id}).`
          : session.expired
            ? `Expired ${when(session.expires_at)}.`
            : `Open until ${when(session.expires_at)}; after that it expires and must be uploaded again.`}
      </div>

      {committed ? (
        <div className="bill-import__done" role="status" aria-labelledby="import-done-title">
          <h3 id="import-done-title" className="flow-sec-title">
            Imported {session.file_name}
          </h3>
          <ul className="bill-dialog__list" aria-label="What happened">
            {outcomeLines(live.outcome).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <Summary counts={live.status} text={STATUS_TEXT} label="All rows" />
          <p className="fset__cardsub bill-import__plan">
            If you commit now: {live.plan.save} saved · {live.plan.keep} kept, not saved (
            {live.plan.undecided} undecided) · {live.plan.failed} failed, skipped ·{" "}
            {live.plan.unchanged} unchanged.
          </p>
        </>
      )}

      {session.expired && session.status === "open" ? (
        <div className="bill-import__notice" role="alert">
          <p className="bill-dialog__error">
            This import expired on {when(session.expires_at)}. It can't be decided or committed any
            more — upload the file again to start over.
          </p>
          <button type="button" className="flow-btn flow-btn-primary" onClick={onUploadAgain}>
            Upload a fresh file
          </button>
        </div>
      ) : null}

      {!mayAct && session.status === "open" ? (
        <p className="fset__cardsub bill-import__notice" role="note">
          Not your import: only {session.uploaded_by_name ?? "the person who uploaded it"} or an
          admin can decide, commit or abandon it. You can look through its rows.
        </p>
      ) : null}

      {actionError ? (
        <div className="bill-import__notice" role="alert">
          <p className="bill-dialog__error">{actionError}</p>
        </div>
      ) : null}

      <div className="bill-import__actions">
        {canChange ? (
          <button
            type="button"
            className="flow-btn flow-btn-primary"
            disabled={busy || !live.plan.save}
            onClick={openCommit}
          >
            Commit
          </button>
        ) : null}
        {failedCount ? (
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            disabled={failedFile.isPending}
            onClick={downloadFailed}
          >
            Download failed rows
          </button>
        ) : null}
        {session.status === "open" && mayAct ? (
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            disabled={busy}
            onClick={() => setAbandoning(true)}
          >
            Abandon
          </button>
        ) : null}
      </div>
      {canChange && !live.plan.save ? (
        <p className="fset__cardsub bill-import__reason">
          Nothing to save yet — no row is ready and no change is overridden.
        </p>
      ) : null}

      <div className="bill-import__filters">
        <div className="bill-views bill-import__chips" role="group" aria-label="Show rows">
          <button
            type="button"
            aria-pressed={!current}
            className={`bill-views__tab${!current ? " bill-views__tab--on" : ""}`}
            onClick={() => setFilters({ [facet]: "" })}
          >
            All · {counts ? counts[facet].all : "…"}
          </button>
          {counts
            ? ordered(counts[facet], facetText).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={current === key}
                  className={`bill-views__tab${current === key ? " bill-views__tab--on" : ""}`}
                  onClick={() => setFilters({ [facet]: key })}
                >
                  {labelOf(key, facetText)} · {counts[facet][key]}
                </button>
              ))
            : null}
        </div>
        <div className="bill-form">
          <div className="fset__field">
            <label htmlFor={`${formId}-sheet`}>Sheet</label>
            <select
              id={`${formId}-sheet`}
              className="jb-assign"
              value={filters.sheet}
              onChange={(e) => setFilters({ sheet: e.target.value })}
            >
              <option value="">All sheets{counts ? ` (${counts.sheet.all})` : ""}</option>
              {sheetOptions.map((name) => (
                <option key={name} value={name}>
                  {name} ({counts.sheet[name]})
                </option>
              ))}
            </select>
          </div>
          <div className="fset__field">
            <label htmlFor={`${formId}-q`}>Search</label>
            <input
              id={`${formId}-q`}
              type="search"
              className="jb-assign"
              placeholder="Code or name"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
      </div>

      {bulkShown ? (
        <div className="bill-import__bulk" role="group" aria-label="Decide every row shown">
          <span className="flow-muted">
            {plural(counts.status.override, "row")} matching this view{" "}
            {counts.status.override === 1 ? "needs" : "need"} an override ·{" "}
            {counts.decision.pending} undecided
          </span>
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini"
            disabled={busy}
            onClick={() => decideAll("override")}
          >
            Override all
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            disabled={busy}
            onClick={() => decideAll("keep")}
          >
            Keep all
          </button>
        </div>
      ) : null}

      {rowsQuery.isError ? (
        <div className="bill-import__notice" role="alert">
          <p className="bill-dialog__error">
            {requestErrorOf(rowsQuery.error, "Could not load the rows")}
          </p>
          {filtered ? (
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setFilters({ status: "", outcome: "", sheet: "", q: "" })}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : !data ? (
        <p className="fset__cardsub">Loading rows…</p>
      ) : data.rows.length ? (
        <>
          <ImportRows
            rows={data.rows}
            committed={committed}
            mayDecide={canChange}
            busy={busy}
            onDecide={onDecide}
            highlight={filters.row ? Number(filters.row) : null}
            parentLink={parentLink}
          />
          <Pager data={data} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : (
        <div className="fset__cardsub">
          No row matches.{" "}
          {filtered ? (
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setFilters({ status: "", outcome: "", sheet: "", q: "" })}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      )}

      <CommitDialog
        open={confirming && open}
        session={session}
        busy={commit.isPending}
        error={commitError}
        onCancel={() => setConfirming(false)}
        onConfirm={commitNow}
      />
      <ConfirmModal
        open={abandoning}
        title={`Abandon ${session.file_name}?`}
        message={`The uploaded file and its ${plural(totalRows, "row")} are deleted. Nothing from it is saved to Scribe.`}
        confirmLabel="Abandon import"
        cancelLabel="Keep working"
        busy={abandon.isPending}
        onConfirm={abandonNow}
        onCancel={() => setAbandoning(false)}
      />
    </section>
  );
}
