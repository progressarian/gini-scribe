import { Fragment, useState } from "react";
import { BellPlus, History, Plus, Replace, Undo2 } from "lucide-react";
import MedicinePicker from "../MedicinePicker";
import { SelectInput, optionsOf } from "../Fields";
import { describeStock, useStockOptions } from "../stockOptions";
import { requestErrorOf } from "../../billing/format";
import { packUnits, showDate } from "../format";
import { toast } from "../../../stores/uiStore";
import {
  useRequestRxMedicine,
  useSaveRxOutcomes,
} from "../../../queries/hooks/usePharmacyPrescriptions";
import { RX_NOT_GIVEN_REASON_LABEL } from "../../../../shared/pharmacyVocab";

const REASONS = [{ value: "", label: "Not given…" }, ...optionsOf(RX_NOT_GIVEN_REASON_LABEL)];

export const rxText = (item) =>
  [item.dose, item.frequency, item.timing].filter(Boolean).join(" · ") || "No dose details";

const unitsOnBill = (bill, medicineId) =>
  (bill?.lines ?? [])
    .filter((l) => l.medicine_id === medicineId)
    .reduce((sum, l) => sum + l.qty_units, 0);

function statusOf(item, outcome, bill) {
  const medicineId = outcome?.outcome === "substitute" ? outcome.medicine_id : item.medicine?.id;
  const units = medicineId ? unitsOnBill(bill, medicineId) : 0;
  if (units && outcome?.outcome === "substitute")
    return { tone: "ready", text: "Substitute on bill" };
  if (units) return { tone: "ready", text: "On bill", units };
  if (item.today_status === "given") return { tone: "done", text: "Given today" };
  if (outcome?.outcome === "substitute") return { tone: "rx", text: "Substitute chosen" };
  if (outcome?.outcome === "requested") return { tone: "rx", text: "Collect later" };
  if (outcome?.outcome === "not_given") {
    return { tone: "none", text: `Not given · ${RX_NOT_GIVEN_REASON_LABEL[outcome.reason] ?? ""}` };
  }
  if (!item.medicine) return { tone: "none", text: "Not stocked" };
  if (!item.medicine.sellable_units) return { tone: "none", text: "Out of stock" };
  return { tone: "early", text: "To give" };
}

