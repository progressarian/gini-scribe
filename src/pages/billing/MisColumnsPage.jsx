import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import Shimmer from "../../components/Shimmer";
import { useBillingReportCatalog } from "../../queries/hooks/useBillingReports";
import { useMisColumns, useSaveMisColumn } from "../../queries/hooks/useBillingDashboard";
import { ITEM_SEARCH_MIN, useItemSearch } from "../../queries/hooks/useBilling";
import { errorOf } from "../../components/billing/format";
import { ITEM_KINDS } from "../../../shared/billingVocab.js";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";
import "./billingDashboard.css";

const KIND_LABELS = {
  consultation: "Consultation items",
  test: "Test items",
  procedure: "Procedure items",
  medicine: "Medicine items",
  other: "Other items",
};

const draftOf = (column) => ({
  label: column.label,
  item_kinds: column.item_kinds,
  groups: column.groups,
  subgroups: column.subgroups,
  items: column.items,
});

const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

function changed(draft, column) {
  return (
    draft.label.trim() !== column.label ||
    !sameList(draft.item_kinds, column.item_kinds) ||
    !sameList(
      draft.groups.map((g) => g.code),
      column.groups.map((g) => g.code),
    ) ||
    !sameList(
      draft.subgroups.map((s) => s.code),
      column.subgroups.map((s) => s.code),
    ) ||
    !sameList(
      draft.items.map((i) => i.id),
      column.items.map((i) => i.id),
    )
  );
}

