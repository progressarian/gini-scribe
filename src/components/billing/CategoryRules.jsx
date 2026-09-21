import { useId, useState } from "react";
import { CATEGORY_RULE_MODES, GENDERS } from "../../../shared/billingVocab.js";
import {
  useBillingCategoryRules,
  useCreateBillingCategoryRule,
  useDeleteBillingCategoryRule,
  useSetBillingCategoryRuleActive,
  useUpdateBillingCategoryRule,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { digitsTyped, errorOf } from "./format";

const MODE_LABEL = { suggest: "Suggest — the desk confirms", auto: "Automatic" };
const EMPTY = {
  name: "",
  min_age: "",
  max_age: "",
  gender: "",
  requires_card: false,
  mode: CATEGORY_RULE_MODES[0],
  priority: "",
};

const text = (v) => (v === null || v === undefined ? "" : String(v));
const formOf = (rule) =>
  rule
    ? {
        name: rule.name,
        min_age: text(rule.min_age),
        max_age: text(rule.max_age),
        gender: text(rule.gender),
        requires_card: rule.requires_card,
        mode: rule.mode,
        priority: text(rule.priority),
      }
    : EMPTY;
const payloadOf = (form) => ({
  ...form,
  name: form.name.trim(),
  min_age: form.min_age.trim(),
  max_age: form.max_age.trim(),
  priority: form.priority.trim(),
});

const DIGIT_FIELDS = new Set(["min_age", "max_age", "priority"]);

const ageOf = (rule) =>
  rule.min_age === null && rule.max_age === null
    ? "Any age"
    : rule.max_age === null
      ? `${rule.min_age}+`
      : rule.min_age === null
        ? `Up to ${rule.max_age}`
        : `${rule.min_age}–${rule.max_age}`;

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

function RuleForm({ schemeCode, rule, onDone }) {
  const [form, setForm] = useState(() => formOf(rule));
  const [error, setError] = useState("");
  const create = useCreateBillingCategoryRule();
  const update = useUpdateBillingCategoryRule();
  const set = (key) => (e) =>
    setForm({
      ...form,
      [key]:
        e.target.type === "checkbox"
          ? e.target.checked
          : DIGIT_FIELDS.has(key)
            ? digitsTyped(e.target.value)
            : e.target.value,
    });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const after = payloadOf(form);
    try {
      if (rule) {
        const before = payloadOf(formOf(rule));
        const changes = Object.fromEntries(
          Object.entries(after).filter(([key, value]) => String(value) !== String(before[key])),
        );
        if (Object.keys(changes).length) await update.mutateAsync({ id: rule.id, ...changes });
      } else {
        await create.mutateAsync({ scheme_code: schemeCode, ...after });
        setForm(EMPTY);
      }
      toast(`Saved rule ${after.name}`, "success");
      onDone?.();
    } catch (err) {
      setError(errorOf(err, "Could not save the rule"));
    }
  };

  return (
    <form
      className="bill-rule-form"
      aria-label={rule ? `Edit rule ${rule.name}` : "Add a rule"}
      onSubmit={submit}
    >
      <div className="bill-form">
        <Field label="Rule name">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              maxLength={200}
              value={form.name}
              onChange={set("name")}
            />
          )}
        </Field>
        <Field label="From age" narrow>
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              placeholder="Any"
              value={form.min_age}
              onChange={set("min_age")}
            />
          )}
        </Field>
        <Field label="To age" narrow>
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              placeholder="Any"
              value={form.max_age}
              onChange={set("max_age")}
            />
          )}
        </Field>
        <Field label="Gender">
          {(id) => (
            <select id={id} className="jb-assign" value={form.gender} onChange={set("gender")}>
              <option value="">Any</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="How it applies">
          {(id) => (
            <select id={id} className="jb-assign" value={form.mode} onChange={set("mode")}>
              {CATEGORY_RULE_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Priority" narrow hint="Smaller is checked first">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={9}
              placeholder="100"
              value={form.priority}
              onChange={set("priority")}
            />
          )}
        </Field>
        <label className="fset__check">
          <input type="checkbox" checked={form.requires_card} onChange={set("requires_card")} />
          Has a card
        </label>
      </div>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bill-dialog__actions">
        {rule ? (
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onDone}>
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className="flow-btn flow-btn-primary"
          disabled={!form.name.trim() || create.isPending || update.isPending}
        >
          {rule ? "Save rule" : "+ Add rule"}
        </button>
      </div>
    </form>
  );
}

function RuleRow({ rule, onEdit }) {
  const [confirming, setConfirming] = useState(false);
  const setActive = useSetBillingCategoryRuleActive();
  const remove = useDeleteBillingCategoryRule();
  const attempt = async (work, message) => {
    try {
      await work();
      toast(message, "success");
    } catch (err) {
      toast(errorOf(err), "error");
    }
  };
  return (
    <tr className={rule.is_active ? "" : "fset__row--off"}>
      <td>{rule.name}</td>
      <td>{ageOf(rule)}</td>
      <td>{rule.gender ?? "Any"}</td>
      <td>{rule.requires_card ? "Yes" : "—"}</td>
      <td>{rule.mode === "auto" ? "Automatic" : "Suggest"}</td>
      <td>{rule.priority}</td>
      <td className="bill-items__actions">
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`Edit rule ${rule.name}`}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`${rule.is_active ? "Deactivate" : "Activate"} rule ${rule.name}`}
          onClick={() =>
            attempt(
              () => setActive.mutateAsync({ id: rule.id, is_active: !rule.is_active }),
              `Rule ${rule.name} ${rule.is_active ? "deactivated" : "activated"}`,
            )
          }
        >
          {rule.is_active ? "Deactivate" : "Activate"}
        </button>
        {confirming ? (
          <button
            type="button"
            className="flow-btn flow-btn-red flow-btn-mini"
            aria-label={`Confirm delete rule ${rule.name}`}
            onClick={() => {
              setConfirming(false);
              attempt(() => remove.mutateAsync(rule.id), `Deleted rule ${rule.name}`);
            }}
          >
            Confirm delete
          </button>
        ) : null}
        {confirming ? (
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            aria-label={`Cancel deleting rule ${rule.name}`}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            aria-label={`Delete rule ${rule.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

function MoveRule({ rule, targets }) {
  const [target, setTarget] = useState("");
  const update = useUpdateBillingCategoryRule();
  const id = useId();
  const move = async () => {
    try {
      await update.mutateAsync({ id: rule.id, scheme_code: target });
      toast(`Moved rule ${rule.name}`, "success");
    } catch (err) {
      toast(errorOf(err), "error");
    }
  };
  return (
    <li className="bill-rule-move">
      <span>{rule.name}</span>
      <label htmlFor={id} className="bill-visually-hidden">
        Move {rule.name} to
      </label>
      <select
        id={id}
        className="jb-assign"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">Move to…</option>
        {targets.map((t) => (
          <option key={t.code} value={t.code}>
            {t.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="flow-btn flow-btn-primary flow-btn-mini"
        disabled={!target || update.isPending}
        onClick={move}
      >
        Move
      </button>
    </li>
  );
}

export default function CategoryRules({ category }) {
  const {
    data: rules = [],
    isLoading,
    isError,
  } = useBillingCategoryRules({
    schemeCode: category.code,
  });
  const [editing, setEditing] = useState(null);
  const name = category.display_label || category.label;
  const children = category.sub_categories ?? [];

  return (
    <section className="flow-card" aria-label={`Who belongs to ${name}`}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Who belongs</h2>
        <span className="fset__count">{rules.length}</span>
      </div>
      <div className="fset__cardsub">
        Rules the Billing Counter uses to suggest (or set) {name} for a patient.
      </div>
      <p className="fset__hint">
        When a patient matches more than one rule, the one with the smaller priority number is used;
        an empty priority counts as 100.
      </p>
      {isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : isError ? (
        <div className="fset__cardsub">Could not load the rules.</div>
      ) : children.length ? (
        <>
          <p className="fset__hint">
            {name} has sub-categories, so a patient is billed under one of them. Put rules on a
            sub-category.
          </p>
          {rules.length ? (
            <ul className="bill-rule-moves" aria-label="Rules to move">
              {rules.map((rule) => (
                <MoveRule key={rule.id} rule={rule} targets={children.filter((c) => c.is_active)} />
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <>
          {rules.length ? (
            <div className="fset__scroll">
              <table className="flow-table" aria-label="Rules">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Age</th>
                    <th>Gender</th>
                    <th>Card</th>
                    <th>How</th>
                    <th>Priority</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) =>
                    editing === rule.id ? (
                      <tr key={rule.id}>
                        <td colSpan={7}>
                          <RuleForm
                            schemeCode={category.code}
                            rule={rule}
                            onDone={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <RuleRow key={rule.id} rule={rule} onEdit={() => setEditing(rule.id)} />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="fset__cardsub">No rules yet — the desk picks {name} by hand.</div>
          )}
          {category.is_active ? <RuleForm key={category.code} schemeCode={category.code} /> : null}
        </>
      )}
    </section>
  );
}
