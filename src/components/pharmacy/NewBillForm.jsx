import { useEffect, useId, useRef, useState } from "react";
import { UserPlus, Search } from "lucide-react";
import FormField from "../ui/FormField";
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
  ipd: "Admitted patient. Same total as OPD; the bill shows one all-in rate per item",
};

const EMPTY_WALKIN = { name: "", phone: "", age: "", sex: "" };

const patientLine = (p) =>
  [p.file_no, p.phone, [p.age, p.sex].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

export default function NewBillForm({ onCreated, onCancel }) {
  const titleId = useId();
  const formRef = useRef(null);
  const resultsRef = useRef(null);
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

  const problemsFor = (picked) => {
    const found = {};
    if (walkinMode) {
      if (walkin.name.trim().length < 2) found.name = "Enter the customer's name.";
      if (!/^\d{10,12}$/.test(walkin.phone)) found.phone = "Enter a 10-digit mobile number.";
      if (walkin.age && Number(walkin.age) > 130) found.age = "Enter an age up to 130.";
    } else if (!picked) {
      found.patient = "Choose the patient, or add a walk-in customer.";
    }
    if (saleType === "ipd" && !ipdNumber.trim()) found.ipd = "Enter the IPD number.";
    return found;
  };
  const errors = touched ? problemsFor(patient) : {};
  const busy = createBill.isPending || createWalkin.isPending;

  const submit = async (e, picked = patient) => {
    e?.preventDefault();
    setTouched(true);
    setError("");
    if (busy || Object.keys(problemsFor(picked)).length) return;
    try {
      let chosen = picked;
      const type =
        picked && picked !== patient
          ? picked.registration_source === WALKIN_REGISTRATION_SOURCE
            ? "walkin"
            : "opd"
          : saleType;
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
        sale_type: type,
        ipd_number: type === "ipd" ? ipdNumber.trim() : null,
        prescriber_name: prescriber.trim() || null,
      });
      onCreated(bill);
    } catch (err) {
      setError(requestErrorOf(err, "Could not start the bill"));
    }
  };

  const radios = () => [...(resultsRef.current?.querySelectorAll('input[type="radio"]') ?? [])];

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      choose(results[0]);
      radios()[0]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results.length === 1) {
        choose(results[0]);
        submit(null, results[0]);
      } else if (patient) {
        submit(null);
      } else if (results.length) {
        choose(results[0]);
        radios()[0]?.focus();
      }
    }
  };

  const submitOnEnter = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    formRef.current?.requestSubmit();
  };

  return (
    <form
      ref={formRef}
      className="flow-card phb-newbill"
      aria-labelledby={titleId}
      onSubmit={submit}
      noValidate
    >
      <h2 id={titleId} className="flow-sec-title">
        Patient and sale type
      </h2>
      <p className="phs-meta phb-newbill__keys">
        Type to search, ↓ to move into the results, ↑/↓ to choose, Enter to start the bill.
      </p>
      {walkinMode ? (
        <fieldset className="phb-section">
          <legend>Walk-in customer</legend>
          <p className="phs-meta phb-section__intro">
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
        <fieldset className="phb-section">
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
              onChange={(e) => {
                setSearch(e.target.value);
                setPatient(null);
              }}
              onKeyDown={onSearchKey}
            />
          </FormField>
          {q.length < 2 ? null : found.isError ? (
            <p className="bill-dialog__error" role="alert">
              Could not search patients. Try again.
            </p>
          ) : found.isLoading ? (
            <p className="phs-meta" role="status">
              Searching…
            </p>
          ) : results.length ? (
            <>
              <div
                ref={resultsRef}
                className="phb-patients"
                role="radiogroup"
                aria-label="Matching patients"
              >
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
                      onKeyDown={submitOnEnter}
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
              <div className="phb-more">
                <span className="phs-meta" role="status">
                  Showing {results.length} {results.length === 1 ? "patient" : "patients"}
                  {found.hasNextPage ? "" : ", all matches"}
                </span>
                {found.hasNextPage ? (
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost"
                    disabled={found.isFetchingNextPage}
                    onClick={() => found.fetchNextPage()}
                  >
                    {found.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="phs-meta" role="status">
              No patient matches “{q}”.
            </p>
          )}
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

      <fieldset className="phb-section">
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
                onKeyDown={submitOnEnter}
              />
              <span>
                <span className="phb-patient__name">{SALE_TYPE_LABEL[type]}</span>
                <span className="phs-meta">{SALE_TYPE_HINT[type]}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="bill-form phb-section__fields">
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
          <FormField
            label="Prescribed by"
            hint="Needed when a Schedule H1 medicine is sold"
            className="phb-section__wide"
          >
            <input
              className="jb-assign"
              maxLength={120}
              value={prescriber}
              onChange={(e) => setPrescriber(e.target.value)}
            />
          </FormField>
        </div>
      </fieldset>

      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="phb-checkout__acts">
        <button type="button" className="flow-btn flow-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
          {busy ? "Starting…" : "Start bill"}
        </button>
      </div>
    </form>
  );
}
