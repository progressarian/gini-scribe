import { useEffect, useState } from "react";
import { History, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  useBillingGroups,
  useBillingItemChoices,
  useBillingItems,
  useBillingNotPriced,
  useBillingTaxCodeOptions,
  useDeleteBillingItem,
  useSetBillingItemActive,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import GroupPanel from "../../components/billing/GroupPanel";
import ConfirmDeleteDialog from "../../components/billing/ConfirmDeleteDialog";
import ItemDialog from "../../components/billing/ItemDialog";
import NodeToolbar from "../../components/billing/NodeToolbar";
import NotPricedPanel from "../../components/billing/NotPricedPanel";
import PriceHistoryDialog from "../../components/billing/PriceHistoryDialog";
import UsedInDialog from "../../components/billing/UsedInDialog";
import { errorOf, rupees, usesOf } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";

const STATUS_FILTER = { active: "true", inactive: "false", all: undefined };

const linkOf = (item) => {
  if (item.kind === "consultation") {
    return `${item.doctor_name ?? "Hospital default"} · ${item.visit_type}`;
  }
  if (item.kind === "test") return item.test_name ?? "—";
  return "—";
};

function ItemRow({ item, showPath, onEdit, onHistory, onBlocked }) {
  const [confirming, setConfirming] = useState(false);
  const setActive = useSetBillingItemActive();
  const remove = useDeleteBillingItem();

  const toggle = async () => {
    try {
      await setActive.mutateAsync({ id: item.id, is_active: !item.is_active });
      toast(`${item.name} ${item.is_active ? "deactivated" : "activated"}`, "success");
    } catch (e) {
      toast(errorOf(e), "error");
    }
  };

  const destroy = async () => {
    setConfirming(false);
    try {
      await remove.mutateAsync(item.id);
      toast(`Deleted ${item.name}`, "success");
    } catch (e) {
      const uses = usesOf(e);
      if (!uses) return toast(errorOf(e), "error");
      onBlocked({
        name: item.name,
        uses,
        canDeactivate: item.is_active,
        deactivate: () => setActive.mutateAsync({ id: item.id, is_active: false }),
      });
    }
  };

  return (
    <tr className={item.is_active ? "" : "fset__row--off"}>
      <td>{item.code}</td>
      <td>
        {item.name}
        {showPath ? (
          <div className="flow-muted bill-items__sub">
            {item.group_name} › {item.subgroup_name}
          </div>
        ) : null}
      </td>
      <td>{item.kind}</td>
      <td>{rupees(item.base_price)}</td>
      <td>
        {item.unit}
        {item.allow_quantity ? ` · up to ${item.max_quantity ?? "any"}` : ""}
      </td>
      <td>{item.tax_code ?? "—"}</td>
      <td>{linkOf(item)}</td>
      <td>{item.is_active ? "Yes" : "No"}</td>
      <td className="bill-items__actions">
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`Edit ${item.name}`}
          title="Edit"
          onClick={onEdit}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`Price history of ${item.name}`}
          title="Price history"
          onClick={onHistory}
        >
          <History size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`${item.is_active ? "Deactivate" : "Activate"} ${item.name}`}
          title={item.is_active ? "Deactivate" : "Activate"}
          onClick={toggle}
        >
          {item.is_active ? (
            <PowerOff size={15} aria-hidden="true" />
          ) : (
            <Power size={15} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="bill-icon-btn bill-icon-btn--danger"
          aria-label={`Delete ${item.name}`}
          title="Delete"
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
        {confirming ? (
          <ConfirmDeleteDialog
            name={item.name}
            note="The item is removed for good. One that is already used can be deactivated instead."
            onKeep={() => setConfirming(false)}
            onDelete={destroy}
          />
        ) : null}
      </td>
    </tr>
  );
}

