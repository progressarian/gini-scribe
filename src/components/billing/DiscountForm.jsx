import { cloneElement, useId, useState } from "react";
import {
  BILLING_ROLES,
  DISCOUNT_KINDS,
  DISCOUNT_METHODS,
  GENDERS,
  VISIT_TYPES,
} from "../../../shared/billingVocab.js";
import {
  useBillingCategories,
  useBillingGroups,
  useBillingItemChoices,
  useCreateBillingDiscount,
  useUpdateBillingDiscount,
} from "../../queries/hooks/useBillingMaster";
import DiscountItemPicker from "./DiscountItemPicker";
import { KIND_LABEL, ROLE_LABEL, offLabel } from "./discountText";
import { codeTyped, digitsTyped, moneyTyped, requestErrorOf } from "./format";
import useDialog from "./useDialog";

const METHOD_CHOICE = {
  code: "Code — the desk enters it",
  auto: "Automatic — applies by itself",
};
const LIMITS = [
  ["max_uses_total", "Uses in all"],
  ["max_uses_per_patient", "Uses per patient"],
  ["max_uses_per_day", "Uses per day"],
  ["max_uses_per_doctor_per_day", "Uses per doctor per day"],
];
const DIGITS = new Set(["min_age", "max_age", "priority", ...LIMITS.map(([key]) => key)]);
const TYPED = { value: moneyTyped, max_discount: moneyTyped, code: codeTyped };

const text = (v) => (v === null || v === undefined ? "" : String(v));
const ids = (list) => [...(list ?? [])].map(Number).sort((a, b) => a - b);

const formOf = (rule) => ({
  method: rule?.method ?? "code",
  code: text(rule?.code),
  name: text(rule?.name),
  kind: rule?.kind ?? "percent",
  value: text(rule?.value),
  max_discount: text(rule?.max_discount),
  applies_per: rule?.applies_per ?? "line",
  group_ids: ids(rule?.group_ids),
  subgroup_ids: ids(rule?.subgroup_ids),
  service_item_ids: ids(rule?.service_item_ids),
  doctor_ids: ids(rule?.doctor_ids),
  visit_types: rule?.visit_types ?? [],
  scheme_codes: rule?.scheme_codes ?? [],
  min_age: text(rule?.min_age),
  max_age: text(rule?.max_age),
  gender: text(rule?.gender),
  valid_from: text(rule?.valid_from),
  valid_to: text(rule?.valid_to),
  ...Object.fromEntries(LIMITS.map(([key]) => [key, text(rule?.[key])])),
  priority: text(rule?.priority),
  stackable: rule?.stackable ?? false,
  applies_on_scheme_rate: rule?.applies_on_scheme_rate ?? false,
  allowed_roles: rule?.allowed_roles ?? [],
});

const orNull = (value) => (value.trim() === "" ? null : value.trim());
const listOrNull = (list) => (list.length ? list : null);

const payloadOf = (form) => {
  const byCode = form.method === "code";
  return {
    name: form.name.trim(),
    method: form.method,
    code: byCode ? orNull(form.code) : null,
    kind: form.kind,
    value: form.value.trim(),
    max_discount: form.kind === "percent" ? orNull(form.max_discount) : null,
    applies_per: form.applies_per,
    group_ids: listOrNull(ids(form.group_ids)),
    subgroup_ids: listOrNull(ids(form.subgroup_ids)),
    service_item_ids: listOrNull(ids(form.service_item_ids)),
    doctor_ids: listOrNull(ids(form.doctor_ids)),
    visit_types: listOrNull(VISIT_TYPES.filter((v) => form.visit_types.includes(v))),
    scheme_codes: listOrNull([...form.scheme_codes].sort()),
    min_age: orNull(form.min_age),
    max_age: orNull(form.max_age),
    gender: form.gender || null,
    valid_from: form.valid_from || null,
    valid_to: form.valid_to || null,
    ...Object.fromEntries(LIMITS.map(([key]) => [key, orNull(form[key])])),
    priority: form.priority.trim(),
    stackable: form.stackable,
    applies_on_scheme_rate: form.applies_on_scheme_rate,
    allowed_roles: byCode
      ? listOrNull(BILLING_ROLES.filter((r) => form.allowed_roles.includes(r)))
      : null,
  };
};

const same = (key, a, b) =>
  ["value", "max_discount"].includes(key) && a !== null && b !== null
    ? Number(a) === Number(b)
    : JSON.stringify(a) === JSON.stringify(b);

