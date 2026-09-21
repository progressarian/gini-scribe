import { useId, useState } from "react";
import {
  useBillingCategories,
  useBillingGroups,
  useBillingRateGrid,
  useBillingRateHistory,
  useDeleteBillingCategoryRate,
  useSaveBillingCategoryRate,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import RateHistoryDialog from "../../components/billing/RateHistoryDialog";
import { errorOf, rupees } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";

const text = (v) => (v === null || v === undefined ? "" : String(v));

function Source({ source, parentName }) {
  if (source === "own") return <span className="bill-src bill-src--own">Own</span>;
  if (source === "parent") return <span className="bill-src">From {parentName}</span>;
  return <span className="bill-src bill-src--base">Base price</span>;
}

function Picker({ label, value, onChange, children }) {
  const id = useId();
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="jb-assign" value={value} onChange={onChange}>
        {children}
      </select>
    </div>
  );
}

function EditRow({ item, code, today, onDone }) {
  const save = useSaveBillingCategoryRate();
  const [form, setForm] = useState({
    rate: text(item.own?.rate),
    bill_name: text(item.own?.bill_name),
    bill_code: text(item.own?.bill_code),
    valid_from: today,
    valid_to: "",
  });
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const submit = async () => {
    setError("");
    try {
      const result = await save.mutateAsync({
        scheme_code: code,
        service_item_id: item.service_item_id,
        rate: form.rate.trim(),
        bill_name: form.bill_name.trim() || null,
        bill_code: form.bill_code.trim() || null,
        valid_from: form.valid_from,
        valid_to: form.valid_to,
      });
      toast(`Saved the rate for ${item.name}`, "success");
      if (result.starts_in_past) {
        toast("This rate starts in the past — bills already made keep their price", "warn", 6000);
      }
      onDone();
    } catch (err) {
      setError(errorOf(err, "Could not save the rate"));
    }
  };
  const input = (key, label, props = {}) => (
    <input
      className="jb-assign"
      aria-label={`${label} for ${item.name}`}
      value={form[key]}
      onChange={set(key)}
      {...props}
    />
  );
  return (
    <tr className="bill-rates__editing">
      <td>
        {item.group_name} › {item.subgroup_name}
      </td>
      <td>{item.name}</td>
      <td>{rupees(item.base_price)}</td>
      <td>
        {input("rate", "Rate", {
          inputMode: "decimal",
          placeholder: `${rupees(item.rate)} (${item.rate_source === "own" ? "own" : item.rate_source === "parent" ? "inherited" : "base price"})`,
        })}
      </td>
      <td>{input("bill_name", "Bill name", { placeholder: item.name })}</td>
      <td>{input("bill_code", "Bill code")}</td>
      <td className="bill-rates__dates">
        {input("valid_from", "From", { type: "date", required: true })}
        {input("valid_to", "To", { type: "date" })}
      </td>
      <td className="bill-items__actions">
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini"
          disabled={save.isPending}
          onClick={submit}
        >
          Save
        </button>
        <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onDone}>
          Cancel
        </button>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function ClearControls({ item, code, onDone }) {
  const history = useBillingRateHistory(code, item.service_item_id);
  const checking = history.isLoading;
  const remove = useDeleteBillingCategoryRate();
  const previous = (history.data ?? []).find((r) => {
    if (!r.valid_to) return false;
    const next = new Date(`${r.valid_to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10) === item.own.valid_from;
  });
  const clear = async (reopen) => {
    try {
      await remove.mutateAsync({
        scheme_code: code,
        service_item_id: item.service_item_id,
        valid_from: item.own.valid_from,
        ...(reopen ? { reopen_previous: true } : {}),
      });
      toast(`Cleared the rate for ${item.name}`, "success");
      onDone();
    } catch (err) {
      toast(errorOf(err), "error");
    }
  };
  return (
    <span className="bill-rates__confirm" role="group" aria-label={`Clear rate for ${item.name}`}>
      <button
        type="button"
        className="flow-btn flow-btn-red flow-btn-mini"
        disabled={checking || remove.isPending}
        onClick={() => clear(false)}
      >
        {checking ? "Checking…" : "Clear"}
      </button>
      {previous ? (
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          disabled={remove.isPending}
          onClick={() => clear(true)}
        >
          Clear and go back to{" "}
          {previous.rate === null ? "the previous rate" : rupees(previous.rate)}
        </button>
      ) : null}
      <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onDone}>
        Keep
      </button>
    </span>
  );
}

function RateRow({ item, parentName, onEdit, onHistory, clearing, onClear, onClearDone, code }) {
  const dates = item.own
    ? `${item.own.valid_from} → ${item.own.valid_to ?? "no end"}`
    : item.rate_source === "parent"
      ? "Inherited"
      : "—";
  return (
    <tr>
      <td>
        {item.group_name} › {item.subgroup_name}
      </td>
      <td>
        {item.name}
        <div className="flow-muted bill-items__sub">{item.code}</div>
      </td>
      <td>{rupees(item.base_price)}</td>
      <td>
        {rupees(item.rate)} <Source source={item.rate_source} parentName={parentName} />
      </td>
      <td>
        {item.bill_name}
        {item.bill_name_source === "parent" ? (
          <Source source="parent" parentName={parentName} />
        ) : null}
      </td>
      <td>
        {item.bill_code ?? "—"}
        {item.bill_code_source === "parent" ? (
          <Source source="parent" parentName={parentName} />
        ) : null}
      </td>
      <td>
        {dates}
        {item.next_valid_from ? (
          <div className="flow-muted bill-items__sub">Changes on {item.next_valid_from}</div>
        ) : null}
      </td>
      <td className="bill-items__actions">
        {clearing ? (
          <ClearControls item={item} code={code} onDone={onClearDone} />
        ) : (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Edit rate for ${item.name}`}
              onClick={onEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              aria-label={`Every rate for ${item.name}`}
              onClick={onHistory}
            >
              History
            </button>
            {item.own ? (
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                aria-label={`Clear rate for ${item.name}`}
                onClick={onClear}
              >
                Clear
              </button>
            ) : null}
          </>
        )}
      </td>
    </tr>
  );
}

export default function CategoryRatesPage() {
  const { data: tree = [] } = useBillingCategories({ activeOnly: true });
  const { data: groups = [] } = useBillingGroups({ activeOnly: true });
  const [code, setCode] = useState("");
  const [groupId, setGroupId] = useState("");
  const [date, setDate] = useState("");
  const [editing, setEditing] = useState(null);
  const [clearing, setClearing] = useState(null);
  const [history, setHistory] = useState(null);
  const [q, setQ] = useState("");
  const { data: grid, isLoading, isError } = useBillingRateGrid(code, { groupId, date });
  const dateId = useId();

  const parent = tree.find((top) => top.sub_categories.some((sub) => sub.code === code));
  const parentName = parent?.label;

  const choose = (setter) => (e) => {
    setEditing(null);
    setClearing(null);
    setter(e.target.value);
  };

  const needle = q.trim().toLowerCase();
  const items = (grid?.items ?? []).filter(
    (item) =>
      !needle ||
      item.name.toLowerCase().includes(needle) ||
      item.code.toLowerCase().includes(needle),
  );
  const startsOn = grid && date > grid.today ? date : grid?.today;

  return (
    <div className="flow-root fset">
      <div className="flow-card">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Category rates</h2>
        </div>
        <div className="fset__cardsub">
          What each category pays for each service. A sub-category uses its parent's rate, bill name
          and bill code unless it has its own; with neither, the base price applies.
        </div>
        <div className="bill-form">
          <Picker label="Category" value={code} onChange={choose(setCode)}>
            <option value="">Choose a category</option>
            {tree.flatMap((top) => [
              <option key={top.code} value={top.code}>
                {top.label}
              </option>,
              ...top.sub_categories.map((sub) => (
                <option key={sub.code} value={sub.code}>
                  {`   ${sub.display_label}`}
                </option>
              )),
            ])}
          </Picker>
          <Picker label="Group" value={groupId} onChange={choose(setGroupId)}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Picker>
          <div className="fset__field">
            <label htmlFor={`${dateId}-q`}>Search</label>
            <input
              id={`${dateId}-q`}
              type="search"
              className="jb-assign"
              placeholder="Item name or code"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="fset__field fset__field--narrow bill-rates__asof">
            <label htmlFor={dateId}>As of</label>
            <input
              id={dateId}
              type="date"
              className="jb-assign"
              value={date}
              onChange={choose(setDate)}
            />
          </div>
        </div>
      </div>

      {!code ? null : isError ? (
        <div className="flow-card fset__cardsub">Could not load the rates.</div>
      ) : isLoading || !grid ? (
        <div className="flow-card fset__cardsub">Loading…</div>
      ) : (
        <div className="flow-card bill-rates">
          <div className="fset__cardhead">
            <h2 className="flow-sec-title">{grid.category.display_label}</h2>
            <span className="fset__count">{items.length}</span>
            <span className="flow-muted bill-rates__on">as of {grid.date}</span>
          </div>
          {!items.length ? (
            <div className="fset__cardsub">
              {needle ? "No item matches that search." : "No active items"}
              {needle || !groupId ? "" : " in this group"}
              {needle ? "" : "."}
            </div>
          ) : (
            <div className="fset__scroll fset__scroll--wide">
              <table className="flow-table" aria-label="Rates">
                <thead>
                  <tr>
                    <th>Group › subgroup</th>
                    <th>Item</th>
                    <th>Base price</th>
                    <th>Rate</th>
                    <th>Bill name</th>
                    <th>Bill code</th>
                    <th>Valid</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) =>
                    editing === item.service_item_id ? (
                      <EditRow
                        key={item.service_item_id}
                        item={item}
                        code={code}
                        today={startsOn}
                        onDone={() => setEditing(null)}
                      />
                    ) : (
                      <RateRow
                        key={item.service_item_id}
                        item={item}
                        code={code}
                        parentName={parentName}
                        clearing={clearing === item.service_item_id}
                        onEdit={() => {
                          setClearing(null);
                          setEditing(item.service_item_id);
                        }}
                        onClear={() => {
                          setEditing(null);
                          setClearing(item.service_item_id);
                        }}
                        onClearDone={() => setClearing(null)}
                        onHistory={() => setHistory(item)}
                      />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <RateHistoryDialog
        item={history}
        code={code}
        categoryName={grid?.category.display_label}
        onClose={() => setHistory(null)}
      />
    </div>
  );
}
