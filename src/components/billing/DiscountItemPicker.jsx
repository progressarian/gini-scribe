import { useId, useState } from "react";
import { useBillingItems } from "../../queries/hooks/useBillingMaster";
import { rupees } from "./format";

export default function DiscountItemPicker({ label, chosenIds = [], onPick }) {
  const [q, setQ] = useState("");
  const id = useId();
  const needle = q.trim();
  const { data, isFetching } = useBillingItems({ q: needle, active: "true", limit: "20" });
  const found = needle ? (data?.items ?? []).filter((item) => !chosenIds.includes(item.id)) : [];

  return (
    <div className="disc-picker">
      <div className="fset__field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="search"
          className="jb-assign"
          placeholder="Item name or code"
          maxLength={100}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
      </div>
      {needle ? (
        found.length ? (
          <ul className="disc-picker__found" aria-label={`${label} — matches`}>
            {found.map((item) => (
              <li key={item.id}>
                <span>
                  {item.name}
                  <span className="flow-muted disc-picker__meta">
                    {item.group_name} › {item.subgroup_name} · {rupees(item.base_price)}
                  </span>
                </span>
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  aria-label={`Add ${item.name}`}
                  onClick={() => onPick(item)}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fset__hint">{isFetching ? "Searching…" : "No active item matches."}</p>
        )
      ) : null}
    </div>
  );
}