export default function RxPrescriptionPanel({ data, bill, busy, openPicker }) {
  const save = useSaveRxOutcomes();
  const request = useRequestRxMedicine();
  const [picking, setPicking] = useState(null);
  const [working, setWorking] = useState(null);
  const editable = Boolean(openPicker && bill?.status === "draft");
  const outcomes = Object.fromEntries(data.outcomes.map((o) => [o.medication_id, o]));
  const counts = data.items.reduce(
    (acc, i) => {
      if (!i.medicine) acc.missing += 1;
      else if (i.medicine.sellable_units > 0) acc.stocked += 1;
      else acc.out += 1;
      return acc;
    },
    { stocked: 0, out: 0, missing: 0 },
  );

  const decide = async (item, outcome) => {
    setWorking(item.medication_id);
    try {
      await save.mutateAsync({
        patientId: data.patient.id,
        bill_id: bill.id,
        outcomes: [{ medication_id: item.medication_id, ...outcome }],
      });
      return true;
    } catch (err) {
      toast(requestErrorOf(err, "Could not save the change"), "error");
      return false;
    } finally {
      setWorking(null);
    }
  };

  const collectLater = async (item) => {
    setWorking(item.medication_id);
    try {
      const sent = await request.mutateAsync({
        patientId: data.patient.id,
        medicationId: item.medication_id,
      });
      await save.mutateAsync({
        patientId: data.patient.id,
        bill_id: bill.id,
        outcomes: [{ medication_id: item.medication_id, outcome: "requested" }],
      });
      toast(
        sent.waiting > 1
          ? `Request sent to the pharmacy admin. ${sent.waiting} patients are waiting for it.`
          : "Request sent to the pharmacy admin.",
      );
    } catch (err) {
      toast(requestErrorOf(err, "Could not send the request"), "error");
    } finally {
      setWorking(null);
    }
  };

  const chooseSubstitute = async (item, medicine) => {
    setPicking(null);
    if (await decide(item, { outcome: "substitute", medicine_id: medicine.medicine_id })) {
      openPicker(medicine.medicine_id, { prescribed: `Substitute for ${item.medicine_name}` });
    }
  };

  return (
    <section className="flow-card prx-rx" aria-labelledby="prx-rx-title">
      <div className="fset__cardhead">
        <h2 id="prx-rx-title" className="flow-sec-title">
          Prescription medicines
        </h2>
        <span className="fset__count">{data.items.length}</span>
        <span className="phs-meta">
          {[
            counts.stocked && `${counts.stocked} in stock`,
            counts.out && `${counts.out} out of stock`,
            counts.missing && `${counts.missing} not stocked`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {!editable ? (
        <p className="phs-meta prx-rx__hint">
          {bill
            ? "This bill is finalised. Start another bill to give more."
            : "Start the bill to add these medicines."}
        </p>
      ) : null}
      <div className="fset__scroll">
        <table className="flow-table phs-table prx-rx__table" aria-label="Prescription medicines">
          <thead>
            <tr>
              <th>Prescribed</th>
              <th>In our pharmacy</th>
              <th>Status</th>
              {editable ? <th className="prx-rx__acts-col">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const outcome = outcomes[item.medication_id];
              const status = statusOf(item, outcome, bill);
              const substitute = outcome?.outcome === "substitute" ? outcome : null;
              const stocked = item.medicine && item.medicine.sellable_units > 0;
              const onBill = item.medicine && unitsOnBill(bill, item.medicine.id) > 0;
              const rowBusy = busy || working === item.medication_id;
              return (
                <Fragment key={item.medication_id}>
                  <tr>
                    <td data-label="Prescribed">
                      <span className="phs-item">{item.medicine_name}</span>
                      <span className="phs-meta">{rxText(item)}</span>
                      {item.last_given_on ? (
                        <span className="phs-meta prx-rx__last">
                          <History size={12} aria-hidden="true" />
                          Last given {showDate(item.last_given_on)}
                          {item.last_given_note ? ` · ${item.last_given_note}` : ""}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="In our pharmacy">
                      {item.medicine ? (
                        <>
                          <span className="phs-item">{item.medicine.name}</span>
                          <span className="phs-meta">
                            {packUnits(item.medicine.sellable_units, item.medicine)} in stock
                          </span>
                        </>
                      ) : (
                        <span className="phs-meta">Not in our pharmacy</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`prx-status prx-status--${status.tone}`}>
                        <span className="prx-status__dot" aria-hidden="true" />
                        {status.text}
                      </span>
                      {status.units && item.medicine ? (
                        <span className="phs-meta">{packUnits(status.units, item.medicine)}</span>
                      ) : null}
                    </td>
                    {editable ? (
                      <td data-label="Action" className="prx-rx__acts">
                        {stocked && !substitute ? (
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost prx-med__small"
                            disabled={rowBusy}
                            onClick={() =>
                              openPicker(item.medicine.id, { prescribed: rxText(item) })
                            }
                          >
                            <Plus size={13} aria-hidden="true" />
                            {onBill ? "Change" : "Add"}
                          </button>
                        ) : null}
                        {substitute ? (
                          <>
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost prx-med__small"
                              disabled={rowBusy}
                              onClick={() =>
                                openPicker(substitute.medicine_id, {
                                  prescribed: `Substitute for ${item.medicine_name}`,
                                })
                              }
                            >
                              <Replace size={13} aria-hidden="true" />
                              Change substitute
                            </button>
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost prx-med__small"
                              disabled={rowBusy}
                              onClick={() => decide(item, { outcome: "pending" })}
                            >
                              <Undo2 size={13} aria-hidden="true" />
                              Undo
                            </button>
                          </>
                        ) : !stocked && !onBill ? (
                          <>
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost prx-med__small"
                              disabled={rowBusy}
                              aria-expanded={picking === item.medication_id}
                              onClick={() =>
                                setPicking((id) =>
                                  id === item.medication_id ? null : item.medication_id,
                                )
                              }
                            >
                              <Replace size={13} aria-hidden="true" />
                              Substitute
                            </button>
                            {outcome?.outcome !== "requested" ? (
                              <button
                                type="button"
                                className="flow-btn flow-btn-ghost prx-med__small"
                                disabled={rowBusy}
                                onClick={() => collectLater(item)}
                              >
                                <BellPlus size={13} aria-hidden="true" />
                                Collect later
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        {!onBill && !substitute && item.today_status !== "given" ? (
                          <SelectInput
                            className="prx-rx__reason"
                            value={outcome?.outcome === "not_given" ? outcome.reason : ""}
                            disabled={rowBusy}
                            ariaLabel={`Why ${item.medicine_name} is not given`}
                            options={REASONS}
                            onChange={(reason) =>
                              decide(
                                item,
                                reason ? { outcome: "not_given", reason } : { outcome: "pending" },
                              )
                            }
                          />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                  {picking === item.medication_id ? (
                    <tr className="prx-rx__picker">
                      <td colSpan={4}>
                        <MedicinePicker
                          label={`Substitute for ${item.medicine_name}`}
                          placeholder="Search medicines in stock"
                          autoFocus
                          useOptions={useStockOptions}
                          optionId={(m) => m.medicine_id}
                          describeOption={describeStock}
                          noMatchText="No medicine in stock matches."
                          onSelect={(m) => chooseSubstitute(item, m)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
