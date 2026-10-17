import { useEffect, useState } from "react";
import { rupeesFromPaise } from "../../../shared/labPayment.js";
import { ITEM_SEARCH_MIN, useItemSearch } from "../../queries/hooks/useBilling";
import { HEALTHRAY_LABEL, PAID_MODE_LABEL, PAYMENT_MODE_LABEL } from "../billing/counter/lineText";

const COLLECT = "collect";
const SOURCES = [
  [COLLECT, "Collect now"],
  ["healthray", HEALTHRAY_LABEL],
  ["prepaid", PAID_MODE_LABEL.prepaid],
];

const SPLIT = "split";
const SPLIT_MAX = 4;

export const emptyArrivalChoices = () => ({
  skip: [],
  paid: {},
  mode: "cash",
  reference: "",
  split: [],
  extraToDeposit: false,
  add: [],
  remove: [],
  paidRef: {},
});

const PREPAID = "prepaid";

const prepaidWithoutRef = (preview, choices) =>
  (preview?.lines || []).find(
    (line) => choices.paid[line.itemId] === PREPAID && !(choices.paidRef[line.itemId] || "").trim(),
  );

const toPaise = (rupeesText) => Math.round(Number(rupeesText || 0) * 100);

const splitTotal = (split) => split.reduce((sum, part) => sum + toPaise(part.amount), 0);

export const extraPaise = (preview, choices) =>
  choices.mode === SPLIT
    ? Math.max(0, splitTotal(choices.split) - collectNowPaise(preview, choices))
    : 0;

