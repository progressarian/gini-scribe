import { useState } from "react";
import {
  useCreateBillingGroup,
  useCreateBillingSubgroup,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import AddDialog from "./AddDialog";
import { errorOf } from "./format";

function NodeRow({ node, level, selected, onSelect, toggle }) {
  return (
    <div
      className={`bill-tree__row bill-tree__row--${level}${node.is_active ? "" : " bill-tree__row--off"}${selected ? " bill-tree__row--on" : ""}`}
    >
      {toggle}
      <button type="button" className="bill-tree__pick" aria-pressed={selected} onClick={onSelect}>
        <span className="bill-tree__name">
          {node.name}
          {node.is_active ? null : <span className="bill-tree__badge">Off</span>}
        </span>
        <span className="bill-tree__meta">
          {node.code} · {node.item_count} {node.item_count === 1 ? "item" : "items"}
        </span>
      </button>
    </div>
  );
}

export default function GroupPanel({ groups, selected, onSelect }) {
  const [adding, setAdding] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const createGroup = useCreateBillingGroup();
  const createSubgroup = useCreateBillingSubgroup();

  const toggleGroup = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const attempt = async (work, success) => {
    try {
      await work();
      toast(success, "success");
      return true;
    } catch (e) {
      toast(errorOf(e), "error");
      return false;
    }
  };

  return (
    <section className="flow-card bill-tree" aria-label="Groups">
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Groups</h2>
        <span className="fset__count">{groups.length}</span>
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini bill-tree__headbtn"
          onClick={() => setAdding({ group: null })}
        >
          + Add group
        </button>
      </div>
      <button
        type="button"
        className={`bill-tree__all${selected ? "" : " bill-tree__row--on"}`}
        aria-pressed={!selected}
        onClick={() => onSelect(null)}
      >
        All items
      </button>
      {groups.map((group) => {
        const open = !collapsed.has(group.id);
        const bodyId = `bill-group-${group.id}`;
        const subCount = group.subgroups.length;
        return (
          <div key={group.id} className="bill-tree__group">
            <NodeRow
              node={group}
              level="group"
              selected={selected?.level === "group" && selected.id === group.id}
              onSelect={() => onSelect({ level: "group", id: group.id, name: group.name })}
              toggle={
                <button
                  type="button"
                  className="bill-tree__toggle"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  aria-label={`${open ? "Collapse" : "Expand"} ${group.name}`}
                  onClick={() => toggleGroup(group.id)}
                >
                  <span className="bill-tree__chev" aria-hidden="true" />
                </button>
              }
            />
            {!open && subCount ? (
              <span className="bill-tree__subcount">
                {subCount} subgroup{subCount === 1 ? "" : "s"}
              </span>
            ) : null}
            <div id={bodyId} hidden={!open}>
              {group.subgroups.map((sub) => (
                <NodeRow
                  key={sub.id}
                  node={sub}
                  level="subgroup"
                  selected={selected?.level === "subgroup" && selected.id === sub.id}
                  onSelect={() =>
                    onSelect({
                      level: "subgroup",
                      id: sub.id,
                      name: sub.name,
                      groupName: group.name,
                    })
                  }
                />
              ))}
              {group.is_active ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini bill-tree__addbtn"
                  aria-label={`New subgroup under ${group.name}`}
                  onClick={() => setAdding({ group })}
                >
                  + Subgroup
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {adding ? (
        <AddDialog
          title={adding.group ? `Add subgroup to ${adding.group.name}` : "Add group"}
          submitLabel={adding.group ? "Add subgroup" : "Add group"}
          note="The code is permanent; the name can be changed later."
          codeHint="No spaces"
          codePlaceholder={adding.group ? "e.g. LAB-BIO" : "e.g. LAB"}
          namePlaceholder={adding.group ? "e.g. Biochemistry" : "e.g. Laboratory"}
          busy={adding.group ? createSubgroup.isPending : createGroup.isPending}
          onAdd={(draft) =>
            adding.group
              ? attempt(
                  () => createSubgroup.mutateAsync({ ...draft, group_id: adding.group.id }),
                  `Added ${draft.name}`,
                )
              : attempt(() => createGroup.mutateAsync(draft), `Added ${draft.name}`)
          }
          onClose={() => setAdding(null)}
        />
      ) : null}
    </section>
  );
}
