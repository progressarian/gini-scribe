import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { toast } from "../stores/uiStore.js";
import useDebounced from "../hooks/useDebounced";
import ConfirmModal from "../components/ui/ConfirmModal.jsx";
import { useMedicineSearch } from "../queries/hooks/useGiniflowPrescription";
import "./PrescriptionFooterPage.css";
import "./MedicineOrderSettingsPage.css";

const QUERY_KEY = ["settings", "rx-order"];

const TABS = [
  { key: "categories", label: "Categories" },
  { key: "classes", label: "Drug classes" },
  { key: "pins", label: "Pinned medicines" },
];
const FALLBACK_CATEGORY = "other";

const useRxOrder = () =>
  useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api.get("/api/settings/rx-order")).data,
  });

let draftKey = 0;
const nextKey = () => `k${(draftKey += 1)}`;

const toDraft = (rules) => ({
  categories: rules.categories.map((c) => ({
    key: nextKey(),
    id: c.id,
    label: c.label,
    keywords: c.keywords.join(", "),
  })),
  classes: rules.classes.map((c) => ({
    key: nextKey(),
    id: c.id,
    category: c.category,
    label: c.label,
    keywords: c.keywords.join(", "),
  })),
  pins: rules.pins.map((p) => ({ key: nextKey(), ...p, position: String(p.position) })),
});

const splitKeywords = (text) =>
  text
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

const toPayload = (draft) => ({
  categories: draft.categories.map((c) => ({
    id: c.id || null,
    label: c.label.trim(),
    keywords: splitKeywords(c.keywords),
  })),
  classes: draft.classes.map((c) => ({
    id: c.id || null,
    category: c.category,
    label: c.label.trim(),
    keywords: splitKeywords(c.keywords),
  })),
  pins: draft.pins.map((p) => ({
    medicine: p.medicine.trim(),
    category: p.category,
    position: Number(p.position),
  })),
});

const validate = (draft) => {
  const errors = {};
  for (const c of draft.categories) if (!c.label.trim()) errors[c.key] = "Enter a category name.";
  for (const c of draft.classes) if (!c.label.trim()) errors[c.key] = "Enter a drug class name.";
  for (const p of draft.pins) {
    const n = Number(p.position);
    if (!Number.isInteger(n) || n < 1 || n > 999)
      errors[p.key] = "Enter a position between 1 and 999.";
  }
  return errors;
};

const swap = (list, from, to) => {
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
};

function MoveButtons({ label, canUp, canDown, onUp, onDown }) {
  return (
    <span className="mord__move">
      <button
        type="button"
        className="mord__moveBtn"
        aria-label={`Move ${label} up`}
        disabled={!canUp}
        onClick={onUp}
      >
        ▲
      </button>
      <button
        type="button"
        className="mord__moveBtn"
        aria-label={`Move ${label} down`}
        disabled={!canDown}
        onClick={onDown}
      >
        ▼
      </button>
    </span>
  );
}

function CategorySelect({ id, value, categories, onChange, label }) {
  return (
    <select
      id={id}
      className="rxf__input mord__select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {categories.map((c) => (
        <option key={c.key} value={c.id} disabled={!c.id}>
          {c.label || "Unnamed category"}
          {!c.id ? " (save first)" : ""}
        </option>
      ))}
    </select>
  );
}

