import { ArrowRight } from "lucide-react";
import { useState } from "react";
import FormField from "../ui/FormField";
import MasterFormDialog from "./MasterFormDialog";
import { digitsTyped, requestErrorOf } from "../billing/format";
import { packUnits, showDate } from "./format";
import { toast } from "../../stores/uiStore";
import { useAdjustStock } from "../../queries/hooks/usePharmacyBatches";
import { ADJUSTMENT_REASON_LABEL } from "../../../shared/pharmacyVocab";
import { SelectInput, optionsOf } from "./Fields";

const REDUCING = ["damaged", "expired", "lost"];

export default function AdjustStockDialog({ medicine, batch, location, onClose }) {
  const adjust = useAdjustStock();
  const [reason, setReason] = useState(batch.expired ? "expired" : "physical_count");
  const [newUnits, setNewUnits] = useState(batch.expired ? "0" : "");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const current = batch.qty_units;
  const target = newUnits === "" ? null : Number(newUnits);
  const delta = target === null ? null : target - current;

  const problems = {};
  if (target === null) problems.newUnits = "Enter what the stock should be after this change.";
  else if (delta === 0) problems.newUnits = "This is the same as the current stock.";
  else if (REDUCING.includes(reason) && delta > 0)
    problems.newUnits = `${ADJUSTMENT_REASON_LABEL[reason]} can only reduce stock.`;
  if (note.trim().length < 3)
    problems.note = "Say what happened, for example the count or the damage.";
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      await adjust.mutateAsync({
        location_id: location.id,
        batch_id: batch.id,
        expected_units: current,
        new_units: target,
        reason,
        note: note.trim(),
      });
      toast(`${medicine.name} batch ${batch.batch_no} is now ${packUnits(target, medicine)}.`);
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not adjust the stock"));
    }
  };

  return (
    <MasterFormDialog
      title={`Adjust stock · ${medicine.name}`}
      intro={
        <dl className="adj-facts" aria-label="Batch being adjusted">
          <div>
            <dt>Batch</dt>
            <dd className="phv-mono">{batch.batch_no}</dd>
          </div>
          <div>
            <dt>Expiry</dt>
            <dd>
              {showDate(batch.expiry_date)}
              {batch.expired ? " (expired)" : ""}
            </dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>
              {location.name}
              {batch.rack_no ? `, rack ${batch.rack_no}` : ""}
            </dd>
          </div>
          <div>
            <dt>Current stock</dt>
            <dd>
              {packUnits(current, medicine)} ({current} {medicine.unit_label})
            </dd>
          </div>
        </dl>
      }
      dirty={Boolean(newUnits || note)}
      busy={adjust.isPending}
      error={error}
      submitLabel="Save adjustment"
      onSubmit={submit}
      onClose={onClose}
      wide={false}
    >
      <div className="bill-form">
        <FormField label="Reason" required>
          <SelectInput
            value={reason}
            onChange={setReason}
            options={optionsOf(ADJUSTMENT_REASON_LABEL)}
          />
        </FormField>
        <FormField
          label={`New stock (${medicine.unit_label})`}
          required
          error={errors.newUnits}
          hint={target === null ? "What is on the shelf now" : packUnits(target, medicine)}
        >
          <input
            className="jb-assign"
            inputMode="numeric"
            maxLength={9}
            value={newUnits}
            onChange={(e) => setNewUnits(digitsTyped(e.target.value))}
          />
        </FormField>
        <FormField label="What happened" required error={errors.note} className="phv-span-all">
          <textarea
            className="jb-assign"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
      </div>
      {delta ? (
        <p className="adj-change" role="status">
          {current} <ArrowRight size={13} className="adj-change__arrow" aria-hidden="true" />
          <span className="sr-only">to</span> {target} {medicine.unit_label} (
          {delta > 0 ? "+" : "−"}
          {Math.abs(delta)}).{" "}
          {reason === "expired"
            ? "Recorded as an expiry write-off."
            : "Recorded in the batch history with your name."}
        </p>
      ) : null}
    </MasterFormDialog>
  );
}
