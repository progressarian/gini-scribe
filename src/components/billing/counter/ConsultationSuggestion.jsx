import { useState } from "react";
import { useAddBillLine, useConsultationSuggestion } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";

const priceOf = (choice, needsCategory) =>
  needsCategory || choice.price === null ? null : fromPaise(choice.price);

function choiceText(choice, needsCategory) {
  const price = priceOf(choice, needsCategory);
  return `${choice.doctor_name || choice.name}${price ? ` — ${price}` : ""}`;
}

export default function ConsultationSuggestion({ bill, onBill, needsCategory }) {
  const draft = bill.status === "draft";
  const { data } = useConsultationSuggestion(bill.id, bill.version, { enabled: draft });
  const addLine = useAddBillLine();
  const [picked, setPicked] = useState("");
  const [error, setError] = useState(null);

  if (!draft || !data?.shown) return null;
  const { choices, suggested, visit_type: visitType } = data;
  if (!suggested && !choices.length) return null;
  const chosen = choices.find((choice) => String(choice.item_id) === picked) ?? suggested;
  const doctor = chosen?.doctor_name ? ` — ${chosen.doctor_name}` : "";
  const price = chosen && priceOf(chosen, needsCategory);
  const label = `Add ${visitType} consultation${doctor}${price ? ` ${price}` : ""}`;

  const add = async () => {
    setError(null);
    try {
      onBill(
        await addLine.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          item_id: chosen.item_id,
          ...(chosen.doctor_id ? { doctor_id: chosen.doctor_id } : {}),
        }),
      );
    } catch (e) {
      setError(errorOf(e, "That consultation could not be added"));
    }
  };

  return (
    <section className="bc-card" aria-label="Consultation">
      <h3 className="bc-card__title">Consultation</h3>
      <div className="bc-consult">
        <button
          type="button"
          className="st-btn st-btn-grn bc-consult__add"
          disabled={!chosen || addLine.isPending}
          onClick={add}
        >
          {label}
        </button>
        {choices.length > (suggested ? 1 : 0) && (
          <label className="bc-field">
            <span className="bc-field__lbl">Change doctor</span>
            <select
              className="bc-field__in"
              value={chosen ? String(chosen.item_id) : ""}
              onChange={(e) => setPicked(e.target.value)}
            >
              {!suggested && <option value="">Choose a doctor</option>}
              {choices.map((choice) => (
                <option key={choice.item_id} value={String(choice.item_id)}>
                  {choiceText(choice, needsCategory)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <div className="bc-err">{error}</div>}
    </section>
  );
}
