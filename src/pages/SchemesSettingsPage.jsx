import { useState } from "react";
import { useBillingCategories, useCreateBillingCategory } from "../queries/hooks/useBillingMaster";
import { toast } from "../stores/uiStore";
import AddDialog from "../components/billing/AddDialog";
import CategoryDetails from "../components/billing/CategoryDetails";
import CategoryRules from "../components/billing/CategoryRules";
import PaymentRules from "../components/billing/PaymentRules";
import UsedInDialog from "../components/billing/UsedInDialog";
import useDialog from "../components/billing/useDialog";
import { categoryCodeTyped, errorOf } from "../components/billing/format";
import "../styles/flow.css";
import "./flow/FlowSettings.css";
import "./billing/billing.css";
import "./billing/billingUi.css";

function CategoryRow({ category, level, selected, onSelect, toggle }) {
  const meta = [
    category.code,
    category.daily_cap === null ? null : `${category.daily_cap}/day`,
    category.is_active ? null : "retired",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={`bill-tree__row bill-tree__row--${level}${category.is_active ? "" : " bill-tree__row--off"}${selected ? " bill-tree__row--on" : ""}`}
    >
      {toggle}
      <button type="button" className="bill-tree__pick" aria-pressed={selected} onClick={onSelect}>
        <span className="bill-tree__name">
          <span className={`bill-cat__dot bill-cat__dot--${category.color || "gray"}`} />
          {category.label}
        </span>
        <span className="bill-tree__meta">{meta}</span>
      </button>
    </div>
  );
}

