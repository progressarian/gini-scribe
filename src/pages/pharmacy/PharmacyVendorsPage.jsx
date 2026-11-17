import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import MasterListPage from "../../components/pharmacy/MasterListPage";
import VendorDialog from "../../components/pharmacy/VendorDialog";
import { showDate, localDate } from "../../components/pharmacy/format";
import { useSetVendorActive, useVendorList } from "../../queries/hooks/usePharmacyVendors";

const LICENCE_WARN_DAYS = 30;

const hooks = { useList: useVendorList, useSetActive: useSetVendorActive };

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

const COLUMNS = [
  {
    header: "Vendor",
    render: (v) => (
      <>
        <span className="phs-item">{v.name}</span>
        {v.contact_person || v.city ? (
          <span className="phs-meta">{[v.contact_person, v.city].filter(Boolean).join(" · ")}</span>
        ) : null}
      </>
    ),
  },
  { header: "Phone", className: "phv-mono", render: (v) => v.phone },
  {
    header: "GSTIN",
    className: "phv-mono",
    render: (v) => v.gstin ?? <span className="phs-meta">Not recorded</span>,
  },
  { header: "Drug licence", render: (v) => <LicenceCell vendor={v} /> },
  {
    header: "Payment terms",
    className: "phs-num",
    render: (v) => (v.payment_terms_days ? `${v.payment_terms_days} days` : "On delivery"),
  },
];

export default function PharmacyVendorsPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  return (
    <MasterListPage
      title="Vendors"
      subtitle="Suppliers the pharmacy buys stock from."
      noun="vendor"
      plural="vendors"
      searchPlaceholder="Search by vendor, contact, phone, GSTIN or city"
      columns={COLUMNS}
      hooks={hooks}
      canManage={hasCapability(role, CAPABILITIES.PHARMACY_MASTER)}
      Dialog={VendorDialog}
      statusMessages={{
        deactivate:
          "New purchases can no longer be recorded against this vendor. Past purchases and their history stay as they are. You can activate the vendor again at any time.",
        activate: "The vendor can be chosen again when recording new purchases.",
      }}
    />
  );
}
