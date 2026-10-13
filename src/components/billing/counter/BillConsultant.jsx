import { useEffect, useState } from "react";
import { useBillConsultants, useSetBillConsultant } from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";

const hasConsultation = (bill) =>
  (bill.lines || []).some((line) => line.is_live && line.item_kind === "consultation");

function changeHint(bill, pickedId, options) {
  if (!pickedId) return null;
  if (options?.hospital_admin && pickedId === options.hospital_admin.id) {
    return hasConsultation(bill)
      ? "The consultation fee will be removed — this becomes a tests-only bill."
      : "This becomes a tests-only bill under Hospital Admin.";
  }
  return hasConsultation(bill)
    ? "The consultation fee will change to this doctor's."
    : "This doctor's consultation fee will be added to the bill.";
}

export default function BillConsultant({ bill, onBill }) {
  const draft = bill.status === "draft";
  const {
    data: options,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useBillConsultants(bill.id, { enabled: draft });
  const setConsultant = useSetBillConsultant();
  const current = bill.consultant?.id ? String(bill.consultant.id) : "";
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setPicked(null);
    setError(null);
  }, [bill.id, current]);

  if (!draft) {
    return bill.consultant ? (
      <div className="bc-head__row">
        <span className="bc-field__lbl">Consultant</span>
        <span>{bill.consultant.name}</span>
      </div>
    ) : null;
  }

  const listed = [
    ...(options?.today || []),
    ...(options?.others || []),
    ...(options?.hospital_admin ? [options.hospital_admin] : []),
  ];
  const value = picked ?? current;
  const hint = changeHint(bill, picked ? Number(picked) : null, options);

  const save = async (e) => {
    e.preventDefault();
    if (!picked) return;
    setError(null);
    try {
      onBill(
        await setConsultant.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          consultantId: Number(picked),
        }),
      );
      setPicked(null);
    } catch (err) {
      setError(errorOf(err, "The consultant could not be changed"));
    }
  };

  return (
    <form className="bc-head__row" onSubmit={save}>
      <label className="bc-field">
        <span className="bc-field__lbl">Consultant</span>
        <select
          className="bc-field__in"
          value={value}
          disabled={isLoading || setConsultant.isPending}
          onChange={(e) => setPicked(e.target.value === current ? null : e.target.value)}
        >
          {!current && <option value="">Choose a consultant</option>}
          {current && !listed.some((d) => String(d.id) === current) && (
            <option value={current}>{bill.consultant.name}</option>
          )}
          {options?.today?.length > 0 && (
            <optgroup label="Booked today">
              {options.today.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          )}
          {options?.others?.length > 0 && (
            <optgroup label="Other consultants">
              {options.others.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          )}
          {options?.hospital_admin && (
            <option value={options.hospital_admin.id}>Hospital Admin (tests only)</option>
          )}
        </select>
      </label>
      <button
        type="submit"
        className="st-btn st-btn-grn"
        disabled={!picked || setConsultant.isPending}
      >
        {setConsultant.isPending ? "Changing…" : "Change consultant"}
      </button>
      {hint && <span className="bc-head__hint">{hint}</span>}
      {isError && !options && (
        <span className="bc-err" role="alert">
          The consultant list could not be loaded.{" "}
          <button
            type="button"
            className="st-btn st-btn-g"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            {isFetching ? "Loading…" : "Try again"}
          </button>
        </span>
      )}
      {error && (
        <span className="bc-err" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
