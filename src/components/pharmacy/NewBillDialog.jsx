import { useEffect, useState } from "react";
import { UserPlus, Search } from "lucide-react";
import FormField from "../ui/FormField";
import MasterFormDialog from "./MasterFormDialog";
import { digitsTyped, requestErrorOf } from "../billing/format";
import { toast } from "../../stores/uiStore";
import { inr } from "./format";
import { SelectInput } from "./Fields";
import {
  useBillPatientSearch,
  useCreateBill,
  useCreateWalkin,
} from "../../queries/hooks/usePharmacyBills";
import {
  COUNTER_SALE_TYPES,
  SALE_TYPE_LABEL,
  WALKIN_REGISTRATION_SOURCE,
} from "../../../shared/pharmacyVocab";

const SALE_TYPE_HINT = {
  opd: "GST is added on top of the sale rate",
  walkin: "Not a hospital patient. GST is added on top",
  ipd: "Admitted patient. GST is included in the rate and the bill shows 0% GST",
};

const EMPTY_WALKIN = { name: "", phone: "", age: "", sex: "" };

const patientLine = (p) =>
  [p.file_no, p.phone, [p.age, p.sex].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

export default function NewBillDialog({ onCreated, onClose }) {
  const createBill = useCreateBill();
  const createWalkin = useCreateWalkin();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [patient, setPatient] = useState(null);
  const [walkinMode, setWalkinMode] = useState(false);
  const [walkin, setWalkin] = useState(EMPTY_WALKIN);
  const [saleType, setSaleType] = useState("opd");
  const [ipdNumber, setIpdNumber] = useState("");
  const [prescriber, setPrescriber] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const found = useBillPatientSearch(walkinMode ? "" : q);
  const results = q.length >= 2 ? (found.data ?? []) : [];

  const choose = (p) => {
    setPatient(p);
    setSaleType(p.registration_source === WALKIN_REGISTRATION_SOURCE ? "walkin" : "opd");
  };

  const startWalkin = () => {
    setWalkinMode(true);
    setPatient(null);
    setSaleType("walkin");
    const typed = search.trim();
    const digits = digitsTyped(typed);
    if (digits.length >= 10 && digits.length === typed.replace(/[\s+-]/g, "").length) {
      setWalkin({ ...EMPTY_WALKIN, phone: digits.slice(-12) });
    } else if (typed) {
      setWalkin({ ...EMPTY_WALKIN, name: typed });
    }
  };

  const problems = {};
  if (walkinMode) {
    if (walkin.name.trim().length < 2) problems.name = "Enter the customer's name.";
    if (!/^\d{10,12}$/.test(walkin.phone)) problems.phone = "Enter a 10-digit mobile number.";
    if (walkin.age && Number(walkin.age) > 130) problems.age = "Enter an age up to 130.";
  } else if (!patient) {
    problems.patient = "Choose the patient, or add a walk-in customer.";
  }
  if (saleType === "ipd" && !ipdNumber.trim()) problems.ipd = "Enter the IPD number.";
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      let chosen = patient;
      if (walkinMode) {
        const made = await createWalkin.mutateAsync({
          name: walkin.name.trim(),
          phone: walkin.phone,
          age: walkin.age || null,
          sex: walkin.sex || null,
        });
        chosen = made.patient;
        if (made.existing) toast(`${chosen.name} was already registered (${chosen.file_no}).`);
      }
      const bill = await createBill.mutateAsync({
        patient_id: chosen.id,
        sale_type: saleType,
        ipd_number: saleType === "ipd" ? ipdNumber.trim() : null,
        prescriber_name: prescriber.trim() || null,
      });
      onCreated(bill);
    } catch (err) {
      setError(requestErrorOf(err, "Could not start the bill"));
    }
  };

  const busy = createBill.isPending || createWalkin.isPending;

  return (
    <MasterFormDialog
      title="New pharmacy bill"
      dirty={Boolean(patient || search || walkin.name || walkin.phone)}
      busy={busy}
      error={error}
      submitLabel="Start bill"
      onSubmit={submit}
      onClose={onClose}
    >
      {walkinMode ? (
        <fieldset className="phb-fieldset">
          <legend>Walk-in customer</legend>
          <p className="phs-meta">
            Gets a temporary GNI file number. When they book an appointment with the same mobile
            number, the hospital record takes it over.
          </p>
          <div className="bill-form">
            <FormField label="Name" required error={errors.name}>
              <input
                className="jb-assign"
                maxLength={120}
                autoFocus
                value={walkin.name}
                onChange={(e) => setWalkin({ ...walkin, name: e.target.value })}
              />
            </FormField>
            <FormField label="Mobile number" required error={errors.phone}>
              <input
                className="jb-assign"
                inputMode="numeric"
                maxLength={12}
                value={walkin.phone}
                onChange={(e) => setWalkin({ ...walkin, phone: digitsTyped(e.target.value) })}
              />
            </FormField>
            <FormField label="Age" error={errors.age}>
              <input
                className="jb-assign"
                inputMode="numeric"
                maxLength={3}
                value={walkin.age}
                onChange={(e) => setWalkin({ ...walkin, age: digitsTyped(e.target.value) })}
              />
            </FormField>
            <FormField label="Sex">
              <SelectInput
                value={walkin.sex}
                onChange={(sex) => setWalkin({ ...walkin, sex })}
                options={[
                  { value: "", label: "Not given" },
                  { value: "Male", label: "Male" },
                  { value: "Female", label: "Female" },
                  { value: "Other", label: "Other" },
                ]}
              />
            </FormField>
          </div>
          <button
            type="button"
            className="flow-btn flow-btn-ghost phb-switch"
            onClick={() => {
              setWalkinMode(false);
              setSaleType("opd");
            }}
          >
            <Search size={14} aria-hidden="true" />
            Search registered patients instead
          </button>
        </fieldset>
      ) : (
        <fieldset className="phb-fieldset">
          <legend>Patient</legend>
          <FormField
            label="Find patient"
            hint="Search by name, file number or mobile number"
            error={errors.patient}
          >
            <input
              type="search"
              className="jb-assign"
              autoFocus
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
                  <label
                    key={p.id}
                    className={`phb-patient${patient?.id === p.id ? " is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="bill-patient"
                      checked={patient?.id === p.id}
                      onChange={() => choose(p)}
                    />
                    <span>
                      <span className="phb-patient__name">{p.name}</span>
                      <span className="phs-meta">{patientLine(p)}</span>
                    </span>
                    {p.today_visit_id ? <span className="phb-tag">Visit today</span> : null}
                    {Number(p.pharmacy_due) > 0 ? (
                      <span className="phb-tag phb-tag--due">Due {inr(p.pharmacy_due)}</span>
                    ) : null}
                    {p.registration_source === WALKIN_REGISTRATION_SOURCE ? (
                      <span className="phb-tag">Walk-in</span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : (
              <p className="phs-meta" role="status">
                No patient matches “{q}”.
              </p>
            )
          ) : null}
          <button
            type="button"
            className="flow-btn flow-btn-ghost phb-switch"
            onClick={startWalkin}
          >
            <UserPlus size={14} aria-hidden="true" />
            New walk-in customer
          </button>
        </fieldset>
      )}

      <fieldset className="phb-fieldset">
        <legend>Sale type</legend>
        <div className="phb-saletypes" role="radiogroup" aria-label="Sale type">
          {COUNTER_SALE_TYPES.map((type) => (
            <label key={type} className={`phb-saletype${saleType === type ? " is-on" : ""}`}>
              <input
                type="radio"
                name="bill-sale-type"
                value={type}
                checked={saleType === type}
                onChange={() => setSaleType(type)}
              />
              <span>
                <span className="phb-patient__name">{SALE_TYPE_LABEL[type]}</span>
                <span className="phs-meta">{SALE_TYPE_HINT[type]}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="bill-form">
          {saleType === "ipd" ? (
            <FormField label="IPD number" required error={errors.ipd}>
              <input
                className="jb-assign"
                maxLength={40}
                value={ipdNumber}
                onChange={(e) => setIpdNumber(e.target.value)}
              />
            </FormField>
          ) : null}
          <FormField label="Prescribed by" hint="Needed when a Schedule H1 medicine is sold">
            <input
              className="jb-assign"
              maxLength={120}
              value={prescriber}
              onChange={(e) => setPrescriber(e.target.value)}
            />
          </FormField>
        </div>
      </fieldset>
    </MasterFormDialog>
  );
}
