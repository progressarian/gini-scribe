import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "../../stores/uiStore";
import { requestErrorOf } from "../billing/format";
import Pagination from "../ui/Pagination";
import ConfirmModal from "../ui/ConfirmModal";
import "../../styles/flow.css";
import "../../pages/flow/FlowSettings.css";
import "../../pages/billing/billing.css";
import "../../pages/billing/billingUi.css";
import "../../pages/pharmacy/pharmacyStock.css";
import "../../pages/pharmacy/pharmacyVendors.css";
import PillGroup from "./Pills";
import useUrlState, { useUrlSearch, asNumber } from "../../hooks/useUrlState";

const STATUSES = [
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "all", label: "All" },
];

export default function MasterListPage({
  title,
  subtitle,
  noun,
  plural,
  searchPlaceholder,
  columns,
  hooks,
  canManage,
  Dialog,
  filters = {},
  filterControls = null,
  filtersActive = false,
  onClearFilters,
  statusMessages,
  rowActions,
  canToggle = () => true,
}) {
  const { search, setSearch, q, clear: clearSearch } = useUrlSearch("q", () => setPage(1));
  const [status, setStatus] = useUrlState("status", "active");
  const [page, setPage] = useUrlState("page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("size", 25, asNumber);
  const [editing, setEditing] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [toggleError, setToggleError] = useState("");
  const setActive = hooks.useSetActive();

  const filtersKey = JSON.stringify(filters);
  const shownFilters = useRef(filtersKey);
  useEffect(() => {
    if (shownFilters.current === filtersKey) return;
    shownFilters.current = filtersKey;
    setPage(1);
  }, [filtersKey]);

  const list = hooks.useList({
    ...(q ? { q } : {}),
    status,
    ...filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const filtered = Boolean(q) || status !== "active" || filtersActive;

  const clearFilters = () => {
    clearSearch();
    setStatus("active");
    setPage(1);
    onClearFilters?.();
  };

  const confirmToggle = async () => {
    setToggleError("");
    try {
      const saved = await setActive.mutateAsync({
        id: toggling.id,
        is_active: !toggling.is_active,
      });
      toast(saved.is_active ? `${saved.name} is active again.` : `${saved.name} deactivated.`);
      setToggling(null);
    } catch (err) {
      setToggleError(requestErrorOf(err, `Could not change the ${noun} status`));
    }
  };

  const listId = `${noun.replace(/\s/g, "-")}-list-title`;

  return (
    <div className="flow-root fset bill-ui phs">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">{title}</h1>
          {subtitle ? <p className="phs-sub">{subtitle}</p> : null}
        </div>
        {canManage ? (
          <div className="phs-head__acts">
            <button
              type="button"
              className="flow-btn flow-btn-primary phs-upload"
              onClick={() => setEditing({})}
            >
              <Plus size={15} aria-hidden="true" />
              Add {noun}
            </button>
          </div>
        ) : null}
      </header>

      <section className="flow-card" aria-labelledby={listId}>
        <div className="fset__cardhead">
          <h2 id={listId} className="flow-sec-title">
            {title} list
          </h2>
          <span className="fset__count">{total}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor={`${listId}-search`}>
            Search {plural}
          </label>
          <input
            id={`${listId}-search`}
            type="search"
            className="jb-assign phs-search"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {filterControls}
          <PillGroup
            label={`Filter ${plural} by status`}
            value={status}
            options={STATUSES}
            onChange={(key) => {
              setStatus(key);
              setPage(1);
            }}
          />
        </div>

        {list.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load {plural}. Please try again.</p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => list.refetch()}
            >
              Try again
            </button>
          </div>
        ) : list.isLoading ? (
          <p className="phs-empty" role="status">
            Loading {plural}…
          </p>
        ) : !rows.length ? (
          <div className="phs-empty">
            {filtered ? (
              <>
                <p>No {plural} match the current filters.</p>
                <button type="button" className="flow-btn flow-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p>No {plural} added yet.</p>
                {canManage ? (
                  <button
                    type="button"
                    className="flow-btn flow-btn-primary"
                    onClick={() => setEditing({})}
                  >
                    Add {noun}
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table" aria-label={title}>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.header} className={c.className}>
                        {c.header}
                      </th>
                    ))}
                    <th>Status</th>
                    {canManage ? <th className="phv-actions-head">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.is_active ? "" : "phs-row--out"}>
                      {columns.map((c) => (
                        <td key={c.header} data-label={c.header} className={c.className}>
                          {c.render(r)}
                        </td>
                      ))}
                      <td data-label="Status">
                        <span
                          className={`bill-status phs-badge phs-badge--${r.is_active ? "ok" : "out"}`}
                        >
                          {r.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      {canManage ? (
                        <td data-label="Actions" className="phv-actions">
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini"
                            onClick={() => setEditing(r)}
                            aria-label={`Edit ${r.name}`}
                          >
                            Edit
                          </button>
                          {rowActions?.(r)}
                          {canToggle(r) ? (
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost flow-btn-mini"
                              onClick={() => {
                                setToggleError("");
                                setToggling(r);
                              }}
                              aria-label={`${r.is_active ? "Deactivate" : "Activate"} ${r.name}`}
                            >
                              {r.is_active ? "Deactivate" : "Activate"}
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              disabled={list.isFetching}
              unit={plural}
            />
          </>
        )}
      </section>

      {editing ? (
        <Dialog
          key={editing.id ?? "new"}
          record={editing.id ? editing : null}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmModal
        open={Boolean(toggling)}
        title={
          toggling?.is_active ? `Deactivate ${toggling?.name}?` : `Activate ${toggling?.name}?`
        }
        message={toggling?.is_active ? statusMessages.deactivate : statusMessages.activate}
        confirmLabel={toggling?.is_active ? `Deactivate ${noun}` : `Activate ${noun}`}
        variant={toggling?.is_active ? "danger" : "primary"}
        busy={setActive.isPending}
        error={toggleError}
        onConfirm={confirmToggle}
        onCancel={() => setToggling(null)}
      />
    </div>
  );
}
