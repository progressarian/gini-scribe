import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import {
  useDeleteBillingGroup,
  useDeleteBillingSubgroup,
  useSetBillingGroupActive,
  useSetBillingSubgroupActive,
  useUpdateBillingGroup,
  useUpdateBillingSubgroup,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import ConfirmDeleteDialog from "./ConfirmDeleteDialog";
import { errorOf, usesOf } from "./format";

export default function NodeToolbar({ node, level, siblings, onDeleted, onBlocked }) {
  const [renaming, setRenaming] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const isGroup = level === "group";
  const updateGroup = useUpdateBillingGroup();
  const updateSubgroup = useUpdateBillingSubgroup();
  const groupActive = useSetBillingGroupActive();
  const subgroupActive = useSetBillingSubgroupActive();
  const deleteGroup = useDeleteBillingGroup();
  const deleteSubgroup = useDeleteBillingSubgroup();
  const update = isGroup ? updateGroup : updateSubgroup;
  const setActive = isGroup ? groupActive : subgroupActive;
  const remove = isGroup ? deleteGroup : deleteSubgroup;
  const index = siblings.findIndex((s) => s.id === node.id);

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

  const saveName = async (e) => {
    e.preventDefault();
    const name = renaming.trim();
    if (name === node.name) return setRenaming(null);
    if (await attempt(() => update.mutateAsync({ id: node.id, name }), `Renamed to ${name}`)) {
      setRenaming(null);
    }
  };

  const move = async (step) => {
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
  };

  const toggleActive = () =>
    attempt(
      () => setActive.mutateAsync({ id: node.id, is_active: !node.is_active }),
      `${node.name} ${node.is_active ? "deactivated" : "activated"}`,
    );

  const confirmDelete = async () => {
    setConfirming(false);
    try {
      await remove.mutateAsync(node.id);
      toast(`Deleted ${node.name}`, "success");
      onDeleted();
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
  };

  return (
    <div className="bill-node-bar" role="toolbar" aria-label={`Actions for ${node.name}`}>
      {renaming === null ? (
        <>
          <span className="bill-node-bar__kind">{isGroup ? "Group" : "Subgroup"}</span>
          <code className="bill-node-bar__code">{node.code}</code>
          {node.is_active ? null : <span className="bill-tree__badge">Off</span>}
          <div className="bill-node-bar__actions">
            <button
              type="button"
              className="bill-node-bar__btn"
              aria-label={`Rename ${node.name}`}
              onClick={() => setRenaming(node.name)}
            >
              <Pencil size={14} aria-hidden="true" />
              Rename
            </button>
            <span className="bill-node-bar__pair">
              <button
                type="button"
                className="bill-node-bar__btn bill-node-bar__btn--icon"
                aria-label={`Move ${node.name} up`}
                title="Move up"
                disabled={index <= 0 || moving}
                onClick={() => move(-1)}
              >
                <ArrowUp size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="bill-node-bar__btn bill-node-bar__btn--icon"
                aria-label={`Move ${node.name} down`}
                title="Move down"
                disabled={index === siblings.length - 1 || moving}
                onClick={() => move(1)}
              >
                <ArrowDown size={15} aria-hidden="true" />
              </button>
            </span>
            <button
              type="button"
              className="bill-node-bar__btn"
              aria-label={`${node.is_active ? "Deactivate" : "Activate"} ${node.name}`}
              onClick={toggleActive}
            >
              {node.is_active ? (
                <PowerOff size={14} aria-hidden="true" />
              ) : (
                <Power size={14} aria-hidden="true" />
              )}
              {node.is_active ? "Deactivate" : "Activate"}
            </button>
            <button
              type="button"
              className="bill-node-bar__btn bill-node-bar__btn--danger"
              aria-label={`Delete ${node.name}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete
            </button>
          </div>
        </>
      ) : (
        <form className="bill-node-bar__rename" onSubmit={saveName}>
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
            className="flow-btn flow-btn-primary"
            disabled={!renaming.trim() || update.isPending}
          >
            Save
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => setRenaming(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {confirming ? (
        <ConfirmDeleteDialog
          name={node.name}
          note={`The ${isGroup ? "group" : "subgroup"} is removed for good. One that is still used can be deactivated instead.`}
          onKeep={() => setConfirming(false)}
          onDelete={confirmDelete}
        />
      ) : null}
    </div>
  );
}
