import { useEffect, useId, useState } from "react";
import { Pencil, Power, PowerOff } from "lucide-react";
import {
  useBillingItems,
  useMembershipPlans,
  useMembershipSettings,
  useSaveMembershipSettings,
  useSetMembershipPlanActive,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import MembershipPlanForm from "../../components/billing/MembershipPlanForm";
import { fromPaise, requestErrorOf } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";
import "./discounts.css";

const benefitText = (plan) =>
  [
    `${plan.consult_count} consultation${plan.consult_count === 1 ? "" : "s"}`,
    plan.dietitian_count
      ? `${plan.dietitian_count} dietitian visit${plan.dietitian_count === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

function PlanRow({ plan, onEdit }) {
  const setActive = useSetMembershipPlanActive();
  const toggle = async () => {
    try {
      await setActive.mutateAsync({ id: plan.id, is_active: !plan.is_active });
      toast(`Plan ${plan.name} ${plan.is_active ? "stopped" : "on sale again"}`, "success");
    } catch (err) {
      toast(requestErrorOf(err, "Could not change the plan"), "error", 7000);
    }
  };
  return (
    <tr className={plan.is_active ? "" : "fset__row--off"}>
      <td data-label="Plan">
        <strong>{plan.name}</strong>
        <code className="disc-code">{plan.code}</code>
      </td>
      <td data-label="Price" className="disc-value">
        {fromPaise(plan.price)}
      </td>
      <td data-label="Gives" className="disc-cell">
        {benefitText(plan)}
      </td>
      <td data-label="Lab discount" className="disc-value">
        {plan.lab_discount_pct ? `${plan.lab_discount_pct}%` : "None"}
        {plan.lab_discount_pct && plan.lab_excludes_outsourced ? (
          <div className="flow-muted">Not on outsourced tests</div>
        ) : null}
      </td>
      <td data-label="Cards" className="disc-cell">
        {plan.active_cards} active · {plan.cards_sold} sold
      </td>
      <td data-label="Status">
        <span className={`bill-status disc-status--${plan.is_active ? "on" : "off"}`}>
          {plan.is_active ? "On sale" : "Stopped"}
        </span>
      </td>
      <td data-label="" className="bill-items__actions">
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`Edit plan ${plan.name}`}
          title="Edit"
          onClick={onEdit}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`${plan.is_active ? "Stop selling" : "Sell again"} plan ${plan.name}`}
          title={plan.is_active ? "Stop selling" : "Sell again"}
          disabled={setActive.isPending}
          onClick={toggle}
        >
          {plan.is_active ? (
            <PowerOff size={15} aria-hidden="true" />
          ) : (
            <Power size={15} aria-hidden="true" />
          )}
        </button>
      </td>
    </tr>
  );
}

function DietitianService() {
  const id = useId();
  const { data: settings } = useMembershipSettings();
  const { data: found } = useBillingItems({ active: "true", limit: "500" });
  const save = useSaveMembershipSettings();
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    setChosen(settings?.dietitian_item_id ? String(settings.dietitian_item_id) : "");
  }, [settings?.dietitian_item_id]);
  const options = (found?.items ?? []).filter((item) => item.kind !== "test");
  const changed =
    chosen !== (settings?.dietitian_item_id ? String(settings.dietitian_item_id) : "");

  const submit = async (e) => {
    e.preventDefault();
    try {
      await save.mutateAsync({ dietitian_item_id: chosen ? Number(chosen) : null });
      toast("Dietitian service saved", "success");
    } catch (err) {
      toast(requestErrorOf(err, "Could not save the dietitian service"), "error", 7000);
    }
  };

  return (
    <form className="flow-card bill-stack" onSubmit={submit}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Dietitian visits</h2>
      </div>
      <div className="fset__cardsub">
        When this service is billed to someone using a card with dietitian visits left, it is free
        and one visit comes off the card. Reception can also mark a visit used on the card itself.
      </div>
      <div className="bill-form">
        <div className="fset__field">
          <label htmlFor={`${id}-diet`}>Dietitian service</label>
          <select
            id={`${id}-diet`}
            className="jb-assign"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">None — mark visits on the card only</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.code})
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="flow-btn flow-btn-primary flow-btn-mini"
          disabled={!changed || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function MembershipPlansPage() {
  const [editing, setEditing] = useState(null);
  const { data: plans = [], isLoading, isError, refetch } = useMembershipPlans();
  const close = (message) => {
    setEditing(null);
    if (message) toast(message, "success");
  };

  return (
    <div className="flow-root fset bill-ui disc-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Membership plans</h2>
          <span className="fset__count">{plans.length}</span>
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini bill-tree__headbtn"
            onClick={() => setEditing("new")}
          >
            + New plan
          </button>
        </div>
        <div className="fset__cardsub">
          Cards reception sells. Anyone the holder sends can use the card; each consultation or
          dietitian visit comes off it. The sale counts as revenue under Membership › Consultant.
        </div>
        {isLoading ? (
          <div className="fset__cardsub" role="status">
            Loading plans…
          </div>
        ) : isError ? (
          <div className="fset__cardsub" role="alert">
            Could not load the plans.{" "}
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => refetch()}
            >
              Try again
            </button>
          </div>
        ) : plans.length ? (
          <div className="fset__scroll fset__scroll--wide disc-list">
            <table className="flow-table" aria-label="Membership plans">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Price</th>
                  <th>Gives</th>
                  <th>Lab discount</th>
                  <th>Cards</th>
                  <th>Status</th>
                  <th className="bill-items__actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <PlanRow key={plan.id} plan={plan} onEdit={() => setEditing(plan)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fset__cardsub">
            No membership plans yet — add one to start selling cards.
          </div>
        )}
      </div>
      <DietitianService />
      {editing ? (
        <MembershipPlanForm
          key={editing === "new" ? "new" : editing.id}
          plan={editing === "new" ? null : editing}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