function Chip({ label, onRemove }) {
  return (
    <span className="bdash-chip">
      {label}
      <button
        type="button"
        className="bdash-chip__x"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

function ItemPicker({ taken, onAdd }) {
  const id = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const searching = query.length >= ITEM_SEARCH_MIN;
  const { data, isFetching, isError } = useItemSearch(query, null, null, { enabled: searching });
  const items = searching ? (data?.items ?? []).filter((item) => !taken.has(item.id)) : [];
  return (
    <div className="fset__field bdash-picker">
      <label htmlFor={id}>Add an item</label>
      <input
        id={id}
        type="search"
        className="jb-assign"
        placeholder="Search services by name or code"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {searching ? (
        <ul className="bdash-picker__list" aria-label="Matching items">
          {isError ? <li className="bdash-muted">Could not search — try again.</li> : null}
          {!isError && !items.length ? (
            <li className="bdash-muted">{isFetching ? "Searching…" : "No matching items"}</li>
          ) : null}
          {items.slice(0, 8).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="bdash-link"
                onClick={() => {
                  onAdd({ id: item.id, code: item.code, name: item.name });
                  setText("");
                }}
              >
                {item.name}
                {item.code ? <span className="bdash-muted"> · {item.code}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ColumnEditor({ column, catalog }) {
  const save = useSaveMisColumn();
  const [draft, setDraft] = useState(() => draftOf(column));
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const labelId = useId();
  const groupId = useId();
  const subgroupId = useId();

  useEffect(() => setDraft(draftOf(column)), [column]);

  const set = (patch) => {
    setDraft((was) => ({ ...was, ...patch }));
    setNote(null);
    setError(null);
  };
  const dirty = changed(draft, column);
  const groupCodes = new Set(draft.groups.map((g) => g.code));
  const subgroupCodes = new Set(draft.subgroups.map((s) => s.code));
  const itemIds = new Set(draft.items.map((i) => i.id));
  const groups = catalog.options.groups.filter((g) => !groupCodes.has(g.code.toLowerCase()));
  const subgroups = catalog.options.subgroups.filter(
    (s) => !subgroupCodes.has(s.code.toLowerCase()),
  );
  const empty =
    !draft.item_kinds.length &&
    !draft.groups.length &&
    !draft.subgroups.length &&
    !draft.items.length;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await save.mutateAsync({
        key: column.key,
        label: draft.label.trim(),
        item_kinds: draft.item_kinds,
        group_codes: draft.groups.map((g) => g.code),
        subgroup_codes: draft.subgroups.map((s) => s.code),
        item_ids: draft.items.map((i) => i.id),
      });
      setNote(`${draft.label.trim()} saved.`);
    } catch (e) {
      setError(errorOf(e, "The column could not be saved"));
    }
  };

  return (
    <form className="flow-card bill-stack bdash-col" onSubmit={submit} aria-label={column.label}>
      <div className="fset__cardhead">
        <div className="fset__field brep-field bdash-col__name">
          <label htmlFor={labelId}>Column name</label>
          <input
            id={labelId}
            className="jb-assign"
            maxLength={60}
            required
            value={draft.label}
            onChange={(e) => set({ label: e.target.value })}
          />
        </div>
        <span className="bdash-muted">
          Discount counts as{" "}
          {column.kind === "consultation"
            ? "consultation"
            : column.kind === "test"
              ? "tests"
              : "other"}
        </span>
      </div>

      <div className="bdash-col__matches" aria-label="Counted under this column">
        {empty ? (
          <span className="bdash-muted">Nothing yet — these services count as Miscellaneous.</span>
        ) : null}
        {draft.items.map((item) => (
          <Chip
            key={`i${item.id}`}
            label={`Item: ${item.name ?? `#${item.id}`}`}
            onRemove={() => set({ items: draft.items.filter((i) => i.id !== item.id) })}
          />
        ))}
        {draft.subgroups.map((sub) => (
          <Chip
            key={`s${sub.code}`}
            label={`Subgroup: ${sub.name ?? sub.code}`}
            onRemove={() => set({ subgroups: draft.subgroups.filter((s) => s.code !== sub.code) })}
          />
        ))}
        {draft.groups.map((group) => (
          <Chip
            key={`g${group.code}`}
            label={`Group: ${group.name ?? group.code}`}
            onRemove={() => set({ groups: draft.groups.filter((g) => g.code !== group.code) })}
          />
        ))}
        {draft.item_kinds.map((kind) => (
          <Chip
            key={`k${kind}`}
            label={`All ${KIND_LABELS[kind]?.toLowerCase() ?? kind}`}
            onRemove={() => set({ item_kinds: draft.item_kinds.filter((k) => k !== kind) })}
          />
        ))}
      </div>

      <div className="bill-form brep-filters">
        <div className="fset__field brep-field">
          <label htmlFor={groupId}>Add a group</label>
          <select
            id={groupId}
            className="jb-assign"
            value=""
            onChange={(e) => {
              const group = catalog.options.groups.find((g) => g.code === e.target.value);
              if (group)
                set({
                  groups: [...draft.groups, { code: group.code.toLowerCase(), name: group.name }],
                });
            }}
          >
            <option value="">Choose a group</option>
            {groups.map((g) => (
              <option key={g.code} value={g.code}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="fset__field brep-field">
          <label htmlFor={subgroupId}>Add a subgroup</label>
          <select
            id={subgroupId}
            className="jb-assign"
            value=""
            onChange={(e) => {
              const sub = catalog.options.subgroups.find((s) => s.code === e.target.value);
              if (sub)
                set({
                  subgroups: [...draft.subgroups, { code: sub.code.toLowerCase(), name: sub.name }],
                });
            }}
          >
            <option value="">Choose a subgroup</option>
            {subgroups.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <ItemPicker taken={itemIds} onAdd={(item) => set({ items: [...draft.items, item] })} />
        <fieldset className="bdash-kinds">
          <legend>Every item of kind</legend>
          {ITEM_KINDS.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={draft.item_kinds.includes(kind)}
                onChange={(e) =>
                  set({
                    item_kinds: e.target.checked
                      ? [...draft.item_kinds, kind]
                      : draft.item_kinds.filter((k) => k !== kind),
                  })
                }
              />
              {kind}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="brep-quick">
        <button
          type="submit"
          className="flow-btn flow-btn-mini flow-btn-primary"
          disabled={!dirty || !draft.label.trim() || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save column"}
        </button>
        {dirty ? (
          <button
            type="button"
            className="flow-btn flow-btn-mini flow-btn-ghost"
            onClick={() => set(draftOf(column))}
          >
            Undo changes
          </button>
        ) : null}
        {note ? (
          <span className="bdash-status" role="status">
            {note}
          </span>
        ) : null}
        {error ? (
          <span className="brep-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export default function MisColumnsPage() {
  const catalog = useBillingReportCatalog();
  const columns = useMisColumns();
  const loading = catalog.isLoading || columns.isLoading;
  const failed = catalog.error || columns.error;
  return (
    <div className="flow-root fset bill-ui bdash-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">MIS columns</h1>
          <div className="bdash-actions">
            <Link className="flow-btn flow-btn-mini flow-btn-ghost" to="/billing/dashboard">
              Back to dashboard
            </Link>
          </div>
        </div>
        <div className="fset__cardsub">
          Choose which services count under each charge column of the MIS summary. A bill line goes
          to the most specific match — an item first, then its subgroup, then its group, then its
          kind. Anything not matched counts as Miscellaneous. Changes apply to past dates too, and
          every change is recorded in the billing audit.
        </div>
      </div>
      {loading ? (
        <Shimmer type="list" count={4} />
      ) : failed ? (
        <div className="flow-card brep-error" role="alert">
          {errorOf(failed, "Could not load the MIS columns")}{" "}
          <button
            type="button"
            className="flow-btn flow-btn-mini"
            onClick={() => {
              catalog.refetch();
              columns.refetch();
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {columns.data.columns.map((column) => (
            <ColumnEditor key={column.key} column={column} catalog={catalog.data} />
          ))}
          <div className="flow-card bdash-muted">
            <strong>{columns.data.misc.label}</strong> — every service not matched above.{" "}
            <strong>{columns.data.pharmacy.label}</strong> — {columns.data.pharmacy.note}.
          </div>
        </>
      )}
    </div>
  );
}