function Field({ label, hint, className = "", children }) {
  const id = useId();
  return (
    <div className={`fset__field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": hint ? `${id}-hint` : undefined })}
      {hint ? (
        <small id={`${id}-hint`} className="flow-muted">
          {hint}
        </small>
      ) : null}
    </div>
  );
}

function Checks({ legend, hint, options, chosen, onToggle, scroll }) {
  return (
    <fieldset className="disc-checks">
      <legend>{legend}</legend>
      {hint ? <small className="flow-muted">{hint}</small> : null}
      <div className={`fset__checks${scroll ? " disc-checks__scroll" : ""}`}>
        {options.map((o) => (
          <label key={o.value} className={o.nested ? "disc-checks__nested" : undefined}>
            <input
              type="checkbox"
              aria-label={o.aria ?? o.label}
              checked={chosen.includes(o.value)}
              onChange={() => onToggle(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ChosenItems({ items, onRemove }) {
  if (!items.length) return <p className="fset__hint">No items chosen.</p>;
  return (
    <ul className="disc-chips" aria-label="Chosen items">
      {items.map((item) => (
        <li key={item.id} className="disc-chip">
          {item.name}
          <button
            type="button"
            className="disc-chip__remove"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

const chosenOf = (targets) => new Map((targets ?? []).map((t) => [t.id, t]));

const TARGETS = [
  "group_ids",
  "subgroup_ids",
  "service_item_ids",
  "doctor_ids",
  "visit_types",
  "scheme_codes",
  "min_age",
  "max_age",
  "gender",
];
const coversEveryone = (payload) =>
  payload.method === "auto" && TARGETS.every((key) => payload[key] === null);

export default function DiscountForm({ rule, onClose }) {
  const editing = Boolean(rule);
  const [initial] = useState(() => formOf(rule));
  const [form, setForm] = useState(initial);
  const [known, setKnown] = useState({});
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmEvery, setConfirmEvery] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const ref = useDialog(true, requestClose);
  const create = useCreateBillingDiscount();
  const update = useUpdateBillingDiscount();
  const busy = create.isPending || update.isPending;
  const { data: groups = [] } = useBillingGroups();
  const { data: tree = [] } = useBillingCategories();
  const { data: choices } = useBillingItemChoices();
  const titleId = useId();

  const put = (key, value) => {
    setConfirmEvery(false);
    setForm((f) => ({
      ...f,
      [key]: value,
      ...(key === "kind" && value === "fixed_price" ? { applies_per: "line" } : {}),
    }));
  };
  const set = (key) => (e) =>
    put(
      key,
      e.target.type === "checkbox"
        ? e.target.checked
        : DIGITS.has(key)
          ? digitsTyped(e.target.value)
          : TYPED[key]
            ? TYPED[key](e.target.value)
            : e.target.value,
    );
  const toggle = (key) => (value) => {
    setConfirmEvery(false);
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));
  };

  const groupOptions = groups.flatMap((g) => [
    ...(g.is_active || form.group_ids.includes(g.id)
      ? [{ value: `g${g.id}`, label: offLabel(g.name, g.is_active) }]
      : []),
    ...(g.subgroups ?? [])
      .filter((s) => s.is_active || form.subgroup_ids.includes(s.id))
      .map((s) => ({
        value: `s${s.id}`,
        label: offLabel(s.name, s.is_active),
        aria: `${g.name} › ${s.name}`,
        nested: true,
      })),
  ]);
  const categoryOptions = [
    { value: "general", label: "General (no category)" },
    ...tree.flatMap((top) =>
      top.is_active || form.scheme_codes.includes(top.code)
        ? [
            { value: top.code, label: offLabel(top.label, top.is_active) },
            ...(top.sub_categories ?? [])
              .filter((s) => s.is_active || form.scheme_codes.includes(s.code))
              .map((s) => ({
                value: s.code,
                label: offLabel(s.label, s.is_active),
                aria: s.display_label,
                nested: true,
              })),
          ]
        : [],
    ),
  ];
  const consultants = choices?.consultants ?? [];
  const chosenDoctors = chosenOf(rule?.doctors);
  const chosenItems = chosenOf(rule?.items);
  const doctorOptions = [
    ...consultants.map((d) => ({ value: d.id, label: d.name })),
    ...form.doctor_ids
      .filter((id) => !consultants.some((d) => d.id === id) && chosenDoctors.has(id))
      .map((id) => ({
        value: id,
        label: offLabel(chosenDoctors.get(id).name, chosenDoctors.get(id).is_active),
      })),
  ];

  const items = form.service_item_ids
    .map((id) =>
      known[id]
        ? { id, name: known[id] }
        : chosenItems.has(id)
          ? { id, name: offLabel(chosenItems.get(id).name, chosenItems.get(id).is_active) }
          : null,
    )
    .filter(Boolean);

  const payload = payloadOf(form);
  const everyBill = coversEveryone(payload) && (!editing || !coversEveryone(payloadOf(initial)));

  const save = async () => {
    setError("");
    try {
      if (!editing) {
        await create.mutateAsync(payload);
        return onClose(`Added discount ${payload.name}`);
      }
      const before = payloadOf(initial);
      const changes = Object.fromEntries(
        Object.entries(payload).filter(([key, value]) => !same(key, value, before[key])),
      );
      if (!Object.keys(changes).length) return onClose();
      await update.mutateAsync({ id: rule.id, ...changes });
      return onClose(`Saved discount ${payload.name}`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the discount"));
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (everyBill && !confirmEvery) return setConfirmEvery(true);
    return save();
  };

  const byCode = form.method === "code";

  return (
    <div className="flow-dialog-backdrop" onClick={requestClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog disc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id={titleId} className="bill-dialog__title">
          {editing ? `Edit discount ${rule.name}` : "New discount"}
        </h2>

        <fieldset className="disc-section">
          <legend>Type and value</legend>
          <div className="bill-form">
            <Field label="Name">
              <input
                className="jb-assign"
                maxLength={200}
                value={form.name}
                onChange={set("name")}
                required
              />
            </Field>
            <Field label="How it applies">
              <select className="jb-assign" value={form.method} onChange={set("method")}>
                {DISCOUNT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_CHOICE[m]}
                  </option>
                ))}
              </select>
            </Field>
            {byCode ? (
              <Field label="Code" className="fset__field--narrow disc-field--code">
                <input
                  className="jb-assign"
                  maxLength={40}
                  autoComplete="off"
                  value={form.code}
                  onChange={set("code")}
                />
              </Field>
            ) : null}
          </div>
          <div className="bill-form">
            <Field label="Kind">
              <select className="jb-assign" value={form.kind} onChange={set("kind")}>
                {DISCOUNT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={
                form.kind === "percent" ? "Percent" : form.kind === "flat" ? "₹ off" : "Price ₹"
              }
              className="fset__field--narrow"
            >
              <input
                className="jb-assign"
                inputMode="decimal"
                maxLength={14}
                value={form.value}
                onChange={set("value")}
              />
            </Field>
            {form.kind === "percent" ? (
              <Field label="Largest discount ₹" hint="Empty = no limit">
                <input
                  className="jb-assign"
                  inputMode="decimal"
                  maxLength={14}
                  value={form.max_discount}
                  onChange={set("max_discount")}
                />
              </Field>
            ) : null}
            <Field label="Applies to">
              <select className="jb-assign" value={form.applies_per} onChange={set("applies_per")}>
                <option value="line">Each line</option>
                <option value="bill" disabled={form.kind === "fixed_price"}>
                  The whole bill
                </option>
              </select>
            </Field>
          </div>
        </fieldset>

        <fieldset className="disc-section">
          <legend>What it covers</legend>
          <p className="fset__hint">
            {form.applies_per === "bill"
              ? "On the whole bill it comes off the total of the lines it covers. Nothing chosen means every line."
              : "Nothing chosen means every service."}
          </p>
          <Checks
            legend="Groups and subgroups"
            options={groupOptions}
            chosen={[
              ...form.group_ids.map((id) => `g${id}`),
              ...form.subgroup_ids.map((id) => `s${id}`),
            ]}
            onToggle={(value) =>
              toggle(value[0] === "s" ? "subgroup_ids" : "group_ids")(Number(value.slice(1)))
            }
            scroll
          />
          <div className="disc-checks">
            <DiscountItemPicker
              label="Items"
              chosenIds={form.service_item_ids}
              onPick={(item) => {
                setKnown((k) => ({ ...k, [item.id]: item.name }));
                toggle("service_item_ids")(item.id);
              }}
            />
            <ChosenItems items={items} onRemove={toggle("service_item_ids")} />
          </div>
          <Checks
            legend="Doctors"
            hint="A coupon for these consultants only; it never applies to a line without a doctor."
            options={doctorOptions}
            chosen={form.doctor_ids}
            onToggle={toggle("doctor_ids")}
            scroll
          />
          <Checks
            legend="Visit types"
            options={VISIT_TYPES.map((v) => ({ value: v, label: v }))}
            chosen={form.visit_types}
            onToggle={toggle("visit_types")}
          />
        </fieldset>

        <fieldset className="disc-section">
          <legend>Who gets it</legend>
          <Checks
            legend="Categories"
            hint="Nothing chosen means every category. A category covers its sub-categories."
            options={categoryOptions}
            chosen={form.scheme_codes}
            onToggle={toggle("scheme_codes")}
            scroll
          />
          <div className="bill-form">
            <Field label="From age" className="fset__field--narrow">
              <input
                className="jb-assign"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                placeholder="Any"
                value={form.min_age}
                onChange={set("min_age")}
              />
            </Field>
            <Field label="To age" className="fset__field--narrow">
              <input
                className="jb-assign"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                placeholder="Any"
                value={form.max_age}
                onChange={set("max_age")}
              />
            </Field>
            <Field label="Gender">
              <select className="jb-assign" value={form.gender} onChange={set("gender")}>
                <option value="">Any</option>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </fieldset>

        <fieldset className="disc-section">
          <legend>When and how much</legend>
          <div className="bill-form">
            <Field label="Valid from">
              <input
                type="date"
                className="jb-assign"
                value={form.valid_from}
                onChange={set("valid_from")}
              />
            </Field>
            <Field label="Valid to">
              <input
                type="date"
                className="jb-assign"
                min={form.valid_from || undefined}
                value={form.valid_to}
                onChange={set("valid_to")}
              />
            </Field>
          </div>
          <div className="bill-form">
            {LIMITS.map(([key, label]) => (
              <Field key={key} label={label} hint="Empty = no limit">
                <input
                  className="jb-assign"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={9}
                  value={form[key]}
                  onChange={set(key)}
                />
              </Field>
            ))}
          </div>
        </fieldset>

        <fieldset className="disc-section">
          <legend>Control</legend>
          <div className="bill-form">
            <Field label="Priority" className="fset__field--narrow" hint="Smaller wins a tie">
              <input
                className="jb-assign"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={9}
                placeholder="100"
                value={form.priority}
                onChange={set("priority")}
              />
            </Field>
            <label className="fset__check">
              <input type="checkbox" checked={form.stackable} onChange={set("stackable")} />
              Stacks with other discounts
            </label>
            <label className="fset__check">
              <input
                type="checkbox"
                checked={form.applies_on_scheme_rate}
                onChange={set("applies_on_scheme_rate")}
              />
              Also on payment-rule lines (lowers what the patient pays; the claim stays)
            </label>
          </div>
          {byCode ? (
            <Checks
              legend="Who may enter this code"
              hint="Nothing chosen means every billing role."
              options={BILLING_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }))}
              chosen={form.allowed_roles}
              onToggle={toggle("allowed_roles")}
            />
          ) : null}
        </fieldset>

        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmDiscard ? (
          <div
            key="discard"
            className="bill-dialog__actions bill-dialog__discard"
            role="group"
            aria-label="Discard changes?"
          >
            <span>Discard your changes?</span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              autoFocus
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
            <button type="button" className="flow-btn flow-btn-red" onClick={() => onClose()}>
              Discard
            </button>
          </div>
        ) : confirmEvery && everyBill ? (
          <div
            key="every"
            className="bill-dialog__actions bill-dialog__discard"
            role="group"
            aria-label="Discount every bill?"
          >
            <span>
              Nothing is chosen under what it covers or who gets it, so this automatic discount
              comes off every bill for every patient.
            </span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              autoFocus
              onClick={() => setConfirmEvery(false)}
            >
              Go back
            </button>
            <button type="button" className="flow-btn flow-btn-red" disabled={busy} onClick={save}>
              Save for every bill
            </button>
          </div>
        ) : (
          <div key="actions" className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={() => onClose()}>
              Cancel
            </button>
            <button
              type="submit"
              className="flow-btn flow-btn-primary"
              disabled={busy || !form.name.trim() || !form.value.trim()}
            >
              {editing ? "Save discount" : "Add discount"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