const rupees = (paise) =>
  `₹${rupeesFromPaise(paise).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function alreadyPaidPaise(preview, choices) {
  let left = preview?.outstanding ?? 0;
  let total = 0;
  for (const line of preview?.lines || []) {
    if (!choices.paid[line.itemId]) continue;
    const amount = Math.min(line.amount, left);
    total += amount;
    left -= amount;
  }
  return total;
}

export const collectNowPaise = (preview, choices) =>
  Math.max(0, (preview?.outstanding ?? 0) - alreadyPaidPaise(preview, choices));

export const takesCash = (preview, choices) =>
  collectNowPaise(preview, choices) > 0 &&
  (choices.mode === SPLIT
    ? choices.split.some((part) => part.mode === "cash")
    : choices.mode === "cash");

export function arrivalBlocker(preview, choices, shiftOpen = true) {
  if (!preview) return "Working out the bill…";
  const missing = prepaidWithoutRef(preview, choices);
  if (missing) {
    return `Enter the transaction ID or earlier receipt number for ${missing.name} (paid earlier / online).`;
  }
  const collect = collectNowPaise(preview, choices);
  if (!collect) return null;
  if (!shiftOpen && takesCash(preview, choices)) {
    return "Open your shift (Shift tab) before taking cash, so it is counted in your drawer — or choose Card or UPI.";
  }
  if (choices.mode !== SPLIT) {
    return choices.mode === "cash" || choices.reference.trim()
      ? null
      : `Enter the ${PAYMENT_MODE_LABEL[choices.mode]} reference number.`;
  }
  const empty = choices.split.findIndex((part) => toPaise(part.amount) <= 0);
  if (empty >= 0) return `Enter an amount for part ${empty + 1}, or remove it.`;
  const noRef = choices.split.findIndex((part) => part.mode !== "cash" && !part.reference.trim());
  if (noRef >= 0) {
    return `Enter the ${PAYMENT_MODE_LABEL[choices.split[noRef].mode]} reference number for part ${noRef + 1}.`;
  }
  const total = splitTotal(choices.split);
  if (total < collect) return "The split must add up to the amount to collect.";
  if (total > collect && !choices.extraToDeposit) {
    return `The split is ${rupees(total - collect)} more than the bill — tick "Keep the extra as a deposit", or correct the amounts.`;
  }
  return null;
}

export const arrivalReady = (preview, choices, shiftOpen = true) =>
  !arrivalBlocker(preview, choices, shiftOpen);

export function arrivalPayload(preview, choices) {
  const collect = collectNowPaise(preview, choices);
  return {
    skip: choices.skip,
    add: choices.add.map((item) => item.id),
    remove: choices.remove.map((item) => item.id),
    expectedTotal: preview.outstanding,
    alreadyPaid: (preview.lines || [])
      .filter((line) => choices.paid[line.itemId])
      .map((line) => ({
        itemId: line.itemId,
        source: choices.paid[line.itemId],
        ...(choices.paid[line.itemId] === PREPAID
          ? { reference: (choices.paidRef[line.itemId] || "").trim() }
          : {}),
      })),
    ...(collect && choices.mode === SPLIT
      ? {
          extraToDeposit: extraPaise(preview, choices) > 0 && choices.extraToDeposit,
          split: choices.split.map((part) => ({
            mode: part.mode,
            amount: toPaise(part.amount),
            reference: part.mode === "cash" ? null : part.reference.trim(),
          })),
        }
      : {}),
    ...(collect && choices.mode !== SPLIT
      ? { mode: choices.mode, reference: choices.mode === "cash" ? null : choices.reference.trim() }
      : {}),
  };
}

export function arrivalButtonText(preview, choices, checkedIn) {
  const extra = extraPaise(preview, choices);
  const collect = collectNowPaise(preview, choices) + extra;
  if (!preview?.outstanding) return checkedIn ? null : "✓ Check in";
  const deposit = extra ? ` (${rupees(extra)} to deposit)` : "";
  if (checkedIn) {
    return collect ? `✓ Collect ${rupees(collect)}${deposit}` : "✓ Record as already paid";
  }
  return collect
    ? `✓ Check in & collect ${rupees(collect)}${deposit}`
    : "✓ Check in — already paid";
}

const CARRY_NOTE = {
  paid: (o) => `already paid${o.billNo ? ` on bill ${o.billNo}` : ""} — the lab can start`,
  due: (o) => `still due on bill ${o.billNo || "of the last visit"} — settle it on Dues`,
};

const rupeeInput = (paise) => (paise > 0 ? String(rupeesFromPaise(paise)) : "");

function balanced(split, index, typed, collect) {
  const kept = toPaise(typed) < 0 ? "" : typed;
  const next = split.map((part, i) => (i === index ? { ...part, amount: kept } : part));
  if (next.length < 2) return next;
  const balancer = index === 0 ? next.length - 1 : 0;
  const others = next.reduce(
    (sum, part, i) => (i === balancer ? sum : sum + toPaise(part.amount)),
    0,
  );
  next[balancer] = { ...next[balancer], amount: rupeeInput(Math.max(0, collect - others)) };
  return next;
}

function SplitRows({ split, collect, onChange, extraToDeposit, onExtraToDeposit }) {
  const setPart = (index, change) =>
    onChange(split.map((part, i) => (i === index ? { ...part, ...change } : part)));
  const setAmount = (index, typed) => onChange(balanced(split, index, typed, collect));
  const total = splitTotal(split);
  const left = collect - total;
  return (
    <div className="ab-split" role="group" aria-label="Split payment">
      {split.map((part, index) => (
        <div className="ab-split-row" key={index}>
          <select
            className="ab-pay"
            aria-label={`Part ${index + 1} paid by`}
            value={part.mode}
            onChange={(e) => setPart(index, { mode: e.target.value })}
          >
            {Object.entries(PAYMENT_MODE_LABEL).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
          <input
            className="ab-ref ab-split-amt"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            aria-label={`Part ${index + 1} amount`}
            placeholder="₹ amount"
            value={part.amount}
            onChange={(e) => setAmount(index, e.target.value)}
          />
          {part.mode !== "cash" && (
            <input
              className="ab-ref"
              aria-label={`Part ${index + 1} reference`}
              placeholder={`${PAYMENT_MODE_LABEL[part.mode]} reference number`}
              value={part.reference}
              onChange={(e) => setPart(index, { reference: e.target.value })}
            />
          )}
          {split.length > 1 && (
            <button
              type="button"
              className="jb-remove"
              aria-label={`Remove part ${index + 1}`}
              onClick={() => {
                const rest = split.filter((_, i) => i !== index);
                onChange(balanced(rest, rest.length - 1, rest.at(-1).amount, collect));
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="ab-split-foot">
        {split.length < SPLIT_MAX && (
          <button
            type="button"
            className="btn-sm"
            onClick={() =>
              onChange([
                ...split,
                {
                  mode: "upi",
                  amount: left > 0 ? String(rupeesFromPaise(left)) : "",
                  reference: "",
                },
              ])
            }
          >
            + Add another
          </button>
        )}
        <span className={`ab-split-sum${left === 0 ? " is-ok" : ""}`} role="status">
          {rupees(total)} of {rupees(collect)}
          {left === 0 ? " ✓" : left > 0 ? ` · ${rupees(left)} left` : ` · ${rupees(-left)} over`}
        </span>
      </div>
      {left > 0 && (
        <div className="ab-err" role="alert">
          {`The parts must add up to ${rupees(collect)} — ${rupees(left)} is still to be split.`}
        </div>
      )}
      {left < 0 && (
        <label className="ab-deposit">
          <input
            type="checkbox"
            checked={extraToDeposit}
            onChange={(e) => onExtraToDeposit(e.target.checked)}
          />
          <span>
            <strong>Keep the extra {rupees(-left)} as a deposit</strong> for this patient — it gets
            its own deposit receipt and is used on a later bill. Untick and correct the amounts if
            this was a typing mistake.
          </span>
        </label>
      )}
    </div>
  );
}

const SEARCH_DELAY_MS = 250;

function AddService({ visitId, onAdd, onLine }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const searching = query.length >= ITEM_SEARCH_MIN;
  const { data, isFetching } = useItemSearch(query, visitId, null, { enabled: searching });
  const items = searching ? data?.items || [] : [];
  return (
    <div className="ab-add">
      <input
        type="search"
        className="ab-ref"
        aria-label="Add a service"
        placeholder="Add a service — type 2 letters, e.g. ECG, lipid, dressing"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {searching && (
        <ul className="ab-add-list" aria-label="Services found">
          {isFetching && !items.length && <li className="dp-hint">Searching…</li>}
          {!isFetching && !items.length && (
            <li className="dp-hint">No service matches “{query}”.</li>
          )}
          {items.map((item) => {
            const onBill = onLine(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="ab-add-item"
                  disabled={onBill}
                  aria-label={`Add ${item.name}`}
                  onClick={() => {
                    onAdd({ id: item.id, name: item.name });
                    setText("");
                  }}
                >
                  <span>{item.name}</span>
                  <span className="ab-amt">
                    {onBill
                      ? "on this bill"
                      : item.rate === null
                        ? ""
                        : `₹${Number(item.rate).toLocaleString("en-IN")}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CarriedTests({ carry, choices, onChange }) {
  if (!carry?.length) return null;
  const toggle = (orderId, billToday) =>
    onChange({
      ...choices,
      skip: billToday
        ? choices.skip.filter((id) => id !== orderId)
        : [...new Set([...choices.skip, orderId])],
    });
  return (
    <fieldset className="ab-carry">
      <legend>Tests ordered at the last visit</legend>
      {carry.map((order) => {
        const names = order.tests.join(", ");
        const note = CARRY_NOTE[order.state];
        return (
          <label key={order.orderId} className={order.state === "due" ? "is-disabled" : undefined}>
            <input
              type="checkbox"
              checked={order.state !== "due" && !choices.skip.includes(order.orderId)}
              disabled={order.state === "due"}
              onChange={(e) => toggle(order.orderId, e.target.checked)}
            />
            <span>
              <strong>{names}</strong> · ordered {order.orderedOn}
              {order.urgency === "tomorrow" ? " for the next day" : " for this visit"}
              {note ? ` · ${note(order)}` : ""}
            </span>
          </label>
        );
      })}
      <div className="dp-hint">Untick a test to leave it for a later visit.</div>
    </fieldset>
  );
}

