import { useEffect, useState } from "react";
import { History, Plus, ReceiptText } from "lucide-react";
import FormField from "../../ui/FormField";
import { SelectInput } from "../Fields";
import FlowStatus from "./FlowStatus";
import RxPrescriptionPanel from "./RxPrescriptionPanel";
import { BillWorkspace } from "../../../pages/pharmacy/PharmacyBillEditorPage";
import { requestErrorOf } from "../../billing/format";
import { inr, showDate } from "../format";
import { toast } from "../../../stores/uiStore";
import { useRxPatient } from "../../../queries/hooks/usePharmacyPrescriptions";
import { useCreateBill } from "../../../queries/hooks/usePharmacyBills";

function PatientSummary({ data, openBill, activeId }) {
  return (
    <div className="prx-summary">
      <div className="prx-summary__who">
        <h2 className="prx-patient__name">{data.patient.name}</h2>
        <p className="phs-meta">
          {[
            data.patient.file_no,
            [data.patient.age, data.patient.sex].filter(Boolean).join(" / "),
            data.doctor_name,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="prx-summary__facts">
        <FlowStatus
          status={data.visit?.current_status}
          label={data.visit?.status_label ?? "Not on Gini Flow today"}
        />
        <span className="prx-row__last">
          <History size={13} aria-hidden="true" />
          {data.last_collection
            ? `Last collected ${showDate(data.last_collection.date)} · ${data.last_collection.given} of ${data.last_collection.marked} given`
            : "No earlier collection from our pharmacy"}
        </span>
      </div>
      {data.bills.length ? (
        <div className="prx-summary__bills" role="group" aria-label="Bills made today">
          {data.bills.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`prx-billchip${activeId === b.id ? " is-on" : ""}`}
              aria-pressed={activeId === b.id}
              onClick={() => openBill(b.id)}
            >
              <ReceiptText size={13} aria-hidden="true" />
              {b.bill_no} · {inr(b.net_amount)}
              {Number(b.due) > 0 ? ` · due ${inr(b.due)}` : " · paid"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StartBill({ data, onStarted }) {
  const create = useCreateBill();
  const [saleType, setSaleType] = useState("opd");
  const [ipdNumber, setIpdNumber] = useState("");
  const [touched, setTouched] = useState(false);
  const ipdMissing = saleType === "ipd" && !ipdNumber.trim();

  const start = async () => {
    setTouched(true);
    if (ipdMissing) return;
    try {
      const bill = await create.mutateAsync({
        patient_id: data.patient.id,
        sale_type: saleType,
        ...(saleType === "ipd" ? { ipd_number: ipdNumber.trim() } : {}),
        ...(data.doctor_name ? { prescriber_name: data.doctor_name } : {}),
      });
      onStarted(bill.id);
    } catch (err) {
      toast(requestErrorOf(err, "Could not start the bill"), "error");
    }
  };

  return (
    <div className="flow-card prx-start">
      <div className="bill-form prx-start__form">
        <FormField label="Sale type">
          <SelectInput
            value={saleType}
            onChange={setSaleType}
            options={[
              { value: "opd", label: "OPD" },
              { value: "ipd", label: "IPD" },
            ]}
          />
        </FormField>
        {saleType === "ipd" ? (
          <FormField
            label="IPD number"
            required
            error={touched && ipdMissing ? "Enter the IPD number." : null}
          >
            <input
              className="jb-assign"
              maxLength={40}
              value={ipdNumber}
              onChange={(e) => setIpdNumber(e.target.value)}
            />
          </FormField>
        ) : null}
      </div>
      <button
        type="button"
        className="flow-btn flow-btn-primary phs-upload"
        disabled={create.isPending}
        onClick={start}
      >
        <Plus size={15} aria-hidden="true" />
        {create.isPending ? "Starting…" : data.bills.length ? "Start another bill" : "Start bill"}
      </button>
    </div>
  );
}

export default function RxPatientPane({ patientId, date }) {
  const query = useRxPatient(patientId, date);
  const data = query.data;
  const [billId, setBillId] = useState(null);

  useEffect(() => {
    if (data?.draft_bill_id && !billId) setBillId(data.draft_bill_id);
  }, [data?.draft_bill_id, billId]);

  if (query.isError) {
    return (
      <div className="phs-empty" role="alert">
        <p>
          {query.error?.response?.status === 404
            ? "This patient was not found."
            : "Unable to load the prescription. Please try again."}
        </p>
        <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="phs-empty" role="status">
        Loading the prescription…
      </p>
    );
  }

  const panel = (ctx) => <RxPrescriptionPanel data={data} {...ctx} />;
  const started = (id) => {
    setBillId(id);
    query.refetch();
  };

  return (
    <>
      <PatientSummary data={data} activeId={billId} openBill={setBillId} />
      {data.marking_blocked ? (
        <p className="prx-note" role="note">
          The patient has not reached the pharmacy yet. Prepare the medicines and the bill now;
          medicine collection is marked when the bill is finalised at the counter.
        </p>
      ) : null}
      {billId ? (
        <>
          {data.bills.some((b) => b.id === billId) && !data.draft_bill_id ? (
            <StartBill data={data} onStarted={started} />
          ) : null}
          <BillWorkspace
            key={billId}
            billId={billId}
            compact
            renderPrescription={panel}
            onDiscarded={() => {
              setBillId(null);
              query.refetch();
            }}
          />
        </>
      ) : (
        <>
          <StartBill data={data} onStarted={started} />
          {data.items.length ? (
            panel({ bill: null, busy: true, openPicker: null })
          ) : (
            <p className="phs-empty">This patient has no current prescription.</p>
          )}
        </>
      )}
    </>
  );
}
