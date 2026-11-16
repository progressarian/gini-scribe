import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { requestErrorOf } from "../../components/billing/format";
import Pagination from "../../components/ui/Pagination";
import ConfirmModal from "../../components/ui/ConfirmModal";
import VendorDialog from "../../components/pharmacy/VendorDialog";
import { useSetVendorActive, useVendorList } from "../../queries/hooks/usePharmacyVendors";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";

const STATUSES = [
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "all", label: "All" },
];

const LICENCE_WARN_DAYS = 30;

const localDate = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const showDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

function LicenceCell({ vendor }) {
  if (!vendor.drug_license_no && !vendor.drug_license_expiry) {
    return <span className="phs-meta">Not recorded</span>;
  }
  const expiry = vendor.drug_license_expiry;
  const expired = expiry && expiry < localDate();
  const soon = !expired && expiry && expiry <= localDate(LICENCE_WARN_DAYS);
  return (
    <>
      <span className="phv-mono">{vendor.drug_license_no ?? "Number not recorded"}</span>
      {expiry ? (
        <span className="phs-meta">
          Valid till {showDate(expiry)}
          {expired ? (
            <span className="bill-status phs-badge phs-badge--out phv-badge">Licence expired</span>
          ) : soon ? (
            <span className="bill-status phs-badge phs-badge--review phv-badge">Expires soon</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

export default function PharmacyVendorsPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canManage = hasCapability(role, CAPABILITIES.PHARMACY_MASTER);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [editing, setEditing] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [toggleError, setToggleError] = useState("");
  const setActive = useSetVendorActive();

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useVendorList({
    ...(q ? { q } : {}),
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const vendors = list.data?.vendors ?? [];
  const total = list.data?.total ?? 0;
  const filtered = Boolean(q) || status !== "active";

  const clearFilters = () => {
    setSearch("");
    setQ("");
    setStatus("active");
    setPage(1);
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
      setToggleError(requestErrorOf(err, "Could not change the vendor status"));
    }
  };

  return (
    <div className="flow-root fset bill-ui phs">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Vendors</h1>
          <p className="phs-sub">Suppliers the pharmacy buys stock from.</p>
        </div>
        {canManage ? (
          <div className="phs-head__acts">
            <button
              type="button"
              className="flow-btn flow-btn-primary phs-upload"
              onClick={() => setEditing({})}
            >
              <Plus size={15} aria-hidden="true" />
              Add vendor
            </button>
          </div>
        ) : null}
      </header>

      <section className="flow-card" aria-labelledby="phv-list-title">
        <div className="fset__cardhead">
          <h2 id="phv-list-title" className="flow-sec-title">
            Vendor list
          </h2>
          <span className="fset__count">{total}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="phv-search">
            Search vendors
          </label>
          <input
            id="phv-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by vendor, contact, phone, GSTIN or city"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="phs-chips" role="group" aria-label="Filter vendors by status">
            {STATUSES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`phs-chip${status === s.key ? " on" : ""}`}
                aria-pressed={status === s.key}
                onClick={() => {
                  setStatus(s.key);
                  setPage(1);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {list.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load vendors. Please try again.</p>
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
            Loading vendors…
          </p>
        ) : !vendors.length ? (
          <div className="phs-empty">
            {filtered ? (
              <>
                <p>No vendors match the current filters.</p>
                <button type="button" className="flow-btn flow-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p>No vendors added yet.</p>
                {canManage ? (
                  <button
                    type="button"
                    className="flow-btn flow-btn-primary"
                    onClick={() => setEditing({})}
                  >
                    Add vendor
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table" aria-label="Vendors">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Phone</th>
                    <th>GSTIN</th>
                    <th>Drug licence</th>
                    <th className="phs-num">Payment terms</th>
                    <th>Status</th>
                    {canManage ? <th className="phv-actions-head">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v) => (
                    <tr key={v.id} className={v.is_active ? "" : "phs-row--out"}>
                      <td data-label="Vendor">
                        <span className="phs-item">{v.name}</span>
                        {v.contact_person || v.city ? (
                          <span className="phs-meta">
                            {[v.contact_person, v.city].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Phone" className="phv-mono">
                        {v.phone}
                      </td>
                      <td data-label="GSTIN" className="phv-mono">
                        {v.gstin ?? <span className="phs-meta">Not recorded</span>}
                      </td>
                      <td data-label="Drug licence">
                        <LicenceCell vendor={v} />
                      </td>
                      <td data-label="Payment terms" className="phs-num">
                        {v.payment_terms_days ? `${v.payment_terms_days} days` : "On delivery"}
                      </td>
                      <td data-label="Status">
                        <span
                          className={`bill-status phs-badge phs-badge--${v.is_active ? "ok" : "out"}`}
                        >
                          {v.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      {canManage ? (
                        <td data-label="Actions" className="phv-actions">
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini"
                            onClick={() => setEditing(v)}
                            aria-label={`Edit ${v.name}`}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini"
                            onClick={() => {
                              setToggleError("");
                              setToggling(v);
                            }}
                            aria-label={`${v.is_active ? "Deactivate" : "Activate"} ${v.name}`}
                          >
                            {v.is_active ? "Deactivate" : "Activate"}
                          </button>
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
              unit="vendors"
            />
          </>
        )}
      </section>

      {editing ? (
        <VendorDialog
          key={editing.id ?? "new"}
          vendor={editing.id ? editing : null}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmModal
        open={Boolean(toggling)}
        title={
          toggling?.is_active ? `Deactivate ${toggling?.name}?` : `Activate ${toggling?.name}?`
        }
        message={
          toggling?.is_active
            ? "New purchases can no longer be recorded against this vendor. Past purchases and their history stay as they are. You can activate the vendor again at any time."
            : "The vendor can be chosen again when recording new purchases."
        }
        confirmLabel={toggling?.is_active ? "Deactivate vendor" : "Activate vendor"}
        variant={toggling?.is_active ? "danger" : "primary"}
        busy={setActive.isPending}
        error={toggleError}
        onConfirm={confirmToggle}
        onCancel={() => setToggling(null)}
      />
    </div>
  );
}
