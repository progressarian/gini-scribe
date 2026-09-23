import { useRef, useState } from "react";
import {
  useBillingPaymentRules,
  useDeleteBillingPaymentRule,
  useSetBillingPaymentRuleActive,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import PaymentRuleForm from "./PaymentRuleForm";
import { requestErrorOf, rupees } from "./format";
import "../../pages/billing/paymentRules.css";

const SCOPE_NOUN = { group: "Group", subgroup: "Subgroup", item: "Item" };

const scopeText = (rule) =>
  rule.scope === "category" ? "Whole category" : `${SCOPE_NOUN[rule.scope]}: ${rule.scope_label}`;
const visitsText = (rule) => (rule.visit_types?.length ? rule.visit_types.join(", ") : "Any visit");
const paysText = (rule) =>
  rule.patient_pays === "amount"
    ? rupees(rule.patient_value)
    : rule.patient_pays === "percent"
      ? `${rule.patient_value}%`
      : rule.patient_pays === "full"
        ? "Full price"
        : "Nothing";
const restText = (rule) =>
  rule.patient_pays === "full" ? "—" : rule.remainder === "claim" ? "Claim" : "Adjustment";
const datesText = (rule) =>
  rule.valid_to ? `${rule.valid_from} – ${rule.valid_to}` : `From ${rule.valid_from}`;

const COLUMNS = [
  "Rule",
  "Applies to",
  "Visits",
  "Patient pays",
  "The rest",
  "Dates",
  "Priority",
  "Status",
];

function RuleCells({ rule }) {
  return (
    <>
      <td>{rule.name}</td>
      <td>{scopeText(rule)}</td>
      <td>{visitsText(rule)}</td>
      <td>{paysText(rule)}</td>
      <td>{restText(rule)}</td>
      <td>{datesText(rule)}</td>
      <td>{rule.priority}</td>
      <td>{rule.is_active ? "Active" : "Inactive"}</td>
    </>
  );
}

function RuleRow({ rule, focused, onEdit, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const setActive = useSetBillingPaymentRuleActive();
  const remove = useDeleteBillingPaymentRule();
  const toggle = async () => {
    try {
      await setActive.mutateAsync({ id: rule.id, is_active: !rule.is_active });
      toast(`Payment rule ${rule.name} ${rule.is_active ? "deactivated" : "activated"}`, "success");
    } catch (err) {
      toast(requestErrorOf(err, "Could not change the payment rule"), "error", 8000);
    }
  };
  const confirmDelete = async () => {
    try {
      await remove.mutateAsync(rule.id);
      toast(`Deleted payment rule ${rule.name}`, "success");
      onDeleted();
    } catch (err) {
      setConfirming(false);
      toast(requestErrorOf(err, "Could not delete the payment rule"), "error", 8000);
    }
  };
  return (
    <tr className={rule.is_active ? "" : "fset__row--off"}>
      <RuleCells rule={rule} />
      <td className="bill-items__actions">
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`Edit payment rule ${rule.name}`}
          autoFocus={focused}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`${rule.is_active ? "Deactivate" : "Activate"} payment rule ${rule.name}`}
          disabled={setActive.isPending}
          onClick={toggle}
        >
          {rule.is_active ? "Deactivate" : "Activate"}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-red flow-btn-mini"
              aria-label={`Confirm delete payment rule ${rule.name}`}
              disabled={remove.isPending}
              onClick={confirmDelete}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Cancel deleting payment rule ${rule.name}`}
              autoFocus
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            aria-label={`Delete payment rule ${rule.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

function Head({ actions }) {
  return (
    <thead>
      <tr>
        {COLUMNS.map((c) => (
          <th key={c}>{c}</th>
        ))}
        {actions ? <th /> : null}
      </tr>
    </thead>
  );
}

export default function PaymentRules({ category, parent }) {
  const {
    data: rules = [],
    isLoading,
    isError,
  } = useBillingPaymentRules({
    schemeCode: category.code,
  });
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [focusBack, setFocusBack] = useState(null);
  const addRef = useRef(null);
  const name = category.display_label || category.label;
  const payer = category.payer_name || parent?.payer_name || "";
  const own = rules.filter((r) => !r.inherited);
  const inherited = rules.filter((r) => r.inherited);
  const hasSubs = (category.sub_categories ?? []).length > 0;

  const edit = (id) => {
    setFocusBack(null);
    setEditing(id);
  };
  const closeEdit = (id) => {
    setFocusBack(id);
    setEditing(null);
  };

  return (
    <section className="flow-card pr-panel" aria-label={`What the patient pays for ${name}`}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">What the patient pays</h2>
        <span className="fset__count">{own.length}</span>
      </div>
      <div className="fset__cardsub">
        A {name} patient pays in full unless a rule here says otherwise. The rest is claimed from
        the payer or written off as an adjustment.
      </div>
      <p className="fset__hint">
        The most specific rule wins: an item beats a subgroup, a subgroup beats a group, a group
        beats the whole category
        {parent ? `; ${name}'s own rules beat ${parent.label}'s` : ""}. Between rules at the same
        level, the smaller priority number wins.
        {hasSubs
          ? ` Rules here apply to every ${name} sub-category that has no rule of its own.`
          : ""}
      </p>
      {isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : isError ? (
        <div className="fset__cardsub">Could not load the payment rules.</div>
      ) : (
        <>
          {own.length ? (
            <div className="fset__scroll fset__scroll--wide">
              <table className="flow-table" aria-label="Payment rules">
                <Head actions={category.is_active} />
                <tbody>
                  {own.map((rule) =>
                    !category.is_active ? (
                      <tr key={rule.id} className={rule.is_active ? "" : "fset__row--off"}>
                        <RuleCells rule={rule} />
                      </tr>
                    ) : editing === rule.id ? (
                      <tr key={rule.id}>
                        <td colSpan={COLUMNS.length + 1}>
                          <PaymentRuleForm
                            category={category}
                            payer={payer}
                            rule={rule}
                            onDone={() => closeEdit(rule.id)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        focused={focusBack === rule.id}
                        onEdit={() => edit(rule.id)}
                        onDeleted={() => addRef.current?.focus()}
                      />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="fset__cardsub">
              No rules of its own yet
              {inherited.length
                ? ` — ${parent.label}'s rules below apply.`
                : " — the patient pays in full."}
            </div>
          )}
          {inherited.length ? (
            <div className="pr-inherited">
              <h3 className="pr-inherited__title">
                From {parent?.label ?? "the parent"} <span className="bill-src">inherited</span>
              </h3>
              <p className="fset__hint">
                These apply when {name} has no rule of its own for a line. Change them on{" "}
                {parent?.label ?? "the parent"}.
              </p>
              <div className="fset__scroll fset__scroll--wide">
                <table className="flow-table" aria-label="Inherited payment rules">
                  <Head />
                  <tbody>
                    {inherited.map((rule) => (
                      <tr key={rule.id} className={rule.is_active ? "" : "fset__row--off"}>
                        <RuleCells rule={rule} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {!category.is_active ? (
            <p className="fset__hint">
              This category is retired; bring it back to change its rules.
            </p>
          ) : adding ? (
            <PaymentRuleForm
              key={category.code}
              category={category}
              payer={payer}
              onDone={() => {
                setFocusBack("add");
                setAdding(false);
              }}
            />
          ) : (
            <div className="bill-dialog__actions">
              <button
                type="button"
                className="flow-btn flow-btn-primary"
                ref={addRef}
                autoFocus={focusBack === "add"}
                onClick={() => {
                  setFocusBack(null);
                  setAdding(true);
                }}
              >
                + Payment rule
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