export default function ArrivalBill({
  preview,
  isLoading,
  isError,
  choices,
  onChange,
  error,
  shiftOpen = true,
  visitId,
}) {
  if (isLoading && !preview) return <div className="dp-hint">Working out the bill…</div>;
  if (isError && !preview) {
    return (
      <div className="dp-hint" role="alert">
        The bill could not be worked out. Check in only and bill them at the counter.
      </div>
    );
  }
  if (!preview) return null;
  const lines = preview.lines || [];
  const collect = collectNowPaise(preview, choices);
  const already = (preview.outstanding ?? 0) - collect;
  const setPaid = (itemId, source) => {
    const paid = { ...choices.paid };
    if (source === COLLECT) delete paid[itemId];
    else paid[itemId] = source;
    onChange({ ...choices, paid });
  };

  const removeLine = (line) => {
    const paid = { ...choices.paid };
    delete paid[line.itemId];
    const added = choices.add.some((item) => item.id === line.itemId);
    onChange({
      ...choices,
      paid,
      add: choices.add.filter((item) => item.id !== line.itemId),
      remove: added ? choices.remove : [...choices.remove, { id: line.itemId, name: line.name }],
    });
  };
  const undoRemove = (id) =>
    onChange({ ...choices, remove: choices.remove.filter((item) => item.id !== id) });
  const addService = (item) =>
    onChange({
      ...choices,
      add: [...choices.add.filter((added) => added.id !== item.id), item],
      remove: choices.remove.filter((removed) => removed.id !== item.id),
    });

  const covered = lines.length > 0 && !preview.outstanding;
  const blocker = arrivalBlocker(preview, choices, shiftOpen);
  const splitShowsWhy =
    choices.mode === SPLIT &&
    splitTotal(choices.split) < collect &&
    !(!shiftOpen && takesCash(preview, choices));

  return (
    <section className="ab" aria-label="Bill at arrival">
      <div className="ab-head">
        <strong>Bill at arrival</strong>
        {lines.length > 0 && (
          <span className={`ab-due${collect ? "" : " ab-due--none"}`}>
            {covered ? "Nothing to collect" : `To collect ${rupees(collect)}`}
          </span>
        )}
      </div>
      <CarriedTests carry={preview.carry} choices={choices} onChange={onChange} />
      {preview.journeyNote && <div className="dp-hint">{preview.journeyNote}</div>}
      {lines.length === 0 ? (
        <div className="dp-hint">Nothing to bill yet — the consultant may still order tests.</div>
      ) : (
        <table className="ab-lines">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="ab-amt">
                Amount
              </th>
              {!covered && <th scope="col">Payment</th>}
              <th scope="col">
                <span className="ab-sr">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.itemId}>
                <th scope="row">
                  {line.name}
                  {line.carried && <span className="ab-tag">from the last visit</span>}
                </th>
                <td className="ab-amt">{rupees(line.amount)}</td>
                {!covered && (
                  <td>
                    <select
                      className="ab-pay"
                      aria-label={`How ${line.name} is paid`}
                      value={choices.paid[line.itemId] || COLLECT}
                      onChange={(e) => setPaid(line.itemId, e.target.value)}
                    >
                      {SOURCES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {choices.paid[line.itemId] === PREPAID && (
                      <input
                        className="ab-ref ab-paid-ref"
                        aria-label={`${line.name} payment reference`}
                        placeholder="Transaction ID / receipt no."
                        maxLength={60}
                        value={choices.paidRef[line.itemId] || ""}
                        onChange={(e) =>
                          onChange({
                            ...choices,
                            paidRef: { ...choices.paidRef, [line.itemId]: e.target.value },
                          })
                        }
                      />
                    )}
                  </td>
                )}
                <td>
                  <button
                    type="button"
                    className="jb-remove"
                    aria-label={`Remove ${line.name}`}
                    title="Remove from this bill"
                    onClick={() => removeLine(line)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {!covered && (
            <tfoot>
              {already > 0 && (
                <tr>
                  <th scope="row">Already paid</th>
                  <td className="ab-amt">{rupees(already)}</td>
                  <td />
                  <td />
                </tr>
              )}
              <tr className="ab-total">
                <th scope="row">To collect now</th>
                <td className="ab-amt">{rupees(collect)}</td>
                <td />
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      )}
      {choices.remove.length > 0 && (
        <div className="ab-removed" aria-label="Removed from this bill">
          Removed:{" "}
          {choices.remove.map((item) => (
            <span key={item.id} className="ab-removed-item">
              {item.name}
              <button
                type="button"
                className="btn-sm"
                aria-label={`Put back ${item.name}`}
                onClick={() => undoRemove(item.id)}
              >
                Undo
              </button>
            </span>
          ))}
        </div>
      )}
      {visitId && (
        <AddService
          visitId={visitId}
          onAdd={addService}
          onLine={(id) => lines.some((line) => line.itemId === id)}
        />
      )}
      {covered && (
        <div className="dp-hint">
          This bill is already covered — nothing is taken at check-in. Open the bill to review it.
        </div>
      )}
      {collect > 0 && (
        <div className="ab-mode">
          <div className="consultation-options" role="radiogroup" aria-label="Paid by">
            <span className="ab-mode-lab">Paid by</span>
            {Object.entries(PAYMENT_MODE_LABEL).map(([mode, label]) => (
              <label key={mode}>
                <input
                  type="radio"
                  name="arrivalMode"
                  value={mode}
                  checked={choices.mode === mode}
                  onChange={() => onChange({ ...choices, mode })}
                />
                {label}
              </label>
            ))}
            <label>
              <input
                type="radio"
                name="arrivalMode"
                value={SPLIT}
                checked={choices.mode === SPLIT}
                onChange={() =>
                  onChange({
                    ...choices,
                    mode: SPLIT,
                    split: choices.split.length
                      ? choices.split
                      : [
                          { mode: "cash", amount: String(rupeesFromPaise(collect)), reference: "" },
                          { mode: "upi", amount: "", reference: "" },
                        ],
                  })
                }
              />
              Split
            </label>
          </div>
          {choices.mode === SPLIT && (
            <SplitRows
              split={choices.split}
              collect={collect}
              onChange={(split) => onChange({ ...choices, split })}
              extraToDeposit={choices.extraToDeposit}
              onExtraToDeposit={(extraToDeposit) => onChange({ ...choices, extraToDeposit })}
            />
          )}
          {choices.mode !== "cash" && choices.mode !== SPLIT && (
            <input
              className="ab-ref"
              aria-label={`${PAYMENT_MODE_LABEL[choices.mode]} reference`}
              placeholder={`${PAYMENT_MODE_LABEL[choices.mode]} reference number`}
              value={choices.reference}
              onChange={(e) => onChange({ ...choices, reference: e.target.value })}
            />
          )}
        </div>
      )}
      {blocker && !splitShowsWhy && (collect > 0 || prepaidWithoutRef(preview, choices)) && (
        <div className="ab-err" role="alert">
          {blocker}
        </div>
      )}
      {error && (
        <div className="ab-err" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
