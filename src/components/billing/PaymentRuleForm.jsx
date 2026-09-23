import { useEffect, useId, useRef, useState } from "react";
import { PATIENT_PAYS, VISIT_TYPES } from "../../../shared/billingVocab.js";
import {
  useBillingGroups,
  useBillingItems,
  useCreateBillingPaymentRule,
  useTestBillingRule,
  useUpdateBillingPaymentRule,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { digitsTyped, moneyTyped, requestErrorOf, rupees } from "./format";

export const PAYS_LABEL = {
  full: "Full price",
  amount: "A fixed amount (₹)",
  percent: "A percent of the price",
  nothing: "Nothing",
};
const SCOPE_LABEL = {
  category: "The whole category",
  group: "A group",
  subgroup: "A subgroup",
  item: "One item",
};
const SCOPE_KEY = { group: "group_id", subgroup: "subgroup_id", item: "service_item_id" };

const text = (v) => (v === null || v === undefined ? "" : String(v));
const scopeOf = (rule) =>
  rule?.service_item_id
    ? "item"
    : rule?.subgroup_id
      ? "subgroup"
      : rule?.group_id
        ? "group"
        : "category";

const formOf = (rule, defaultRemainder) =>
  rule
    ? {
        name: rule.name,
        scope: scopeOf(rule),
        group_id: text(rule.group_id),
        subgroup_id: text(rule.subgroup_id),
        service_item_id: text(rule.service_item_id),
        visit_types: rule.visit_types ?? [],
        patient_pays: rule.patient_pays,
        patient_value: text(rule.patient_value),
        remainder:
          rule.patient_pays === "full" ? defaultRemainder : (rule.remainder ?? defaultRemainder),
        valid_from: text(rule.valid_from),
        valid_to: text(rule.valid_to),
        priority: text(rule.priority),
      }
    : {
        name: "",
        scope: "category",
        group_id: "",
        subgroup_id: "",
        service_item_id: "",
        visit_types: [],
        patient_pays: "amount",
        patient_value: "",
        remainder: defaultRemainder,
        valid_from: "",
        valid_to: "",
        priority: "",
      };

const takesValue = (pays) => pays === "amount" || pays === "percent";

const payloadOf = (form) => ({
  name: form.name.trim(),
  group_id: form.scope === "group" ? form.group_id || null : null,
  subgroup_id: form.scope === "subgroup" ? form.subgroup_id || null : null,
  service_item_id: form.scope === "item" ? form.service_item_id || null : null,
  visit_types: form.visit_types.length
    ? VISIT_TYPES.filter((v) => form.visit_types.includes(v))
    : null,
  patient_pays: form.patient_pays,
  patient_value: takesValue(form.patient_pays) ? form.patient_value.trim() : null,
  remainder: form.patient_pays === "full" ? "" : form.remainder,
  valid_from: form.valid_from,
  valid_to: form.valid_to || null,
  priority: form.priority.trim(),
});

function missingOf(form) {
  if (!form.name.trim()) return "Give the rule a name";
  if (form.scope !== "category" && !form[SCOPE_KEY[form.scope]]) {
    return `Choose the ${form.scope} the rule is for`;
  }
  if (takesValue(form.patient_pays) && !form.patient_value.trim()) {
    return form.patient_pays === "amount"
      ? "Enter the amount in rupees the patient pays"
      : "Enter the percent the patient pays";
  }
  return "";
}

const DRAFT_NAME = "Draft rule";

function draftOf(form) {
  if (form.scope !== "category" && !form[SCOPE_KEY[form.scope]]) return null;
  if (takesValue(form.patient_pays) && !form.patient_value.trim()) return null;
  return {
    ...(form.scope === "category"
      ? {}
      : { [SCOPE_KEY[form.scope]]: Number(form[SCOPE_KEY[form.scope]]) }),
    ...(form.visit_types.length
      ? { visit_types: VISIT_TYPES.filter((v) => form.visit_types.includes(v)) }
      : {}),
    patient_pays: form.patient_pays,
    ...(takesValue(form.patient_pays) ? { patient_value: form.patient_value.trim() } : {}),
    ...(form.patient_pays === "full" ? {} : { remainder: form.remainder }),
  };
}

function Field({ label, narrow, hint, children }) {
  const id = useId();
  return (
    <div className={`fset__field${narrow ? " fset__field--narrow" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <small className="flow-muted">{hint}</small> : null}
    </div>
  );
}

function ItemPicker({ label, value, onChange, filters, current }) {
  const [q, setQ] = useState("");
  const { data, isLoading } = useBillingItems({ ...filters, q, active: "true", limit: "50" });
  const found = data?.items ?? [];
  const missing = value && current && !found.some((i) => String(i.id) === String(value));
  const more = (data?.total ?? 0) > found.length;
  return (
    <>
      <Field
        label={`Find ${label.toLowerCase()}`}
        hint={
          more
            ? `Showing the first ${found.length} of ${data.total} — type more of the name or code to narrow`
            : ""
        }
      >
        {(id) => (
          <input
            id={id}
            type="search"
            className="jb-assign"
            placeholder="Item name or code"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </Field>
      <Field label={label}>
        {(id) => (
          <select
            id={id}
            className="jb-assign"
            value={value}
            onChange={(e) =>
              onChange(
                e.target.value,
                found.find((i) => String(i.id) === e.target.value),
              )
            }
          >
            <option value="">
              {isLoading ? "Loading…" : found.length ? "Choose an item" : "No item matches"}
            </option>
            {missing ? <option value={value}>{current.name}</option> : null}
            {found.map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.name} (${item.code}) — ${rupees(item.base_price)}`}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

function Split({ label, line, pays, rest, restLabel }) {
  return (
    <div className="pr-preview__split" role="group" aria-label={label}>
      <span className="pr-preview__label">{label}</span>
      <span>
        Actual {rupees(line.actual / 100)}
        {line.total !== line.actual ? ` (${rupees(line.total / 100)} with tax)` : ""}
      </span>
      <span aria-hidden="true">→</span>
      <span>Patient pays {rupees(pays / 100)}</span>
      <span aria-hidden="true">→</span>
      <span>
        Rest {rupees(rest / 100)}
        {rest > 0 && restLabel ? ` ${restLabel}` : ""}
      </span>
    </div>
  );
}

function Preview({ category, form, payer, scopeItem }) {
  const [picked, setPicked] = useState(null);
  const scopeKey = `${form.scope}-${form.group_id}-${form.subgroup_id}`;
  const item = picked?.scopeKey === scopeKey ? picked.item : null;
  const [visitType, setVisitType] = useState("");
  const [result, setResult] = useState(null);
  const [draftResult, setDraftResult] = useState(null);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const trial = useTestBillingRule();
  const seq = useRef(0);
  const chosen = form.scope === "item" ? scopeItem : item;
  const ownVisit = chosen?.visit_type ?? null;
  const visitChoices = form.visit_types.length ? form.visit_types : VISIT_TYPES;
  const visit = ownVisit ?? (visitChoices.includes(visitType) ? visitType : visitChoices[0]);
  const date = form.valid_from || undefined;
  const itemId = chosen?.id ?? null;
  const draft = draftOf(form);
  const draftKey = JSON.stringify(draft);

  useEffect(() => {
    const mine = ++seq.current;
    if (!itemId) {
      setResult(null);
      setDraftResult(null);
      setError("");
      setDraftError("");
      return;
    }
    const price = (extra) =>
      trial.mutateAsync({
        category: category.code,
        visit_type: visit,
        date,
        lines: [{ item_id: itemId }],
        ...extra,
      });
    const timer = setTimeout(() => {
      price({})
        .then((data) => {
          if (mine !== seq.current) return;
          setResult(data);
          setError("");
        })
        .catch((err) => {
          if (mine !== seq.current) return;
          setResult(null);
          setError(requestErrorOf(err, "Could not price the item"));
        });
      if (!draft) {
        setDraftResult(null);
        setDraftError("");
        return;
      }
      price({ draft_rule: draft })
        .then((data) => {
          if (mine !== seq.current) return;
          setDraftResult(data);
          setDraftError("");
        })
        .catch((err) => {
          if (mine !== seq.current) return;
          setDraftResult(null);
          setDraftError(requestErrorOf(err, "Could not price this rule"));
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [itemId, visit, date, category.code, draftKey]);

  const line = result?.lines?.[0];
  const draftLine = draftResult?.lines?.[0];
  const covered = draftLine?.payment_rule_name === DRAFT_NAME;
  const restLabel =
    form.remainder === "claim" ? `claimed${payer ? ` from ${payer}` : ""}` : "to adjustment";
  const filters =
    form.scope === "group"
      ? { groupId: form.group_id }
      : form.scope === "subgroup"
        ? { subgroupId: form.subgroup_id }
        : {};

  return (
    <section className="pr-preview" aria-label="Preview">
      <h3 className="pr-preview__title">Preview</h3>
      <div className="bill-form">
        {form.scope === "item" ? (
          <p className="fset__hint">
            {scopeItem ? `Pricing ${scopeItem.name}.` : "Choose the item above to preview it."}
          </p>
        ) : (
          <ItemPicker
            key={scopeKey}
            label="Preview item"
            value={item ? String(item.id) : ""}
            onChange={(_, found) => setPicked(found ? { scopeKey, item: found } : null)}
            filters={filters}
            current={item}
          />
        )}
        {ownVisit ? (
          <p className="fset__hint">This item is always a {ownVisit} visit.</p>
        ) : (
          <Field label="Preview visit type">
            {(id) => (
              <select
                id={id}
                className="jb-assign"
                value={visit}
                onChange={(e) => setVisitType(e.target.value)}
              >
                {visitChoices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
      {!chosen ? (
        <p className="fset__hint">
          Pick an item to see the actual price, what the patient pays and the rest.
        </p>
      ) : error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : !line ? (
        <p className="fset__hint">Pricing…</p>
      ) : (
        <>
          {draftError ? (
            <p className="bill-dialog__error" role="alert">
              {draftError}
            </p>
          ) : !draft ? (
            <p className="fset__hint">Fill in what the patient pays to see this rule's numbers.</p>
          ) : !draftLine ? (
            <p className="fset__hint">Pricing this rule…</p>
          ) : covered ? (
            <>
              <Split
                label="With this rule"
                line={draftLine}
                pays={draftLine.patient_payable}
                rest={draftLine.claim + draftLine.adjustment}
                restLabel={restLabel}
              />
              {draftLine.discount ? (
                <p className="fset__hint">
                  Discounts take off {rupees(draftLine.discount / 100)}, already counted above.
                </p>
              ) : null}
            </>
          ) : (
            <p className="fset__hint">
              This rule doesn't cover {visit} visits, so it doesn't change this item.
            </p>
          )}
          <Split
            label="With the saved rules"
            line={line}
            pays={line.patient_payable}
            rest={line.claim + line.adjustment}
            restLabel={line.claim ? "claimed" : line.adjustment ? "to adjustment" : ""}
          />
          <p className="fset__hint">
            Saved rules today:{" "}
            {line.payment_rule_text === "full" ? "full price" : line.payment_rule_text}
            {line.payment_rule_id ? "" : " — no rule covers it yet"}.
          </p>
        </>
      )}
    </section>
  );
}

export function CheaperItems({ amount, items }) {
  return (
    <div className="pr-cheaper" role="alert">
      <p>
        {items.length === 1
          ? `The patient can't pay ${rupees(amount)} for this item — it costs less:`
          : `The patient can't pay ${rupees(amount)} for these items — they cost less:`}
      </p>
      <ul aria-label="Items that cost less">
        {items.map((item) => (
          <li key={`${item.id}-${item.sub_category ?? ""}-${item.from ?? ""}`}>
            {item.name} ({item.code}) — {rupees(item.price)}
            {item.sub_category ? ` for ${item.sub_category}` : ""}
            {item.from ? ` from ${item.from}` : ""}
          </li>
        ))}
      </ul>
      <p>Lower the amount, or put the rule on only the items it is meant for.</p>
    </div>
  );
}

export default function PaymentRuleForm({ category, payer, rule, onDone }) {
  const defaultRemainder = payer ? "claim" : "adjustment";
  const [form, setForm] = useState(() => formOf(rule, defaultRemainder));
  const [scopeItem, setScopeItem] = useState(() =>
    rule?.service_item_id ? { id: rule.service_item_id, name: rule.scope_label } : null,
  );
  const [error, setError] = useState("");
  const [cheaper, setCheaper] = useState(null);
  const [tried, setTried] = useState(false);
  const { data: groups = [] } = useBillingGroups({ activeOnly: true });
  const create = useCreateBillingPaymentRule();
  const update = useUpdateBillingPaymentRule();
  const busy = create.isPending || update.isPending;
  const missing = missingOf(form);

  const change = (key, value) => {
    setError("");
    setCheaper(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const set = (key, typed) => (e) => change(key, typed ? typed(e.target.value) : e.target.value);
  const toggleVisit = (v) => (e) =>
    change(
      "visit_types",
      e.target.checked ? [...form.visit_types, v] : form.visit_types.filter((x) => x !== v),
    );

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    setError("");
    setCheaper(null);
    if (missing) return;
    const body = payloadOf(form);
    try {
      if (rule) await update.mutateAsync({ id: rule.id, ...body });
      else await create.mutateAsync({ scheme_code: category.code, ...body });
      toast(`Saved payment rule ${body.name}`, "success");
      if (!rule) {
        setForm(formOf(null, defaultRemainder));
        setScopeItem(null);
        setTried(false);
      }
      onDone?.();
    } catch (err) {
      const items = err?.response?.status === 409 ? err.response.data?.items : null;
      if (items?.length) setCheaper({ amount: body.patient_value, items });
      else setError(requestErrorOf(err, "Could not save the payment rule"));
    }
  };

  const subgroups = groups.filter((g) => g.subgroups.length);

  return (
    <form
      className="bill-rule-form pr-form"
      aria-label={rule ? `Edit payment rule ${rule.name}` : "Add a payment rule"}
      onSubmit={submit}
      noValidate
    >
      <div className="bill-form">
        <Field label="Rule name">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              maxLength={200}
              autoFocus
              placeholder="CGHS Paid — consultation ₹700"
              value={form.name}
              onChange={set("name")}
            />
          )}
        </Field>
        <Field label="Applies to">
          {(id) => (
            <select id={id} className="jb-assign" value={form.scope} onChange={set("scope")}>
              {Object.entries(SCOPE_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {form.scope === "group" ? (
          <Field label="Group">
            {(id) => (
              <select
                id={id}
                className="jb-assign"
                value={form.group_id}
                onChange={set("group_id")}
              >
                <option value="">Choose a group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {form.scope === "subgroup" ? (
          <Field label="Subgroup">
            {(id) => (
              <select
                id={id}
                className="jb-assign"
                value={form.subgroup_id}
                onChange={set("subgroup_id")}
              >
                <option value="">Choose a subgroup</option>
                {subgroups.map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.subgroups.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {form.scope === "item" ? (
          <ItemPicker
            label="Item"
            value={form.service_item_id}
            current={scopeItem}
            onChange={(value, picked) => {
              change("service_item_id", value);
              setScopeItem(picked ?? null);
            }}
            filters={{}}
          />
        ) : null}
      </div>
      <fieldset className="pr-visits">
        <legend>Visit types</legend>
        {VISIT_TYPES.map((v) => (
          <label key={v} className="fset__check">
            <input
              type="checkbox"
              checked={form.visit_types.includes(v)}
              onChange={toggleVisit(v)}
            />
            {v}
          </label>
        ))}
        <small className="flow-muted">None ticked means every visit.</small>
      </fieldset>
      <div className="bill-form">
        <Field label="Patient pays">
          {(id) => (
            <select
              id={id}
              className="jb-assign"
              value={form.patient_pays}
              onChange={set("patient_pays")}
            >
              {PATIENT_PAYS.map((p) => (
                <option key={p} value={p}>
                  {PAYS_LABEL[p]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {takesValue(form.patient_pays) ? (
          <Field label={form.patient_pays === "amount" ? "Amount (₹)" : "Percent (%)"} narrow>
            {(id) => (
              <input
                id={id}
                className="jb-assign"
                inputMode="decimal"
                maxLength={form.patient_pays === "amount" ? 13 : 6}
                placeholder={form.patient_pays === "amount" ? "700" : "20"}
                value={form.patient_value}
                onChange={set("patient_value", moneyTyped)}
              />
            )}
          </Field>
        ) : null}
        {form.patient_pays === "full" ? null : (
          <Field label="The rest">
            {(id) => (
              <select
                id={id}
                className="jb-assign"
                value={form.remainder}
                onChange={set("remainder")}
              >
                <option value="claim">
                  {payer ? `Claimed from ${payer}` : "Claimed (needs a payer name)"}
                </option>
                <option value="adjustment">Adjustment — the hospital absorbs it</option>
              </select>
            )}
          </Field>
        )}
        <Field label="From" narrow hint="Blank means today">
          {(id) => (
            <input
              id={id}
              type="date"
              className="jb-assign"
              value={form.valid_from}
              onChange={set("valid_from")}
            />
          )}
        </Field>
        <Field label="To" narrow hint="Blank means no end">
          {(id) => (
            <input
              id={id}
              type="date"
              className="jb-assign"
              value={form.valid_to}
              onChange={set("valid_to")}
            />
          )}
        </Field>
        <Field label="Priority" narrow hint="Smaller wins at the same level">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={9}
              placeholder="100"
              value={form.priority}
              onChange={set("priority", digitsTyped)}
            />
          )}
        </Field>
      </div>
      <Preview category={category} form={form} payer={payer} scopeItem={scopeItem} />
      {tried && missing ? (
        <p className="bill-dialog__error" role="alert">
          {missing}
        </p>
      ) : null}
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      {cheaper ? <CheaperItems amount={cheaper.amount} items={cheaper.items} /> : null}
      <div className="bill-dialog__actions">
        <button type="button" className="flow-btn flow-btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
          {rule ? "Save payment rule" : "Add payment rule"}
        </button>
      </div>
    </form>
  );
}