function DiscardDialog({ name, onKeep, onDiscard }) {
  const ref = useDialog(true, onKeep);
  return (
    <div className="flow-dialog-backdrop" onClick={onKeep} role="presentation">
      <div
        ref={ref}
        className="flow-card bill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discard-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="discard-title" className="bill-dialog__title">
          Discard your changes to {name}?
        </h2>
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onKeep}>
            Keep editing
          </button>
          <button type="button" className="flow-btn flow-btn-red" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SchemesSettingsPage() {
  const { data: tree = [], isLoading, isError } = useBillingCategories();
  const create = useCreateBillingCategory();
  const [selectedCode, setSelectedCode] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [blockedError, setBlockedError] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingCode, setPendingCode] = useState(undefined);
  const [adding, setAdding] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());

  const setGroupOpen = (code, open) =>
    setCollapsed((prev) => {
      if (prev.has(code) !== open) return prev;
      const next = new Set(prev);
      if (open) next.delete(code);
      else next.add(code);
      return next;
    });

  const requestSelect = (code) => {
    if (code === selectedCode) return;
    if (dirty) setPendingCode(code);
    else setSelectedCode(code);
  };

  const flat = tree.flatMap((top) => [
    { ...top, parent: null },
    ...top.sub_categories.map((sub) => ({ ...sub, parent: top })),
  ]);
  const selected = flat.find((c) => c.code === selectedCode) ?? null;

  const add = async (draft, parent) => {
    try {
      const created = await create.mutateAsync({
        code: draft.code.toLowerCase(),
        label: draft.name,
        ...(parent ? { parent_code: parent.code } : {}),
      });
      if (parent) setGroupOpen(parent.code, true);
      toast(`Added ${created.display_label ?? draft.name}`, "success");
      if (created.rules_to_move?.length) {
        toast(
          `${parent.label} has rules to move to a sub-category: ${created.rules_to_move.map((r) => r.name).join(", ")}`,
          "warn",
          8000,
        );
        requestSelect(parent.code);
      } else {
        requestSelect(created.code);
      }
      return true;
    } catch (e) {
      toast(errorOf(e), "error");
      return false;
    }
  };

  const deactivateBlocked = async () => {
    setDeactivating(true);
    setBlockedError("");
    try {
      await blocked.deactivate();
      toast(`${blocked.name} retired`, "success");
      setBlocked(null);
    } catch (e) {
      setBlockedError(errorOf(e, "Could not retire it"));
    } finally {
      setDeactivating(false);
    }
  };

  return (
    <div className="flow-root fset bill-ui">
      <div className="bill-services bill-services--split">
        <section className="flow-card bill-tree" aria-label="Categories">
          <div className="fset__cardhead">
            <h2 className="flow-sec-title">Categories</h2>
            <span className="fset__count">{flat.length}</span>
            <button
              type="button"
              className="flow-btn flow-btn-primary flow-btn-mini bill-tree__headbtn"
              onClick={() => setAdding({ parent: null })}
            >
              + Add category
            </button>
          </div>
          <div className="fset__cardsub">
            Who a patient is billed as — CGHS, ECHS and the rest. A category can hold
            sub-categories, one level deep.
          </div>
          {isLoading ? (
            <div className="fset__cardsub">Loading…</div>
          ) : isError ? (
            <div className="fset__cardsub">Could not load the categories.</div>
          ) : (
            tree.map((top) => {
              const open = !collapsed.has(top.code);
              const bodyId = `bill-cat-group-${top.code}`;
              const subCount = top.sub_categories.length;
              return (
                <div key={top.code} className="bill-tree__group">
                  <CategoryRow
                    category={top}
                    level="group"
                    selected={selectedCode === top.code}
                    onSelect={() => requestSelect(top.code)}
                    toggle={
                      <button
                        type="button"
                        className="bill-tree__toggle"
                        aria-expanded={open}
                        aria-controls={bodyId}
                        aria-label={`${open ? "Collapse" : "Expand"} ${top.label}`}
                        onClick={() => setGroupOpen(top.code, !open)}
                      >
                        <span className="bill-tree__chev" aria-hidden="true" />
                      </button>
                    }
                  />
                  {!open && subCount ? (
                    <span className="bill-tree__subcount">
                      {subCount} sub-categor{subCount === 1 ? "y" : "ies"}
                    </span>
                  ) : null}
                  <div id={bodyId} hidden={!open}>
                    {top.sub_categories.map((sub) => (
                      <CategoryRow
                        key={sub.code}
                        category={sub}
                        level="subgroup"
                        selected={selectedCode === sub.code}
                        onSelect={() => requestSelect(sub.code)}
                      />
                    ))}
                    {top.is_active ? (
                      <button
                        type="button"
                        className="flow-btn flow-btn-ghost flow-btn-mini bill-tree__addbtn"
                        aria-label={`New sub-category under ${top.label}`}
                        onClick={() => setAdding({ parent: top })}
                      >
                        + Sub-category
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </section>

        <div className="bill-cat__side">
          {selected ? (
            <>
              <CategoryDetails
                key={selected.code}
                category={selected}
                parent={selected.parent}
                onBlocked={setBlocked}
                onDeleted={() => setSelectedCode(null)}
                onDirtyChange={setDirty}
              />
              <CategoryRules key={`rules-${selected.code}`} category={selected} />
              <PaymentRules
                key={`pay-${selected.code}`}
                category={selected}
                parent={selected.parent}
              />
            </>
          ) : (
            <div className="flow-card fset__cardsub">
              Choose a category to edit it and the rules for who belongs to it.
            </div>
          )}
        </div>
      </div>
      {adding ? (
        <AddDialog
          title={adding.parent ? `Add sub-category to ${adding.parent.label}` : "Add category"}
          submitLabel={adding.parent ? "Add sub-category" : "Add category"}
          note="The code is permanent and used on every price and rule; the label can be changed later."
          nameLabel="Label"
          codePlaceholder={adding.parent ? "e.g. cghs_pensioner" : "e.g. cghs"}
          codeHint="Lowercase letters, numbers and _ only"
          namePlaceholder={adding.parent ? "e.g. CGHS Pensioner" : "e.g. CGHS"}
          codeMax={32}
          typeCode={categoryCodeTyped}
          busy={create.isPending}
          onAdd={(draft) => add(draft, adding.parent)}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {pendingCode !== undefined && selected ? (
        <DiscardDialog
          name={selected.display_label || selected.label}
          onKeep={() => setPendingCode(undefined)}
          onDiscard={() => {
            setDirty(false);
            setSelectedCode(pendingCode);
            setPendingCode(undefined);
          }}
        />
      ) : null}
      <UsedInDialog
        verb="Retire"
        blocked={blocked}
        error={blockedError}
        busy={deactivating}
        onClose={() => {
          setBlocked(null);
          setBlockedError("");
        }}
        onDeactivate={deactivateBlocked}
      />
    </div>
  );
}
