import { useState } from "react";
import { useBillingCategories, useCreateBillingCategory } from "../queries/hooks/useBillingMaster";
import { toast } from "../stores/uiStore";
import AddForm from "../components/billing/AddForm";
import CategoryDetails from "../components/billing/CategoryDetails";
import CategoryRules from "../components/billing/CategoryRules";
import PaymentRules from "../components/billing/PaymentRules";
import UsedInDialog from "../components/billing/UsedInDialog";
import useDialog from "../components/billing/useDialog";
import { categoryCodeTyped, errorOf } from "../components/billing/format";
import "../styles/flow.css";
import "./flow/FlowSettings.css";
import "./billing/billing.css";

function CategoryRow({ category, level, selected, onSelect }) {
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
  const [openAdd, setOpenAdd] = useState(null);

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
      setOpenAdd(null);
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
    <div className="flow-root fset">
      <div className="bill-services">
        <section className="flow-card bill-tree" aria-label="Categories">
          <div className="fset__cardhead">
            <h2 className="flow-sec-title">Categories</h2>
            <span className="fset__count">{flat.length}</span>
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
            tree.map((top) => (
              <div key={top.code} className="bill-tree__group">
                <CategoryRow
                  category={top}
                  level="group"
                  selected={selectedCode === top.code}
                  onSelect={() => requestSelect(top.code)}
                />
                {top.sub_categories.map((sub) => (
                  <CategoryRow
                    key={sub.code}
                    category={sub}
                    level="subgroup"
                    selected={selectedCode === sub.code}
                    onSelect={() => requestSelect(sub.code)}
                  />
                ))}
                {!top.is_active ? null : openAdd === top.code ? (
                  <div className="bill-tree__adding">
                    <AddForm
                      label={`Add sub-category to ${top.label}`}
                      namePlaceholder="Label"
                      typeCode={categoryCodeTyped}
                      codeMax={32}
                      busy={create.isPending}
                      onAdd={(draft) => add(draft, top)}
                    />
                    <button
                      type="button"
                      className="flow-btn flow-btn-ghost flow-btn-mini"
                      onClick={() => setOpenAdd(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost flow-btn-mini bill-tree__addbtn"
                    aria-label={`New sub-category under ${top.label}`}
                    onClick={() => setOpenAdd(top.code)}
                  >
                    + Sub-category
                  </button>
                )}
              </div>
            ))
          )}
          <div className="fset__add">
            <div className="fset__addtitle">Add category</div>
            <AddForm
              label="Add category"
              namePlaceholder="Label"
              typeCode={categoryCodeTyped}
              codeMax={32}
              busy={create.isPending}
              onAdd={(draft) => add(draft, null)}
            />
          </div>
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
