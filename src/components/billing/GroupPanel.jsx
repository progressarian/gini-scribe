import { useState } from "react";
import {
  useCreateBillingGroup,
  useCreateBillingSubgroup,
  useDeleteBillingGroup,
  useDeleteBillingSubgroup,
  useSetBillingGroupActive,
  useSetBillingSubgroupActive,
  useUpdateBillingGroup,
  useUpdateBillingSubgroup,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import AddForm from "./AddForm";
import { errorOf, usesOf } from "./format";

function NodeRow({
  node,
  moving,
  level,
  selected,
  onSelect,
  onRename,
  onMove,
  onActive,
  onDelete,
  first,
  last,
}) {
  const [renaming, setRenaming] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const saveName = async (e) => {
    e.preventDefault();
    if (await onRename(renaming.trim())) setRenaming(null);
  };
  return (
    <div
      className={`bill-tree__row bill-tree__row--${level}${node.is_active ? "" : " bill-tree__row--off"}${selected ? " bill-tree__row--on" : ""}`}
    >
      {renaming === null ? (
        <button
          type="button"
          className="bill-tree__pick"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span className="bill-tree__name">{node.name}</span>
          <span className="bill-tree__meta">
            {node.code} · {node.item_count} {node.item_count === 1 ? "item" : "items"}
            {node.is_active ? "" : " · off"}
          </span>
        </button>
      ) : (
        <form className="bill-tree__rename" onSubmit={saveName}>
          <input
            className="jb-assign"
            aria-label={`New name for ${node.name}`}
            maxLength={200}
            value={renaming}
            autoFocus
            onChange={(e) => setRenaming(e.target.value)}
          />
          <button
            type="submit"
            className="flow-btn flow-btn-primary flow-btn-mini"
            disabled={!renaming.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            onClick={() => setRenaming(null)}
          >
            Cancel
          </button>
        </form>
      )}
      <div className="bill-tree__actions">
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`Move ${node.name} up`}
          disabled={first || moving}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`Move ${node.name} down`}
          disabled={last || moving}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`Rename ${node.name}`}
          onClick={() => setRenaming(node.name)}
        >
          Rename
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`${node.is_active ? "Deactivate" : "Activate"} ${node.name}`}
          onClick={() => onActive(!node.is_active)}
        >
          {node.is_active ? "Deactivate" : "Activate"}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-red flow-btn-mini"
              aria-label={`Confirm delete ${node.name}`}
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            aria-label={`Delete ${node.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export default function GroupPanel({ groups, selected, onSelect, onBlocked }) {
  const [moving, setMoving] = useState(false);
  const createGroup = useCreateBillingGroup();
  const updateGroup = useUpdateBillingGroup();
  const groupActive = useSetBillingGroupActive();
  const deleteGroup = useDeleteBillingGroup();
  const createSubgroup = useCreateBillingSubgroup();
  const updateSubgroup = useUpdateBillingSubgroup();
  const subgroupActive = useSetBillingSubgroupActive();
  const deleteSubgroup = useDeleteBillingSubgroup();

  const attempt = async (work, success) => {
    try {
      await work();
      if (success) toast(success, "success");
      return true;
    } catch (e) {
      toast(errorOf(e), "error");
      return false;
    }
  };

  const handlersFor = (node, siblings, level) => {
    const update = level === "group" ? updateGroup : updateSubgroup;
    const setActive = level === "group" ? groupActive : subgroupActive;
    const remove = level === "group" ? deleteGroup : deleteSubgroup;
    const index = siblings.findIndex((s) => s.id === node.id);
    return {
      first: index === 0,
      last: index === siblings.length - 1,
      onRename: (name) =>
        name === node.name
          ? true
          : attempt(() => update.mutateAsync({ id: node.id, name }), `Renamed to ${name}`),
      onMove: async (step) => {
        if (moving) return;
        setMoving(true);
        await attempt(async () => {
          const order = [...siblings];
          const [moved] = order.splice(index, 1);
          order.splice(index + step, 0, moved);
          for (const [i, sibling] of order.entries()) {
            const sort_order = (i + 1) * 10;
            if (sibling.sort_order !== sort_order) {
              await update.mutateAsync({ id: sibling.id, sort_order });
            }
          }
        });
        setMoving(false);
      },
      onActive: (is_active) =>
        attempt(
          () => setActive.mutateAsync({ id: node.id, is_active }),
          `${node.name} ${is_active ? "activated" : "deactivated"}`,
        ),
      onDelete: async () => {
        try {
          await remove.mutateAsync(node.id);
          toast(`Deleted ${node.name}`, "success");
          if (selected?.level === level && selected.id === node.id) onSelect(null);
        } catch (e) {
          const uses = usesOf(e);
          if (!uses) return toast(errorOf(e), "error");
          onBlocked({
            name: node.name,
            uses,
            canDeactivate: node.is_active,
            deactivate: () => setActive.mutateAsync({ id: node.id, is_active: false }),
          });
        }
      },
    };
  };

  return (
    <section className="flow-card bill-tree" aria-label="Groups">
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Groups</h2>
        <span className="fset__count">{groups.length}</span>
      </div>
      <button
        type="button"
        className={`bill-tree__all${selected ? "" : " bill-tree__row--on"}`}
        aria-pressed={!selected}
        onClick={() => onSelect(null)}
      >
        All items
      </button>
      {groups.map((group) => (
        <div key={group.id} className="bill-tree__group">
          <NodeRow
            node={group}
            level="group"
            moving={moving}
            selected={selected?.level === "group" && selected.id === group.id}
            onSelect={() => onSelect({ level: "group", id: group.id, name: group.name })}
            {...handlersFor(group, groups, "group")}
          />
          {group.subgroups.map((sub) => (
            <NodeRow
              key={sub.id}
              node={sub}
              level="subgroup"
              moving={moving}
              selected={selected?.level === "subgroup" && selected.id === sub.id}
              onSelect={() =>
                onSelect({ level: "subgroup", id: sub.id, name: sub.name, groupName: group.name })
              }
              {...handlersFor(sub, group.subgroups, "subgroup")}
            />
          ))}
          {group.is_active ? (
            <AddForm
              label={`Add subgroup to ${group.name}`}
              busy={createSubgroup.isPending}
              onAdd={(draft) =>
                attempt(
                  () => createSubgroup.mutateAsync({ ...draft, group_id: group.id }),
                  `Added ${draft.name}`,
                )
              }
            />
          ) : null}
        </div>
      ))}
      <div className="fset__add">
        <div className="fset__addtitle">Add group</div>
        <AddForm
          label="Add group"
          busy={createGroup.isPending}
          onAdd={(draft) => attempt(() => createGroup.mutateAsync(draft), `Added ${draft.name}`)}
        />
      </div>
    </section>
  );
}