export default function ServicesSettingsPage() {
  const [selected, setSelected] = useState(null);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState(null);
  const [view, setView] = useState("items");
  const notPriced = useBillingNotPriced();
  const createTest = params.get("createTest");

  useEffect(() => {
    if (!createTest || !notPriced.data) return;
    const test = notPriced.data.tests.find(
      (t) => t.test_catalog_id === createTest && t.status === "no_item",
    );
    if (test) {
      setEditing({
        item: null,
        prefill: {
          name: test.test_name,
          kind: "test",
          test_catalog_id: test.test_catalog_id,
          base_price: test.catalogue_price,
        },
      });
    } else {
      toast("That test can't get a new item — it already has one, or it's retired", "warn");
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("createTest");
        return next;
      },
      { replace: true },
    );
  }, [createTest, notPriced.data, setParams]);

  const notPricedCount = notPriced.data
    ? notPriced.data.tests.length + notPriced.data.consultants.length
    : null;
  const [history, setHistory] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState("");

  const groups = useBillingGroups();
  const choices = useBillingItemChoices();
  const taxCodes = useBillingTaxCodeOptions();
  const items = useBillingItems({
    q: q.trim(),
    kind,
    active: STATUS_FILTER[status],
    groupId: selected?.level === "group" ? String(selected.id) : undefined,
    subgroupId: selected?.level === "subgroup" ? String(selected.id) : undefined,
  });
  const rows = items.data?.items ?? [];
  const total = items.data?.total ?? 0;

  const closeEditor = (message) => {
    setEditing(null);
    if (message) toast(message, "success");
  };

  const deactivateBlocked = async () => {
    setDeactivating(true);
    setDeactivateError("");
    try {
      await blocked.deactivate();
      toast(`${blocked.name} deactivated`, "success");
      setBlocked(null);
    } catch (e) {
      setDeactivateError(errorOf(e, "Could not deactivate it"));
    } finally {
      setDeactivating(false);
    }
  };

  const selectedGroup = groups.data?.find((g) =>
    selected?.level === "group"
      ? g.id === selected.id
      : g.subgroups.some((s) => s.id === selected?.id),
  );
  const selectedNode =
    selected?.level === "subgroup"
      ? selectedGroup?.subgroups.find((s) => s.id === selected.id)
      : selectedGroup;
  const heading = !selectedNode
    ? "All items"
    : selected.level === "subgroup"
      ? `${selectedGroup.name} › ${selectedNode.name}`
      : selectedNode.name;
  const groupPicked = selected?.level === "group" && selectedNode;
  const openSubgroups = groupPicked ? selectedNode.subgroups.filter((s) => s.is_active) : [];
  const canAdd = Boolean(selectedNode?.is_active) && (!groupPicked || openSubgroups.length > 0);
  const addHint = !selectedNode
    ? "Choose a group or subgroup first"
    : !selectedNode.is_active
      ? `This ${selected.level} is off; activate it to add items`
      : canAdd
        ? ""
        : `Add a subgroup to ${selectedNode.name} first`;
  const addingNew = editing && !editing.item && view === "items";
  const dialogGroups =
    addingNew && groupPicked
      ? (groups.data ?? []).filter((g) => g.id === selectedNode.id)
      : (groups.data ?? []);
  const dialogSubgroupId =
    selected?.level === "subgroup"
      ? selected.id
      : addingNew && openSubgroups.length === 1
        ? openSubgroups[0].id
        : "";

  return (
    <div className="flow-root fset bill-ui">
      <div className="bill-views" role="group" aria-label="Services view">
        <button
          type="button"
          aria-pressed={view === "items"}
          className={`bill-views__tab${view === "items" ? " bill-views__tab--on" : ""}`}
          onClick={() => setView("items")}
        >
          Items
        </button>
        <button
          type="button"
          aria-pressed={view === "not-priced"}
          className={`bill-views__tab${view === "not-priced" ? " bill-views__tab--on" : ""}`}
          onClick={() => setView("not-priced")}
        >
          Not priced{notPricedCount === null ? "" : ` · ${notPricedCount}`}
        </button>
      </div>
      {view === "not-priced" ? (
        <NotPricedPanel onCreate={(prefill) => setEditing({ item: null, prefill })} />
      ) : (
        <div className="bill-services bill-services--split">
          {groups.isLoading ? (
            <div className="flow-card fset__cardsub">Loading…</div>
          ) : groups.isError ? (
            <div className="flow-card fset__cardsub">Could not load the services.</div>
          ) : (
            <GroupPanel groups={groups.data} selected={selected} onSelect={setSelected} />
          )}

          <section className="flow-card bill-items" aria-label="Items">
            <div className="fset__cardhead">
              <h2 className="flow-sec-title">{heading}</h2>
              <span className="fset__count">{total}</span>
              {addHint ? <span className="bill-items__addhint">{addHint}</span> : null}
              <button
                type="button"
                className="flow-btn flow-btn-primary flow-btn-mini bill-items__add"
                disabled={!canAdd}
                title={addHint}
                onClick={() => setEditing({ item: null })}
              >
                + Add item
              </button>
            </div>
            {selectedNode ? (
              <NodeToolbar
                key={`${selected.level}-${selectedNode.id}`}
                node={selectedNode}
                level={selected.level}
                siblings={
                  selected.level === "group" ? (groups.data ?? []) : selectedGroup.subgroups
                }
                onDeleted={() => setSelected(null)}
                onBlocked={setBlocked}
              />
            ) : null}
            <div className="bill-items__filters">
              <input
                className="jb-assign"
                type="search"
                aria-label="Search items"
                placeholder="Search name or code"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <select
                className="jb-assign"
                aria-label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="">All kinds</option>
                {(choices.data?.kinds ?? []).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select
                className="jb-assign"
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">Active and off</option>
                <option value="active">Active only</option>
                <option value="inactive">Off only</option>
              </select>
            </div>
            {items.isError ? (
              <div className="fset__cardsub">Could not load the items.</div>
            ) : items.isLoading ? (
              <div className="fset__cardsub">Loading…</div>
            ) : !rows.length ? (
              <div className="fset__cardsub">No items here yet.</div>
            ) : (
              <div className="fset__scroll fset__scroll--wide">
                <table className="flow-table" aria-label="Items">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Name</th>
                      <th>Kind</th>
                      <th>Price</th>
                      <th>Unit</th>
                      <th>Tax</th>
                      <th>Consultant / test</th>
                      <th>Active</th>
                      <th className="bill-items__actions-head">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        showPath={selected?.level !== "subgroup"}
                        onEdit={() => setEditing({ item })}
                        onHistory={() => setHistory(item)}
                        onBlocked={setBlocked}
                      />
                    ))}
                  </tbody>
                </table>
                {total > rows.length ? (
                  <p className="fset__hint">
                    Showing {rows.length} of {total}. Search or pick a subgroup to narrow the list.
                  </p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}

      {editing ? (
        <ItemDialog
          item={editing.item}
          prefill={editing.prefill}
          subgroupId={dialogSubgroupId}
          groups={dialogGroups}
          choices={choices.data}
          taxCodes={taxCodes.data ?? []}
          onClose={closeEditor}
        />
      ) : null}
      <PriceHistoryDialog item={history} onClose={() => setHistory(null)} />
      <UsedInDialog
        blocked={blocked}
        error={deactivateError}
        busy={deactivating}
        onClose={() => {
          setBlocked(null);
          setDeactivateError("");
        }}
        onDeactivate={deactivateBlocked}
      />
    </div>
  );
}
