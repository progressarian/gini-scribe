import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../../services/api.js";
import useDebounced from "../../hooks/useDebounced.js";
import { downloadFile } from "../../lib/downloadBlob.js";
import ConfirmModal from "../ui/ConfirmModal.jsx";
import ListPager from "./ListPager.jsx";
import { errorText } from "./import/importText.js";

const dateText = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

export default function AssignmentsPanel() {
  const navigate = useNavigate();
  const [owner, setOwner] = useState("unassigned");
  const [territory, setTerritory] = useState("");
  const [q, setQ] = useState("");
  const term = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkTo, setBulkTo] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [owner, territory, term]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get("/api/crm/assignments", { params: { owner, territory, q: term, page } })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load the doctors.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [owner, territory, term, page, reload]);

  const staff = data?.staff || [];
  const nameOf = (id) => staff.find((s) => s.id === id)?.full_name;

  const save = async (doctorIds, executiveId, label) => {
    setBusy(label);
    setNotice(null);
    setErr(null);
    try {
      const { data: r } = await api.post("/api/crm/assignments", {
        doctor_ids: doctorIds,
        executive_id: executiveId || null,
      });
      const who = r.owner || "no owner";
      setNotice(
        `${r.changed} doctor${r.changed === 1 ? "" : "s"} now ${r.owner ? `assigned to ${who}` : "unassigned"}` +
          (r.unchanged ? ` · ${r.unchanged} already were` : ""),
      );
      setSelected(new Set());
      setBulkTo("");
      setReload((n) => n + 1);
    } catch (e) {
      setErr(errorText(e, "Unable to change the owner."));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const pageIds = (data?.rows || []).map((r) => r.doctor_id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const exportList = async () => {
    setBusy("export");
    setErr(null);
    try {
      const params = new URLSearchParams({ owner, territory, q: term });
      await downloadFile(
        `/api/crm/assignments/export.xlsx?${params}`,
        `crm-assignments-${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
    } catch (e) {
      setErr(errorText(e, "Unable to export the list."));
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts;
  const chips = [
    { key: "unassigned", label: "Unassigned", n: counts?.unassigned },
    ...(counts?.by_owner || []).map((o) => ({ key: o.id, label: o.full_name, n: o.n })),
    { key: "all", label: "All", n: counts?.total },
  ];

  return (
    <section className="asg" aria-label="Doctor assignments">
      <div className="rep__chips asg__counts" role="group" aria-label="Filter by owner">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`rep__chip ${owner === c.key ? "rep__chip--on" : ""} ${c.key === "unassigned" && c.n ? "rep__chip--gap" : ""}`}
            aria-pressed={owner === c.key}
            onClick={() => setOwner(c.key)}
          >
            {c.label} <strong>{c.n ?? "–"}</strong>
          </button>
        ))}
      </div>

      <div className="asg__filters">
        <label className="asg__field">
          <span className="asg__sr">Search doctors</span>
          <input
            className="rep__input"
            type="search"
            maxLength={100}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by doctor name, mobile, area or specialty"
          />
        </label>
        <label className="asg__field asg__field--narrow">
          <span className="asg__sr">Territory</span>
          <select
            className="rep__input"
            value={territory}
            onChange={(e) => setTerritory(e.target.value)}
          >
            <option value="">All territories</option>
            {(data?.territories || []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rep__btn"
          onClick={exportList}
          disabled={busy !== null || !data?.total}
        >
          {busy === "export" ? "Exporting…" : "Export to Excel"}
        </button>
      </div>

      {notice && (
        <div className="rep__toast" role="status">
          {notice}
        </div>
      )}
      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="rep__bulk asg__bulk">
          <span className="rep__hint">{selected.size} selected</span>
          {selected.size > 100 && (
            <span className="rep__err asg__limit">Select at most 100 at a time</span>
          )}
          <label className="asg__field asg__field--narrow">
            <span className="asg__sr">Assign selected to</span>
            <select
              className="rep__input"
              value={bulkTo}
              onChange={(e) => setBulkTo(e.target.value)}
            >
              <option value="">Assign to…</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
              <option value="none">Remove owner</option>
            </select>
          </label>
          <button
            type="button"
            className="rep__btn rep__btn--primary rep__btn--sm"
            disabled={!bulkTo || busy !== null || selected.size > 100}
            onClick={() => setConfirm({ ids: [...selected], to: bulkTo })}
          >
            Apply
          </button>
          <button
            type="button"
            className="rep__btn rep__btn--ghost rep__btn--sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      <div className="asg__head">
        <label className="rep__check asg__all">
          <input
            type="checkbox"
            checked={allOnPage}
            disabled={!pageIds.length}
            onChange={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                pageIds.forEach((id) => (allOnPage ? next.delete(id) : next.add(id)));
                return next;
              })
            }
          />
          Select this page
        </label>
        {data && (
          <span className="rep__hint">
            {data.total} doctor{data.total === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <ul className="rep__list" aria-busy={loading}>
        {loading &&
          !data &&
          Array.from({ length: 5 }, (_, i) => <li key={i} className="rep__row asg__skeleton" />)}
        {data?.rows.map((r) => (
          <li key={r.doctor_id} className="rep__row">
            <input
              type="checkbox"
              className="asg__check"
              checked={selected.has(r.doctor_id)}
              onChange={() => toggle(r.doctor_id)}
              aria-label={`Select ${r.full_name}`}
            />
            <div className="rep__row-main">
              <strong>
                <button
                  type="button"
                  className="rep__name"
                  onClick={() => navigate(`/crm/doctor/${r.doctor_id}`)}
                >
                  {r.full_name}
                </button>
              </strong>
              <span className="rep__row-sub">
                {[r.specialty, r.area, r.territory, r.mobile].filter(Boolean).join(" · ") ||
                  "No details yet"}
              </span>
              <span className="rep__row-sub">
                {r.owner_id
                  ? `Since ${dateText(r.assigned_at)}${r.assigned_by ? ` · by ${r.assigned_by}` : ""}`
                  : "Not assigned"}
              </span>
            </div>
            <label className="asg__owner">
              <span className="asg__sr">Owner of {r.full_name}</span>
              <select
                className={`rep__input ${r.owner_id ? "" : "asg__owner--none"}`}
                value={r.owner_id || ""}
                disabled={busy !== null}
                onChange={(e) =>
                  save(
                    [r.doctor_id],
                    e.target.value === "none" ? null : e.target.value,
                    r.doctor_id,
                  )
                }
              >
                <option value="" disabled>
                  Unassigned
                </option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
                {r.owner_id && <option value="none">Remove owner</option>}
              </select>
              {busy === r.doctor_id && <span className="rep__hint">Saving…</span>}
            </label>
          </li>
        ))}
        {!loading && data?.rows.length === 0 && (
          <li className="rep__empty">
            {term || territory
              ? "No doctors match these filters."
              : owner === "unassigned"
                ? "Every doctor has an owner."
                : "No doctors here."}
            {(term || territory) && (
              <button
                type="button"
                className="asg__link"
                onClick={() => {
                  setQ("");
                  setTerritory("");
                }}
              >
                Clear filters
              </button>
            )}
          </li>
        )}
      </ul>

      <ListPager page={data?.page} pages={data?.pages} loading={loading} onPage={setPage} />

      <ConfirmModal
        open={!!confirm}
        variant="primary"
        title={
          confirm?.to === "none"
            ? `Remove the owner from ${confirm?.ids.length} doctors?`
            : `Assign ${confirm?.ids.length} doctors to ${nameOf(confirm?.to) || ""}?`
        }
        message={
          confirm?.to === "none"
            ? "They will become unassigned and disappear from their current owner's list. The history is kept."
            : `They move to ${nameOf(confirm?.to) || "this person"}'s list and leave their current owner's list. The history is kept.`
        }
        confirmLabel={confirm?.to === "none" ? "Remove owner" : "Assign"}
        busy={busy === "bulk"}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          await save(c.ids, c.to === "none" ? null : c.to, "bulk");
        }}
      />
    </section>
  );
}
