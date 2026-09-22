import { useId, useState } from "react";
import {
  useBillingDiscounts,
  useDeleteBillingDiscount,
  useSetBillingDiscountActive,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import DiscountForm from "../../components/billing/DiscountForm";
import RuleTestBox from "../../components/billing/RuleTestBox";
import {
  METHOD_LABEL,
  coversOf,
  datesOf,
  usageOf,
  valueOf,
  whoOf,
} from "../../components/billing/discountText";
import { requestErrorOf } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./discounts.css";

function Lines({ parts }) {
  return parts.map((part) => <div key={part}>{part}</div>);
}

function DiscountRow({ rule, onEdit }) {
  const [confirming, setConfirming] = useState(false);
  const [kept, setKept] = useState(false);
  const setActive = useSetBillingDiscountActive();
  const remove = useDeleteBillingDiscount();
  const attempt = async (work, message, fallback) => {
    try {
      await work();
      toast(message, "success");
    } catch (err) {
      toast(requestErrorOf(err, fallback), "error", 7000);
    }
  };
  return (
    <tr className={rule.is_active ? "" : "fset__row--off"}>
      <td>
        <strong>{rule.name}</strong>
        {rule.code ? <div className="disc-code">{rule.code}</div> : null}
      </td>
      <td>{METHOD_LABEL[rule.method]}</td>
      <td>{valueOf(rule)}</td>
      <td className="disc-cell">
        <Lines parts={coversOf(rule)} />
      </td>
      <td className="disc-cell">
        <Lines parts={whoOf(rule)} />
      </td>
      <td>{datesOf(rule)}</td>
      <td className="disc-cell">
        <Lines parts={usageOf(rule)} />
      </td>
      <td>{rule.is_active ? "Active" : "Inactive"}</td>
      <td className="bill-items__actions">
        {confirming ? (
          <span role="group" aria-label={`Delete discount ${rule.name}?`}>
            <button
              type="button"
              className="flow-btn flow-btn-red flow-btn-mini"
              aria-label={`Confirm delete discount ${rule.name}`}
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(false);
                attempt(
                  () => remove.mutateAsync(rule.id),
                  `Deleted discount ${rule.name}`,
                  "Could not delete the discount",
                );
              }}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Keep discount ${rule.name}`}
              autoFocus
              onClick={() => {
                setConfirming(false);
                setKept(true);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Edit discount ${rule.name}`}
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`${rule.is_active ? "Deactivate" : "Activate"} discount ${rule.name}`}
              disabled={setActive.isPending}
              onClick={() =>
                attempt(
                  () => setActive.mutateAsync({ id: rule.id, is_active: !rule.is_active }),
                  `Discount ${rule.name} ${rule.is_active ? "deactivated" : "activated"}`,
                  "Could not change the discount",
                )
              }
            >
              {rule.is_active ? "Deactivate" : "Activate"}
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Delete discount ${rule.name}`}
              autoFocus={kept}
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

export default function DiscountsSettingsPage() {
  const [method, setMethod] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const { data: rules = [], isLoading, isError } = useBillingDiscounts({ method, activeOnly });
  const id = useId();

  const needle = q.trim().toLowerCase();
  const shown = rules.filter(
    (rule) =>
      !needle ||
      rule.name.toLowerCase().includes(needle) ||
      (rule.code ?? "").toLowerCase().includes(needle),
  );
  const close = (message) => {
    setEditing(null);
    if (message) toast(message, "success");
  };

  return (
    <div className="flow-root fset">
      <div className="flow-card">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Discounts</h2>
          <span className="fset__count">{shown.length}</span>
          <button
            type="button"
            className="flow-btn flow-btn-primary disc-new"
            onClick={() => setEditing("new")}
          >
            + New discount
          </button>
        </div>
        <div className="fset__cardsub">
          Automatic discounts and codes the desk can enter, their limits and who they are for.
        </div>
        <div className="bill-form">
          <div className="fset__field">
            <label htmlFor={`${id}-q`}>Search</label>
            <input
              id={`${id}-q`}
              type="search"
              className="jb-assign"
              placeholder="Name or code"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="fset__field">
            <label htmlFor={`${id}-method`}>Show</label>
            <select
              id={`${id}-method`}
              className="jb-assign"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="">Automatic and codes</option>
              <option value="auto">Automatic only</option>
              <option value="code">Codes only</option>
            </select>
          </div>
          <label className="fset__check">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Active only
          </label>
        </div>
        {isLoading ? (
          <div className="fset__cardsub">Loading…</div>
        ) : isError ? (
          <div className="fset__cardsub">Could not load the discounts.</div>
        ) : shown.length ? (
          <div className="fset__scroll fset__scroll--wide disc-list">
            <table className="flow-table" aria-label="Discounts">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Covers</th>
                  <th>Who</th>
                  <th>Dates</th>
                  <th>Uses</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((rule) => (
                  <DiscountRow key={rule.id} rule={rule} onEdit={() => setEditing(rule)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fset__cardsub">
            {needle || method || activeOnly
              ? "No discount matches."
              : "No discounts yet — add one to start."}
          </div>
        )}
      </div>
      <RuleTestBox />
      {editing ? (
        <DiscountForm
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? null : editing}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
