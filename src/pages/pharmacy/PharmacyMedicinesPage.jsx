import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { MEDICINE_TYPES } from "../../../shared/medicineTypes";
import { REGISTER_SCHEDULES, SCHEDULE_LABEL } from "../../../shared/pharmacyVocab";
import { rupees } from "../../components/billing/format";
import MasterListPage from "../../components/pharmacy/MasterListPage";
import MedicineDialog from "../../components/pharmacy/MedicineDialog";
import { useMedicineList, useSetMedicineActive } from "../../queries/hooks/usePharmacyMedicines";
import { SelectInput, optionsOf } from "../../components/pharmacy/Fields";
import { Pill } from "../../components/pharmacy/Pills";
import useUrlState, { asFlag } from "../../hooks/useUrlState";
import SheetImportButton from "../../components/pharmacy/SheetImportButton";
import { medicineKeys } from "../../queries/hooks/usePharmacyMedicines";
import { fileSheetSource } from "../../queries/hooks/usePharmacySheets";

const sheetSource = fileSheetSource("/api/pharmacy/medicines");

const hooks = { useList: useMedicineList, useSetActive: useSetMedicineActive };

const units = (n, label) =>
  n === null || n === undefined ? "—" : `${Number(n).toLocaleString("en-IN")} ${label}`;

const COLUMNS = [
  {
    header: "Medicine",
    render: (m) => (
      <>
        <span className="phs-item">
          {m.name}
          {m.needs_review ? (
            <span className="bill-status phs-badge phs-badge--review phv-badge">Needs review</span>
          ) : null}
        </span>
        <span className="phs-meta">
          {[m.code, m.generic_name, m.manufacturer].filter(Boolean).join(" · ")}
        </span>
      </>
    ),
  },
  {
    header: "Pack",
    render: (m) => (
      <>
        {m.form} · {m.pack_label} of {m.pack_size} {m.unit_label}
      </>
    ),
  },
  {
    header: "GST",
    className: "phs-num",
    render: (m) => (
      <>
        {Number(m.gst_rate_pct)}%
        <span className="phs-meta">{m.hsn_code ? `HSN ${m.hsn_code}` : "HSN not set"}</span>
      </>
    ),
  },
  {
    header: "Schedule",
    render: (m) =>
      m.schedule === "none" ? (
        <span className="phs-meta">—</span>
      ) : (
        <span
          className={`bill-status phs-badge phs-badge--${REGISTER_SCHEDULES.includes(m.schedule) ? "out" : "review"}`}
        >
          {SCHEDULE_LABEL[m.schedule]}
        </span>
      ),
  },
  {
    header: "MRP / sale rate",
    className: "phs-num",
    render: (m) => (
      <>
        {m.default_mrp ? rupees(m.default_mrp) : "—"}
        <span className="phs-meta">
          {m.default_sale_rate ? `Sale ${rupees(m.default_sale_rate)}` : "Sale rate not set"} per{" "}
          {m.pack_label}
        </span>
      </>
    ),
  },
  {
    header: "Min / max stock",
    className: "phs-num",
    render: (m) => (
      <>
        {units(m.min_stock_units, m.unit_label)}
        <span className="phs-meta">Max {units(m.max_stock_units, m.unit_label)}</span>
      </>
    ),
  },
  { header: "Rack", render: (m) => m.default_rack ?? <span className="phs-meta">—</span> },
];

function ImportActions() {
  return (
    <SheetImportButton
      label="Import from Excel"
      title="Import medicines from Excel"
      intro="Download the sheet, add or change medicines, then upload it. Nothing is saved until you check the rows and confirm."
      noun="medicine"
      source={sheetSource}
      sample={{
        url: "/api/pharmacy/medicines/sample.xlsx",
        name: "pharmacy-medicines-sample.xlsx",
      }}
      template={{ url: "/api/pharmacy/medicines/sheet.xlsx", name: "pharmacy-medicines.xlsx" }}
      problemsName="pharmacy-medicines-to-fix.xlsx"
      invalidate={[medicineKeys.all]}
    />
  );
}

export default function PharmacyMedicinesPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const [form, setForm] = useUrlState("form", "");
  const [schedule, setSchedule] = useUrlState("schedule", "");
  const [review, setReview] = useUrlState("review", false, asFlag);
  const filters = {
    ...(form ? { form } : {}),
    ...(schedule ? { schedule } : {}),
    ...(review ? { review: true } : {}),
  };

  return (
    <MasterListPage
      title="Medicines"
      subtitle="The pharmacy's medicine list: pack, tax, price and stock levels."
      noun="medicine"
      plural="medicines"
      searchPlaceholder="Search by name, generic name, manufacturer or code"
      columns={COLUMNS}
      hooks={hooks}
      canManage={hasCapability(role, CAPABILITIES.PHARMACY_MASTER)}
      Dialog={MedicineDialog}
      headerActions={<ImportActions />}
      filters={filters}
      filtersActive={Boolean(form || schedule || review)}
      onClearFilters={() => {
        setForm("");
        setSchedule("");
        setReview(false);
      }}
      filterControls={
        <>
          <label className="sr-only" htmlFor="phm-form-filter" id="phm-form-filter-label">
            Filter by form
          </label>
          <SelectInput
            id="phm-form-filter"
            className="phm-filter"
            value={form}
            onChange={setForm}
            options={[
              { value: "", label: "All forms" },
              ...MEDICINE_TYPES.map((t) => ({ value: t, label: t })),
            ]}
          />
          <label className="sr-only" htmlFor="phm-schedule-filter" id="phm-schedule-filter-label">
            Filter by schedule
          </label>
          <SelectInput
            id="phm-schedule-filter"
            className="phm-filter"
            value={schedule}
            onChange={setSchedule}
            options={[{ value: "", label: "All schedules" }, ...optionsOf(SCHEDULE_LABEL)]}
          />
          <Pill pressed={review} onClick={() => setReview((r) => !r)}>
            Needs review
          </Pill>
        </>
      }
      statusMessages={{
        deactivate:
          "The medicine can no longer be bought or sold. Stock already on the shelf and past bills are not changed. You can activate it again at any time.",
        activate: "The medicine can be bought and sold again.",
      }}
    />
  );
}
