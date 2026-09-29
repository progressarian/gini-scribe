import { useId, useState } from "react";
import {
  useAddBillingItemAlias,
  useBillingItemAliases,
  useRemoveBillingItemAlias,
} from "../../queries/hooks/useBillingMaster";
import { errorOf } from "./format";

export default function AlsoBilledAs({ item }) {
  const inputId = useId();
  const aliases = useBillingItemAliases(item.id);
  const add = useAddBillingItemAlias();
  const remove = useRemoveBillingItemAlias();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const busy = add.isPending || remove.isPending;

  const addName = async () => {
    setError("");
    if (!name.trim()) return setError("Type the name the floor orders this test under");
    try {
      await add.mutateAsync({ itemId: item.id, name: name.trim() });
      setName("");
    } catch (err) {
      setError(errorOf(err, "Could not add the name"));
    }
  };

  const removeName = async (alias) => {
    setError("");
    try {
      await remove.mutateAsync({ itemId: item.id, aliasId: alias.id });
    } catch (err) {
      setError(errorOf(err, "Could not remove the name"));
    }
  };

  const rows = aliases.data ?? [];

  return (
    <section aria-label="Also billed as">
      <h3 className="bill-item__section">Also billed as</h3>
      <p className="flow-muted bill-aliases__about">
        Other names the floor orders this test under. Saved straight away.
      </p>
      {aliases.isLoading ? (
        <p className="flow-muted">Loading…</p>
      ) : rows.length ? (
        <ul className="bill-aliases" aria-label="Also billed as names">
          {rows.map((alias) => (
            <li key={alias.id} className="bill-aliases__row">
              <span>{alias.name}</span>
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                aria-label={`Remove ${alias.name}`}
                disabled={busy}
                onClick={() => removeName(alias)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flow-muted">No other names yet.</p>
      )}
      <div className="bill-aliases__add">
        <label htmlFor={inputId}>Add a name</label>
        <input
          id={inputId}
          className="jb-assign"
          maxLength={200}
          placeholder="e.g. LIPID PROFILE"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            addName();
          }}
        />
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini"
          disabled={busy}
          onClick={addName}
        >
          Add
        </button>
      </div>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
