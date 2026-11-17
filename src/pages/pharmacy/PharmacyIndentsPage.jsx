import { useEffect, useState } from "react";
import FormField from "../../components/ui/FormField";
import ConfirmModal from "../../components/ui/ConfirmModal";
import Pagination from "../../components/ui/Pagination";
import StockLinesEditor, { linesForApi } from "../../components/pharmacy/StockLinesEditor";
import { inr, packUnits } from "../../components/pharmacy/format";
import { requestErrorOf } from "../../components/billing/format";
import { toast } from "../../stores/uiStore";
import { useStockLocations } from "../../queries/hooks/usePharmacyBatches";
import ReturnDialog from "../../components/pharmacy/ReturnDialog";
import {
  useCreateIndent,
  useIndent,
  useIndentPatientSearch,
  useIndents,
} from "../../queries/hooks/usePharmacyDepartments";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const when = (value) =>
  new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function PatientChooser({ patient, onChoose, error }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const found = useIndentPatientSearch(q);
  const results = q.length >= 2 ? (found.data ?? []) : [];
  return (
    <fieldset className="phb-fieldset">
      <legend>Patient</legend>
      <FormField
        label="Find patient"
        hint="Search by name, file number or mobile number"
        error={error}
      >
        <input
          type="search"
          className="jb-assign"
          autoComplete="off"
          maxLength={80}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </FormField>
      {q.length >= 2 ? (
        found.isError ? (
          <p className="bill-dialog__error" role="alert">
            Could not search patients. Try again.
          </p>
        ) : found.isLoading ? (
          <p className="phs-meta" role="status">
            Searching…
          </p>
        ) : results.length ? (
          <div className="phb-patients" role="radiogroup" aria-label="Matching patients">
            {results.map((p) => (
              <label key={p.id} className={`phb-patient${patient?.id === p.id ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="indent-patient"
                  checked={patient?.id === p.id}
                  onChange={() => onChoose(p)}
                />
                <span>
                  <span className="phb-patient__name">{p.name}</span>
                  <span className="phs-meta">
                    {[p.file_no, p.phone, [p.age, p.sex].filter(Boolean).join(" ")]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="phs-meta" role="status">
            No patient matches “{q}”.
          </p>
        )
      ) : null}
    </fieldset>
  );
}

function NewIndent({ departments }) {
  const create = useCreateIndent();
  const [locationId, setLocationId] = useState(
    departments.length === 1 ? String(departments[0].id) : "",
  );
  const [patient, setPatient] = useState(null);
  const [ipdNumber, setIpdNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([]);
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState(null);
  const department = departments.find((d) => String(d.id) === locationId);

  const problems = {};
  if (!department) problems.department = "Choose the department giving the medicines.";
  if (!patient) problems.patient = "Choose the patient.";
  if (!lines.length) problems.lines = "Add at least one medicine.";
  const errors = touched ? problems : {};

  const review = () => {
    setTouched(true);
    setError("");
    if (!Object.keys(problems).length) setConfirming(true);
  };

  const submit = async () => {
    try {
      const done = await create.mutateAsync({
        location_id: department.id,
        patient_id: patient.id,
        ipd_number: ipdNumber.trim() || null,
        notes: notes.trim() || null,
        lines: linesForApi(lines, { withNearExpiry: true }),
      });
      toast(
        `${done.indent_no} issued. Bill ${done.bill_no} of ${inr(done.net_amount)} is due at reception.`,
      );
      setIssued(done);
      setLines([]);
      setPatient(null);
      setIpdNumber("");
      setNotes("");
      setTouched(false);
      setConfirming(false);
    } catch (err) {
      setConfirming(false);
      setError(requestErrorOf(err, "Could not issue the indent"));
    }
  };

  return (
    <section className="flow-card" aria-labelledby="pin-new-title">
      <h2 id="pin-new-title" className="flow-sec-title">
        New indent
      </h2>
      {issued ? (
        <p className="phb-credit phb-credit--approved" role="status">
          <span className="phb-credit__note">
            Last issued: {issued.indent_no} for {issued.patient_name} · bill {issued.bill_no} ·{" "}
            {inr(issued.net_amount)} due at reception.
          </span>
        </p>
      ) : null}
      <div className="bill-form">
        <FormField label="Department" required error={errors.department}>
          <select
            className="jb-assign"
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setLines([]);
            }}
          >
            <option value="">Choose</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="IPD number">
          <input
            className="jb-assign"
            maxLength={40}
            value={ipdNumber}
            onChange={(e) => setIpdNumber(e.target.value)}
          />
        </FormField>
      </div>
      <PatientChooser patient={patient} onChoose={setPatient} error={errors.patient} />
      <StockLinesEditor
        locationId={department?.id}
        locationName={department?.name}
        lines={lines}
        onChange={setLines}
        disabled={create.isPending}
      />
      <div className="bill-form">
        <FormField label="Note" className="phv-span-all">
          <input
            className="jb-assign"
            maxLength={300}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>
      </div>
      {errors.lines || error ? (
        <p className="bill-dialog__error" role="alert">
          {error || errors.lines}
        </p>
      ) : null}
      <div className="phb-checkout__acts">
        <button
          type="button"
          className="flow-btn flow-btn-primary"
          disabled={create.isPending}
          onClick={review}
        >
          Issue indent
        </button>
      </div>
      <ConfirmModal
        open={confirming}
        title="Issue this indent?"
        variant="primary"
        confirmLabel={create.isPending ? "Issuing…" : "Issue indent"}
        busy={create.isPending}
        confirmDisabled={create.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
        message={
          <div className="phb-confirm-body">
            <p>
              <strong>{patient?.name}</strong> ({patient?.file_no ?? "—"}) from{" "}
              <strong>{department?.name}</strong>
              {ipdNumber.trim() ? ` · ${ipdNumber.trim()}` : ""}
            </p>
            <ul>
              {lines.map((l) => (
                <li key={l.batch_id}>
                  {l.medicine_name} · {l.batch_no} · {packUnits(l.qty_units, l)}
                </li>
              ))}
            </ul>
            <p>
              The medicines come off {department?.name}&apos;s stock and a pharmacy bill (GST
              included in the rates) is made for the patient to pay at reception.
            </p>
          </div>
        }
      />
    </section>
  );
}

function IndentReturn({ indentId, onClose }) {
  const query = useIndent(indentId);
  if (query.isError) {
    return (
      <ConfirmModal
        open
        title="Could not open the indent"
        message="Unable to load this indent. Please try again."
        confirmLabel="Close"
        variant="primary"
        onConfirm={onClose}
        onCancel={onClose}
      />
    );
  }
  if (!query.data) return null;
  return (
    <ReturnDialog
      bill={query.data.bill}
      returned={query.data.returned_units}
      indentId={indentId}
      onClose={onClose}
      onDone={onClose}
    />
  );
}

function IndentList({ departments }) {
  const [returning, setReturning] = useState(null);
  const [locationId, setLocationId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const query = useIndents({
    ...(locationId ? { location_id: locationId } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = query.data?.rows ?? [];
  return (
    <section className="flow-card" aria-labelledby="pin-list-title">
      <div className="fset__cardhead">
        <h2 id="pin-list-title" className="flow-sec-title">
          Indents
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
      </div>
      <div className="phs-filters">
        <label className="sr-only" htmlFor="pin-filter">
          Show indents for department
        </label>
        <select
          id="pin-filter"
          className="jb-assign phb-filter-select"
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load indents. Please try again.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.isLoading ? (
        <p className="phs-empty" role="status">
          Loading indents…
        </p>
      ) : !rows.length ? (
        <p className="phs-empty">No indents yet.</p>
      ) : (
        <>
          <div className="fset__scroll">
            <table className="flow-table phs-table" aria-label="Indents">
              <thead>
                <tr>
                  <th>Indent</th>
                  <th>Patient</th>
                  <th>Department</th>
                  <th>Bill</th>
                  <th className="phs-num">Amount</th>
                  <th className="phs-num">Due</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Indent">
                      <span className="phv-mono">{r.indent_no}</span>
                      <span className="phs-meta">
                        {when(r.raised_at)}
                        {r.raised_by_name ? ` by ${r.raised_by_name}` : ""}
                      </span>
                    </td>
                    <td data-label="Patient">
                      {r.patient_name}
                      <span className="phs-meta">
                        {[r.patient_file_no, r.ipd_number].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td data-label="Department">{r.location_name}</td>
                    <td data-label="Bill" className="phv-mono">
                      {r.bill_no}
                    </td>
                    <td data-label="Amount" className="phs-num">
                      {inr(r.net_amount)}
                    </td>
                    <td
                      data-label="Due"
                      className={`phs-num${Number(r.due_amount) ? " phb-due" : ""}`}
                    >
                      {Number(r.due_amount) ? inr(r.due_amount) : "Paid"}
                    </td>
                    <td className="phb-line-acts">
                      {Number(r.due_amount) ? (
                        <button
                          type="button"
                          className="flow-btn flow-btn-ghost"
                          aria-label={`Return medicines from ${r.indent_no}`}
                          onClick={() => setReturning(r.id)}
                        >
                          Return
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={query.data?.total ?? 0}
            onChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            disabled={query.isFetching}
            unit="indents"
          />
        </>
      )}
      {returning ? <IndentReturn indentId={returning} onClose={() => setReturning(null)} /> : null}
    </section>
  );
}

export default function PharmacyIndentsPage() {
  const locations = useStockLocations();
  const departments = (locations.data ?? []).filter((l) => l.kind === "department");
  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Department indents</h1>
          <p className="phs-sub">
            Give medicines to a patient from the department&apos;s own stock. The bill goes to
            reception for payment.
          </p>
        </div>
      </header>
      {locations.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load the departments. Please try again.</p>
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => locations.refetch()}
          >
            Try again
          </button>
        </div>
      ) : locations.isLoading ? (
        <p className="phs-empty" role="status">
          Loading…
        </p>
      ) : !departments.length ? (
        <p className="phs-empty">No departments are set up yet. The pharmacy admin adds them.</p>
      ) : (
        <>
          <NewIndent departments={departments} />
          <IndentList departments={departments} />
        </>
      )}
    </div>
  );
}
