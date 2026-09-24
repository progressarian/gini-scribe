import { cloneElement, useId, useState } from "react";
import { BILLING_ROLES, GENDERS, VISIT_TYPES } from "../../../shared/billingVocab.js";
import {
  useBillingCategories,
  useBillingDiscounts,
  useBillingItemChoices,
  useTestBillingRule,
} from "../../queries/hooks/useBillingMaster";
import DiscountItemPicker from "./DiscountItemPicker";
import RuleTestResult from "./RuleTestResult";
import { ROLE_LABEL } from "./discountText";
import { digitsTyped, requestErrorOf, rupees } from "./format";

function Field({ label, hint, className = "", children }) {
  const id = useId();
  return (
    <div className={`fset__field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
      {hint ? <small className="flow-muted">{hint}</small> : null}
    </div>
  );
}

const codesOf = (typed) => [
  ...new Set(
    typed
      .split(/[\s,]+/)
      .map((c) => c.trim())
      .filter(Boolean),
  ),
];

const ruleTestBody = (form) => ({
  ...(form.age.trim() ? { age: Number(form.age) } : {}),
  ...(form.gender ? { gender: form.gender } : {}),
  ...(form.category ? { category: form.category } : {}),
  ...(form.date ? { date: form.date } : {}),
  ...(form.visit_type ? { visit_type: form.visit_type } : {}),
  ...(form.doctor_id ? { doctor_id: Number(form.doctor_id) } : {}),
  ...(form.role ? { role: form.role } : {}),
  lines: form.lines.map((line) => ({
    item_id: line.id,
    ...(line.allow_quantity ? { quantity: Number(line.quantity) || 1 } : {}),
  })),
  ...(codesOf(form.codes).length ? { codes: codesOf(form.codes) } : {}),
});

const EMPTY = {
  age: "",
  gender: "",
  category: "",
  date: "",
  visit_type: "",
  doctor_id: "",
  role: "",
  codes: "",
  lines: [],
};

export default function RuleTestBox() {
  const [form, setForm] = useState(EMPTY);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [failedItem, setFailedItem] = useState(null);
  const [tested, setTested] = useState(null);
  const { data: tree = [] } = useBillingCategories({ activeOnly: true });
  const { data: choices } = useBillingItemChoices();
  const { data: rules } = useBillingDiscounts({ activeOnly: false });
  const test = useTestBillingRule();
  const rulesNow = JSON.stringify(rules ?? null);
  const stale =
    result && tested && (tested.form !== JSON.stringify(form) || tested.rules !== rulesNow);
  const set = (key, typed) => (e) =>
    setForm({ ...form, [key]: typed ? typed(e.target.value) : e.target.value });
  const setLine = (id, quantity) =>
    setForm({
      ...form,
      lines: form.lines.map((line) => (line.id === id ? { ...line, quantity } : line)),
    });

  const run = async (e) => {
    e.preventDefault();
    setError("");
    setFailedItem(null);
    const snapshot = { form: JSON.stringify(form), rules: rulesNow };
    try {
      setResult(await test.mutateAsync(ruleTestBody(form)));
      setTested(snapshot);
    } catch (err) {
      setResult(null);
      setError(requestErrorOf(err, "Could not test the rule"));
      const lineNo = err?.response?.data?.line_no;
      setFailedItem(Number.isInteger(lineNo) ? (form.lines[lineNo - 1]?.id ?? null) : null);
    }
  };

  return (
    <section className="flow-card disc-test" aria-labelledby="disc-test-title">
      <div className="fset__cardhead">
        <h2 id="disc-test-title" className="flow-sec-title">
          Test this rule
        </h2>
      </div>
      <div className="fset__cardsub">
        Price a made-up bill the way the Billing Counter would — nothing is saved and no limit is
        used up.
      </div>
      <form aria-label="Test a bill" onSubmit={run}>
        <div className="bill-form">
          <Field label="Test age" className="fset__field--narrow" hint="Empty = unknown">
            <input
              className="jb-assign"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              placeholder="e.g. 65"
              value={form.age}
              onChange={set("age", digitsTyped)}
            />
          </Field>
          <Field label="Test gender">
            <select className="jb-assign" value={form.gender} onChange={set("gender")}>
              <option value="">Unknown</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Test category">
            <select className="jb-assign" value={form.category} onChange={set("category")}>
              <option value="">General</option>
              {tree.map((top) =>
                top.sub_categories?.length ? (
                  <optgroup key={top.code} label={top.label}>
                    {top.sub_categories.map((sub) => (
                      <option key={sub.code} value={sub.code}>
                        {sub.display_label}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={top.code} value={top.code}>
                    {top.label}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Test visit type">
            <select className="jb-assign" value={form.visit_type} onChange={set("visit_type")}>
              <option value="">Not set</option>
              {VISIT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Test doctor">
            <select className="jb-assign" value={form.doctor_id} onChange={set("doctor_id")}>
              <option value="">None</option>
              {(choices?.consultants ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Test date">
            <input type="date" className="jb-assign" value={form.date} onChange={set("date")} />
          </Field>
          <Field label="Test as role">
            <select className="jb-assign" value={form.role} onChange={set("role")}>
              <option value="">My own role</option>
              {BILLING_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="disc-test__items">
          <DiscountItemPicker
            label="Test items"
            chosenIds={form.lines.map((line) => line.id)}
            onPick={(item) =>
              setForm({
                ...form,
                lines: [
                  ...form.lines,
                  {
                    id: item.id,
                    name: item.name,
                    base_price: item.base_price,
                    allow_quantity: item.allow_quantity,
                    quantity: "1",
                  },
                ],
              })
            }
          />
          {form.lines.length ? (
            <ol className="disc-test__lines" aria-label="Items on the test bill">
              {form.lines.map((line, index) => (
                <li key={line.id} className={line.id === failedItem ? "disc-test__failed" : ""}>
                  <span>
                    {`Line ${index + 1}: ${line.name}`}
                    <span className="flow-muted disc-picker__meta">{rupees(line.base_price)}</span>
                    {line.id === failedItem ? (
                      <strong className="disc-test__why">This line was refused — see below</strong>
                    ) : null}
                  </span>
                  {line.allow_quantity ? (
                    <label className="fset__check">
                      Quantity
                      <input
                        className="jb-assign disc-test__qty"
                        aria-label={`Quantity of ${line.name}`}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={4}
                        value={line.quantity}
                        onChange={(e) => setLine(line.id, digitsTyped(e.target.value))}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost flow-btn-mini"
                    aria-label={`Remove ${line.name} from the test`}
                    onClick={() =>
                      setForm({ ...form, lines: form.lines.filter((l) => l.id !== line.id) })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="fset__hint">Add at least one item to test.</p>
          )}
        </div>
        <div className="bill-form">
          <Field label="Codes entered at the desk">
            <input
              className="jb-assign"
              placeholder="e.g. CC50, SENIOR10"
              autoComplete="off"
              maxLength={900}
              value={form.codes}
              onChange={set("codes")}
            />
          </Field>
        </div>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bill-dialog__actions">
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => {
              setForm(EMPTY);
              setResult(null);
              setError("");
              setFailedItem(null);
            }}
          >
            Clear
          </button>
          <button
            type="submit"
            className="flow-btn flow-btn-primary"
            disabled={!form.lines.length || test.isPending}
          >
            {test.isPending ? "Testing…" : "Test"}
          </button>
        </div>
      </form>
      {stale ? (
        <p className="disc-test__stale" role="status">
          The test bill or the discounts changed after this test — these numbers are out of date.
          Press Test again.
        </p>
      ) : null}
      {result ? <RuleTestResult result={result} stale={stale} /> : null}
    </section>
  );
}
