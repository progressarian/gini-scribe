import { useId, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useMembershipCard,
  useMembershipSearch,
  useReverseCardUse,
  useUseDietitianVisit,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { cardBalanceText } from "./MembershipBox";

const STATUS_TEXT = { active: "Active", exhausted: "Used up", cancelled: "Cancelled" };
const STATUS_BADGE = { active: "b-grn", exhausted: "b-amb", cancelled: "b-red" };
const KIND_TEXT = { consultation: "Consultation", dietitian: "Dietitian visit" };

const when = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_BADGE[status] ?? "b-ink"}`}>{STATUS_TEXT[status]}</span>;
}

function DietitianForm({ card }) {
  const id = useId();
  const used = useUseDietitianVisit();
  const people = [
    { id: card.holder.id, label: `${card.holder.name} (holder)` },
    ...[
      ...new Map(
        card.uses
          .filter((use) => !use.by_holder)
          .map((use) => [use.patient_file_no ?? use.patient_name, use]),
      ).values(),
    ].map((use) => ({ id: use.patient_id ?? null, label: use.patient_name })),
  ].filter((person) => person.id);
  const [who, setWho] = useState(String(card.holder.id));
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  if (card.status === "cancelled" || card.dietitian_left <= 0) return null;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    try {
      await used.mutateAsync({ cardId: card.id, patientId: Number(who), note: note.trim() });
      setNote("");
      setDone("Dietitian visit marked on the card.");
    } catch (err) {
      setError(errorOf(err, "The dietitian visit could not be marked"));
    }
  };

  return (
    <form className="bc-card bc-member__sell" onSubmit={submit} aria-label="Mark a dietitian visit">
      <h4 className="bc-card__heading">Mark a dietitian visit used</h4>
      <label className="bc-field" htmlFor={`${id}-who`}>
        <span className="bc-field__lbl">Who saw the dietitian</span>
        <select
          id={`${id}-who`}
          className="bc-field__in"
          value={who}
          onChange={(e) => setWho(e.target.value)}
        >
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </select>
      </label>
      <label className="bc-field" htmlFor={`${id}-note`}>
        <span className="bc-field__lbl">
          Note <span aria-hidden="true">*</span>
        </span>
        <input
          id={`${id}-note`}
          className="bc-field__in"
          required
          maxLength={500}
          placeholder="e.g. Diet review with Ms Kaur"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="submit" className="st-btn st-btn-g" disabled={!note.trim() || used.isPending}>
        {used.isPending ? "Saving…" : "Use 1 dietitian visit"}
      </button>
      {done && (
        <div className="bc-note" role="status">
          {done}
        </div>
      )}
      {error && <div className="bc-err">{error}</div>}
    </form>
  );
}

function UsesTable({ card }) {
  const reverse = useReverseCardUse();
  const [undoing, setUndoing] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  if (!card.uses.length) {
    return <div className="bc-hint">Nothing has been used on this card yet.</div>;
  }
  const confirm = async () => {
    setError(null);
    try {
      await reverse.mutateAsync({ useId: undoing.id, reason: reason.trim() });
      setUndoing(null);
      setReason("");
    } catch (err) {
      setError(errorOf(err, "The use could not be reversed"));
    }
  };
  return (
    <>
      <div className="ltablewrap bc-stack">
        <table className="ltable" aria-label={`Uses of card ${card.card_no}`}>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Used for</th>
              <th scope="col">Patient</th>
              <th scope="col">Bill</th>
              <th scope="col">By</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {card.uses.map((use) => (
              <tr key={use.id}>
                <td data-label="Date">{when(use.created_at)}</td>
                <td data-label="Used for">
                  {KIND_TEXT[use.kind]}
                  {use.note ? <div className="bc-head__meta">{use.note}</div> : null}
                </td>
                <td data-label="Patient">
                  {use.patient_name}
                  {use.patient_file_no ? ` (${use.patient_file_no})` : ""}
                  {!use.by_holder && <div className="bc-head__meta">Family / other</div>}
                </td>
                <td data-label="Bill">
                  {use.bill_no || (use.source === "manual" ? "At the desk" : "—")}
                </td>
                <td data-label="By">{use.created_by_name || "—"}</td>
                <td data-label="Status">
                  {use.reversed_at ? (
                    <span className="badge b-ink" title={use.reverse_reason}>
                      Given back
                    </span>
                  ) : (
                    <span className="badge b-blu">Used</span>
                  )}
                </td>
                <td data-label="" className="bc-cell-actions">
                  {use.source === "manual" && !use.reversed_at && (
                    <button
                      type="button"
                      className="st-btn st-btn-g"
                      aria-label={`Give back the ${KIND_TEXT[use.kind].toLowerCase()} used on ${when(use.created_at)}`}
                      onClick={() => {
                        setError(null);
                        setReason("");
                        setUndoing(use);
                      }}
                    >
                      Give back
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmModal
        open={Boolean(undoing)}
        title={`Give back a dietitian visit to card ${card.card_no}?`}
        confirmLabel={reverse.isPending ? "Saving…" : "Give it back"}
        cancelLabel="Keep it used"
        busy={reverse.isPending}
        error={error}
        confirmDisabled={!reason.trim()}
        message={
          <label className="bc-field">
            <span className="bc-field__lbl">
              Why? The card goes from {card.dietitian_left} to {card.dietitian_left + 1} dietitian
              visits left.
            </span>
            <textarea
              className="bc-field__in"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        }
        onConfirm={confirm}
        onCancel={() => setUndoing(null)}
      />
    </>
  );
}

function CardDetail({ cardId, onBack }) {
  const { data: card, isLoading, isError, refetch } = useMembershipCard(cardId);
  if (isLoading) {
    return (
      <div className="bc-hint" role="status">
        Loading the card…
      </div>
    );
  }
  if (isError || !card) {
    return (
      <div className="bc-err" role="alert">
        The card could not be loaded.{" "}
        <button type="button" className="st-btn st-btn-g" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <section className="bc-card bc-member" aria-label={`Membership card ${card.card_no}`}>
      <div className="bc-head__row">
        <button type="button" className="st-btn st-btn-g" onClick={onBack}>
          ← All cards
        </button>
      </div>
      <h3 className="bc-card__heading">
        {card.card_no} · {card.plan.name} <StatusBadge status={card.status} />
      </h3>
      <dl className="bc-edit-totals">
        <dt>Holder</dt>
        <dd>
          {card.holder.name}
          {card.holder.file_no ? ` (${card.holder.file_no})` : ""}
        </dd>
        <dt>Phone</dt>
        <dd>{card.holder.phone || "—"}</dd>
        <dt>Price paid</dt>
        <dd>{fromPaise(card.price)}</dd>
        <dt>Sold on bill</dt>
        <dd>{card.sold_bill_no || "—"}</dd>
        <dt>Left</dt>
        <dd>{cardBalanceText(card)}</dd>
        <dt>Lab discount</dt>
        <dd>
          {card.lab_discount_pct
            ? `${card.lab_discount_pct}% — ${card.lab_discount_today ? "applies today" : "not now (no consultations left)"}`
            : "None"}
        </dd>
      </dl>
      <DietitianForm key={`${card.id}:${card.dietitian_left}`} card={card} />
      <h4 className="bc-card__heading">History</h4>
      <UsesTable card={card} />
    </section>
  );
}

export default function MembershipsPanel() {
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const search = useMembershipSearch(q);
  const text = q.trim();

  if (open) return <CardDetail cardId={open} onBack={() => setOpen(null)} />;

  return (
    <section className="bc-card bc-member" aria-label="Membership cards">
      <h3 className="bc-card__heading">Membership cards</h3>
      <label className="bc-field" htmlFor={`${id}-q`}>
        <span className="bc-field__lbl">Find a card</span>
        <input
          id={`${id}-q`}
          type="search"
          className="bc-field__in"
          placeholder="Search by card number, holder name, UHID or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {text.length < 2 ? (
        <div className="bc-hint">
          Type at least 2 letters or digits. To sell a card, open the patient&apos;s bill and choose
          a plan under Membership.
        </div>
      ) : search.isError ? (
        <div className="bc-err" role="alert">
          Cards could not be searched. Try again.
        </div>
      ) : !search.data ? (
        <div className="bc-hint" role="status">
          Searching…
        </div>
      ) : !search.data.length ? (
        <div className="bc-hint" role="status">
          No card matches “{text}”.
        </div>
      ) : (
        <div className="ltablewrap bc-stack">
          <table className="ltable" aria-label="Cards found">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col">Holder</th>
                <th scope="col">Plan</th>
                <th scope="col">Left</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {search.data.map((card) => (
                <tr key={card.id}>
                  <td data-label="Card">{card.card_no}</td>
                  <td data-label="Holder">
                    {card.holder.name}
                    {card.holder.file_no ? ` (${card.holder.file_no})` : ""}
                  </td>
                  <td data-label="Plan">{card.plan.name}</td>
                  <td data-label="Left">{cardBalanceText(card)}</td>
                  <td data-label="Status">
                    <StatusBadge status={card.status} />
                  </td>
                  <td data-label="" className="bc-cell-actions">
                    <button
                      type="button"
                      className="st-btn st-btn-g"
                      aria-label={`Open card ${card.card_no}`}
                      onClick={() => setOpen(card.id)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