function CategoriesSection({ draft, setDraft, errors }) {
  const update = (key, patch) =>
    setDraft((d) => ({
      ...d,
      categories: d.categories.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    }));
  const move = (i, to) => setDraft((d) => ({ ...d, categories: swap(d.categories, i, to) }));
  const remove = (category) =>
    setDraft((d) => ({
      categories: d.categories.filter((c) => c.key !== category.key),
      classes: d.classes.filter((c) => c.category !== category.id),
      pins: d.pins.map((p) =>
        p.category === category.id ? { ...p, category: FALLBACK_CATEGORY } : p,
      ),
    }));

  return (
    <fieldset className="rxf__group">
      <legend className="rxf__legend">Category order</legend>
      <p className="rxf__hint">
        Medicines are listed category by category, top to bottom. A medicine joins the first
        category whose keyword appears in its brand name, composition or drug class. Medicines that
        match no keyword go to “Other”.
      </p>
      <ol className="mord__list">
        {draft.categories.map((c, i) => {
          const fixed = c.id === FALLBACK_CATEGORY;
          return (
            <li className="mord__row" key={c.key}>
              <span className="mord__pos" aria-hidden="true">
                {i + 1}
              </span>
              <div className="mord__fields">
                <label className="mord__field">
                  <span className="rxf__label">Category name</span>
                  <input
                    className="rxf__input"
                    value={c.label}
                    maxLength={80}
                    aria-invalid={!!errors[c.key]}
                    aria-describedby={errors[c.key] ? `${c.key}-err` : undefined}
                    onChange={(e) => update(c.key, { label: e.target.value })}
                  />
                  {errors[c.key] && (
                    <span className="mord__error" id={`${c.key}-err`}>
                      {errors[c.key]}
                    </span>
                  )}
                </label>
                <label className="mord__field mord__field--wide">
                  <span className="rxf__label">Keywords (comma separated)</span>
                  <textarea
                    className="rxf__input mord__keywords"
                    value={c.keywords}
                    rows={2}
                    placeholder={fixed ? "Catches every medicine no other category matched" : ""}
                    disabled={fixed}
                    onChange={(e) => update(c.key, { keywords: e.target.value })}
                  />
                </label>
              </div>
              <div className="mord__rowActs">
                <MoveButtons
                  label={c.label || "category"}
                  canUp={i > 0}
                  canDown={i < draft.categories.length - 1}
                  onUp={() => move(i, i - 1)}
                  onDown={() => move(i, i + 1)}
                />
                {!fixed && (
                  <button type="button" className="mord__remove" onClick={() => remove(c)}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="rxf__add"
        onClick={() =>
          setDraft((d) => ({
            ...d,
            categories: [...d.categories, { key: nextKey(), id: "", label: "", keywords: "" }],
          }))
        }
      >
        + Add category
      </button>
    </fieldset>
  );
}

function ClassesSection({ draft, setDraft, errors }) {
  const savedCategories = draft.categories.filter((c) => c.id);
  const update = (key, patch) =>
    setDraft((d) => ({
      ...d,
      classes: d.classes.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    }));
  const moveWithin = (key, direction) =>
    setDraft((d) => {
      const from = d.classes.findIndex((c) => c.key === key);
      const category = d.classes[from].category;
      const step = direction === "up" ? -1 : 1;
      let to = from + step;
      while (to >= 0 && to < d.classes.length && d.classes[to].category !== category) to += step;
      if (to < 0 || to >= d.classes.length) return d;
      return { ...d, classes: swap(d.classes, from, to) };
    });

  const grouped = draft.categories
    .filter((cat) => cat.id)
    .map((cat) => ({ cat, classes: draft.classes.filter((c) => c.category === cat.id) }))
    .filter((g) => g.classes.length);

  return (
    <fieldset className="rxf__group">
      <legend className="rxf__legend">Drug classes inside a category</legend>
      <p className="rxf__hint">
        Within a category, medicines follow this class order. For example, in Diabetes: insulin,
        then metformin, then SGLT2. Medicines with no matching class come after the listed classes,
        A–Z.
      </p>
      {grouped.length === 0 && (
        <p className="rxf__note">No drug classes yet. Add one to order medicines in a category.</p>
      )}
      {grouped.map(({ cat, classes }) => (
        <section className="mord__group" key={cat.key} aria-label={`${cat.label} drug classes`}>
          <h3 className="mord__groupTitle">{cat.label}</h3>
          <ol className="mord__list">
            {classes.map((c, i) => (
              <li className="mord__row" key={c.key}>
                <span className="mord__pos" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="mord__fields">
                  <label className="mord__field">
                    <span className="rxf__label">Class name</span>
                    <input
                      className="rxf__input"
                      value={c.label}
                      maxLength={80}
                      aria-invalid={!!errors[c.key]}
                      aria-describedby={errors[c.key] ? `${c.key}-err` : undefined}
                      onChange={(e) => update(c.key, { label: e.target.value })}
                    />
                    {errors[c.key] && (
                      <span className="mord__error" id={`${c.key}-err`}>
                        {errors[c.key]}
                      </span>
                    )}
                  </label>
                  <div className="mord__field">
                    <label className="rxf__label" htmlFor={`${c.key}-cat`}>
                      Category
                    </label>
                    <CategorySelect
                      id={`${c.key}-cat`}
                      value={c.category}
                      categories={savedCategories}
                      onChange={(category) => update(c.key, { category })}
                    />
                  </div>
                  <label className="mord__field mord__field--wide">
                    <span className="rxf__label">Keywords (comma separated)</span>
                    <textarea
                      className="rxf__input mord__keywords"
                      value={c.keywords}
                      rows={2}
                      onChange={(e) => update(c.key, { keywords: e.target.value })}
                    />
                  </label>
                </div>
                <div className="mord__rowActs">
                  <MoveButtons
                    label={c.label || "class"}
                    canUp={i > 0}
                    canDown={i < classes.length - 1}
                    onUp={() => moveWithin(c.key, "up")}
                    onDown={() => moveWithin(c.key, "down")}
                  />
                  <button
                    type="button"
                    className="mord__remove"
                    onClick={() =>
                      setDraft((d) => ({ ...d, classes: d.classes.filter((x) => x.key !== c.key) }))
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {savedCategories.length > 0 && (
        <button
          type="button"
          className="rxf__add"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              classes: [
                ...d.classes,
                {
                  key: nextKey(),
                  id: "",
                  category: savedCategories[0].id,
                  label: "",
                  keywords: "",
                },
              ],
            }))
          }
        >
          + Add drug class
        </button>
      )}
    </fieldset>
  );
}

function PinsSection({ draft, setDraft, errors }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const { data, isFetching, isError } = useMedicineSearch(debounced);
  const savedCategories = draft.categories.filter((c) => c.id);
  const pinned = new Set(draft.pins.map((p) => p.medicine.toUpperCase()));
  const results = (data?.results || []).filter((r) => !pinned.has(r.name.toUpperCase()));
  const update = (key, patch) =>
    setDraft((d) => ({ ...d, pins: d.pins.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
  const addPin = (name) => {
    setDraft((d) => ({
      ...d,
      pins: [
        ...d.pins,
        { key: nextKey(), medicine: name, category: savedCategories[0]?.id, position: "1" },
      ],
    }));
    setQuery("");
  };

  return (
    <fieldset className="rxf__group">
      <legend className="rxf__legend">Pinned medicines</legend>
      <p className="rxf__hint">
        A pinned medicine always goes in the chosen category, at the chosen position, ahead of the
        unpinned medicines in that category. Position 1 is the top of the category.
      </p>
      <label className="rxf__field">
        <span className="rxf__label">Find a medicine to pin</span>
        <input
          className="rxf__input"
          type="search"
          value={query}
          placeholder="Search by brand name, e.g. Glycomet"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {debounced.trim().length >= 2 && (
        <div className="mord__results" aria-live="polite">
          {isFetching && <p className="rxf__note">Searching…</p>}
          {isError && <p className="mord__error">Could not search medicines. Try again.</p>}
          {!isFetching && !isError && results.length === 0 && (
            <p className="rxf__note">No medicine matches “{debounced.trim()}”.</p>
          )}
          {results.slice(0, 8).map((r) => (
            <button
              type="button"
              key={r.name}
              className="mord__result"
              onClick={() => addPin(r.name)}
            >
              <strong>{r.name}</strong>
              {r.composition && <span>{r.composition}</span>}
            </button>
          ))}
          {debounced.trim() && !pinned.has(debounced.trim().toUpperCase()) && (
            <button
              type="button"
              className="mord__result mord__result--typed"
              onClick={() => addPin(debounced.trim())}
            >
              Pin “{debounced.trim()}” as typed
            </button>
          )}
        </div>
      )}
      {draft.pins.length === 0 ? (
        <p className="rxf__note mord__empty">
          No medicines pinned. Category and class order decide every position.
        </p>
      ) : (
        <table className="mord__table">
          <thead>
            <tr>
              <th scope="col">Medicine</th>
              <th scope="col">Category</th>
              <th scope="col">Position</th>
              <th scope="col">
                <span className="mord__sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.pins.map((p) => (
              <tr key={p.key}>
                <td className="mord__medicine">{p.medicine}</td>
                <td>
                  <CategorySelect
                    value={p.category}
                    categories={savedCategories}
                    label={`Category for ${p.medicine}`}
                    onChange={(category) => update(p.key, { category })}
                  />
                </td>
                <td>
                  <input
                    className="rxf__input mord__number"
                    type="number"
                    min={1}
                    max={999}
                    aria-label={`Position of ${p.medicine}`}
                    aria-invalid={!!errors[p.key]}
                    aria-describedby={errors[p.key] ? `${p.key}-err` : undefined}
                    value={p.position}
                    onChange={(e) => update(p.key, { position: e.target.value })}
                  />
                  {errors[p.key] && (
                    <span className="mord__error" id={`${p.key}-err`}>
                      {errors[p.key]}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="mord__remove"
                    onClick={() =>
                      setDraft((d) => ({ ...d, pins: d.pins.filter((x) => x.key !== p.key) }))
                    }
                  >
                    Unpin
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </fieldset>
  );
}

export default function MedicineOrderSettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useRxOrder();
  const [draft, setDraft] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (data?.rules) setDraft(toDraft(data.rules));
  }, [data]);

  const onSaved = (message) => (next) => {
    queryClient.setQueryData(QUERY_KEY, next);
    toast(message, "success");
  };
  const onFailed = (e) =>
    toast(e?.response?.data?.error || "Could not save the medicine order. Try again.", "error");

  const save = useMutation({
    mutationFn: async (body) => (await api.put("/api/settings/rx-order", body)).data,
    onSuccess: onSaved("Medicine order saved. New prescriptions follow it."),
    onError: onFailed,
  });
  const reset = useMutation({
    mutationFn: async () => (await api.delete("/api/settings/rx-order")).data,
    onSuccess: (next) => {
      setConfirmReset(false);
      onSaved("Built-in medicine order restored.")(next);
    },
    onError: onFailed,
  });

  const [params, setParams] = useSearchParams();
  const tabsId = useId();
  const tab = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "categories";
  const onTabKey = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex((t) => t.key === tab) + step + TABS.length) % TABS.length];
    setParams({ tab: next.key }, { replace: true });
    document.getElementById(`${tabsId}-${next.key}`)?.focus();
  };
  const errors = useMemo(() => (draft ? validate(draft) : {}), [draft]);
  const errorCount = useMemo(() => {
    if (!draft) return {};
    const count = (list) => list.filter((x) => errors[x.key]).length;
    return {
      categories: count(draft.categories),
      classes: count(draft.classes),
      pins: count(draft.pins),
    };
  }, [draft, errors]);
  const payload = draft ? toPayload(draft) : null;
  const dirty =
    !!data &&
    !!payload &&
    JSON.stringify(payload) !== JSON.stringify(toPayload(toDraft(data.rules)));
  const hasErrors = Object.keys(errors).length > 0;

  if (isLoading || (!draft && !isError)) return <p className="rxf__loading">Loading…</p>;
  if (isError)
    return (
      <div className="mord__state" role="alert">
        <p>Unable to load the medicine order.</p>
        <p className="rxf__note">
          Please try again. If the problem continues, contact an administrator.
        </p>
        <button type="button" className="rxf__reset" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );

  return (
    <div className="mord">
      <p className="rxf__sub">
        Sets the order medicines are listed in on the consultant and MO prescription screens.
        Doctors can still move a medicine by hand for one patient. Changes apply to prescriptions
        started after you save. To re-sort a draft that is already open, use “Standard order” on
        that prescription.
      </p>
      <form
        className="rxf__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!hasErrors) save.mutate(payload);
        }}
      >
        <div className="set__tabs mord__tabs" role="tablist" aria-label="Medicine order sections">
          {TABS.map((t) => {
            const count = errorCount[t.key];
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`${tabsId}-${t.key}`}
                aria-selected={t.key === tab}
                aria-controls={`${tabsId}-panel`}
                tabIndex={t.key === tab ? 0 : -1}
                className={`set__tab${t.key === tab ? " set__tab--on" : ""}`}
                onClick={() => setParams({ tab: t.key }, { replace: true })}
                onKeyDown={onTabKey}
              >
                {t.label}
                {t.key === "pins" && draft.pins.length > 0 && ` (${draft.pins.length})`}
                {count > 0 && (
                  <span className="mord__tabErr">
                    {count} to fix<span className="mord__sr"> in {t.label}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
          {tab === "categories" && (
            <CategoriesSection draft={draft} setDraft={setDraft} errors={errors} />
          )}
          {tab === "classes" && (
            <ClassesSection draft={draft} setDraft={setDraft} errors={errors} />
          )}
          {tab === "pins" && <PinsSection draft={draft} setDraft={setDraft} errors={errors} />}
        </div>

        <div className="rxf__actions">
          <button
            className="rxf__save"
            type="submit"
            disabled={!dirty || hasErrors || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save order"}
          </button>
          {dirty && (
            <button
              type="button"
              className="rxf__reset"
              onClick={() => setDraft(toDraft(data.rules))}
            >
              Discard changes
            </button>
          )}
          <button
            type="button"
            className="rxf__reset"
            disabled={reset.isPending}
            onClick={() => setConfirmReset(true)}
          >
            Restore built-in order
          </button>
          {hasErrors && <span className="mord__error">Fix the highlighted fields to save.</span>}
        </div>
      </form>
      <ConfirmModal
        open={confirmReset}
        title="Restore the built-in medicine order?"
        message="Every category, drug class and pinned medicine you set here is replaced by the built-in clinical order: Diabetes first, Supplements last. Prescriptions already started keep their current order."
        confirmLabel={reset.isPending ? "Restoring…" : "Restore built-in order"}
        busy={reset.isPending}
        onConfirm={() => reset.mutate()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
