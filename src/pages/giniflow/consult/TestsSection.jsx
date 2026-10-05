import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTestPanels, useOrderTests } from "../../../queries/hooks/useGiniflowPrescription";
import { VoiceButton } from "../../../components/giniflow/VoiceInput";

// Tests — gini-doctor-final.html `s-tests`.
//
// Straight reuse of the MO station's ordering: same panels, same catalog, same
// `orderTests` service. Two stations offering different tests would be two
// answers to the same question.

const URGENCY = [
  { key: "today", label: "Today", sub: "lab now" },
  { key: "tomorrow", label: "Tomorrow", sub: "reception" },
  { key: "next_visit", label: "Next visit", sub: "with the follow-up" },
];

const monthLabel = (ymd) => {
  const [y, m] = (ymd || "").split("-").map(Number);
  if (!y) return "";
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
};

const searchText = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const rupees = (amount) => `₹${Number(amount || 0).toLocaleString("en-IN")}`;

function buildTestIndex(tests) {
  return tests.map((test) => {
    const name = searchText(test.name);
    const words = `${name} ${searchText(test.gloss)}`;
    return { test, name, words, compact: words.replace(/ /g, "") };
  });
}

const MIN_SEARCH_LENGTH = 2;

const byUsageThenName = (a, b) =>
  (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name, "en", { sensitivity: "base" });

function searchTests(index, query) {
  const tokens = searchText(query).split(" ").filter(Boolean);
  const matches =
    tokens.join("").length < MIN_SEARCH_LENGTH
      ? index
      : index.filter((entry) =>
          tokens.every((token) => entry.words.includes(token) || entry.compact.includes(token)),
        );
  return matches.map((entry) => entry.test).sort(byUsageThenName);
}

const POPULAR_LIMIT = 24;

function pickPopular(tests, panels) {
  const panelNames = new Set(panels.flatMap((p) => p.tests));
  const used = tests.filter((t) => t.uses > 0).sort((a, b) => b.uses - a.uses);
  const curated = tests.filter((t) => !(t.uses > 0) && (panelNames.has(t.name) || t.gloss));
  return new Set([...used, ...curated].slice(0, POPULAR_LIMIT).map((t) => t.name));
}

export default function TestsSection({ visitId, consult, readOnly, onToast, onUnsaved }) {
  const { data } = useTestPanels(visitId);
  const orderTests = useOrderTests(visitId);
  // Tests typed in for THIS patient. They ride on the order and are never added
  // to the clinic list — the next patient's picker is unchanged by them.
  const [custom, setCustom] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [urgency, setUrgency] = useState("next_visit");
  const [filter, setFilter] = useState("");
  const filterRef = useRef(null);
  const [customPrice, setCustomPrice] = useState("");
  const [showAll, setShowAll] = useState(false);

  // A selection is not an order — it lives here until Confirm, so leaving with
  // one is work the page has to ask about.
  const picked = selected.size;
  useEffect(() => {
    onUnsaved?.("tests", picked > 0);
  }, [picked, onUnsaved]);
  useEffect(() => () => onUnsaved?.("tests", false), [onUnsaved]);

  const panels = useMemo(() => data?.panels || [], [data]);
  // Tests the MO already ordered. Shown as ordered rather than offered again —
  // ordering the same panel twice bills the patient twice.
  const alreadyOrdered = new Set((consult.orders || []).flatMap((o) => o.tests));
  const catalog = useMemo(() => data?.tests || [], [data]);
  const testIndex = useMemo(() => buildTestIndex(catalog), [catalog]);
  const deferredFilter = useDeferredValue(filter);
  const matchedTests = useMemo(
    () => searchTests(testIndex, deferredFilter),
    [testIndex, deferredFilter],
  );
  const popularNames = useMemo(() => pickPopular(catalog, panels), [catalog, panels]);
  const searching = searchText(filter).replace(/ /g, "").length >= MIN_SEARCH_LENGTH;
  const visibleTests =
    searching || showAll
      ? matchedTests
      : matchedTests.filter(
          (t) => popularNames.has(t.name) || selected.has(t.name) || alreadyOrdered.has(t.name),
        );
  const priceByName = useMemo(
    () => new Map([...catalog, ...custom].map((t) => [t.name, Number(t.price) || 0])),
    [catalog, custom],
  );
  const selectedTotal = [...selected].reduce((sum, name) => sum + (priceByName.get(name) || 0), 0);

  const toggle = (name) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const togglePanel = (panel) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const all = panel.tests.every((t) => next.has(t));
      panel.tests.forEach((t) => (all ? next.delete(t) : next.add(t)));
      return next;
    });

  const customNames = new Set(custom.map((t) => t.name));
  const submit = () =>
    orderTests.mutate(
      {
        urgency,
        tests: [...selected].filter((n) => !customNames.has(n)),
        customTests: custom.filter((t) => selected.has(t.name)),
      },
      {
        onSuccess: (r) => {
          setCustom([]);
          setSelected(new Set());
          onToast(`✓ ${r.tests ?? selected.size} tests ordered`);
        },
        onError: (e) => onToast(e?.response?.data?.error || "Tests were not ordered"),
      },
    );

  return (
    <section className="csec" id="s-tests">
      <div className="cs-head">
        <h2>🔬 Tests to order</h2>
        <span className="cs-sub">panels or individual tests · set when they are needed</span>
        {!readOnly && (
          <div className="cs-head-r">
            {/* Dictation only: it puts the phrase in the filter box. Turning
                "order the diabetes panel" into a selection is §4b step 4. */}
            <VoiceButton
              small
              label="🎤 Voice"
              title={'Say: "Order diabetes panel for next visit" or "Add TSH today"'}
              onText={(text) => {
                setFilter(text);
                filterRef.current?.focus();
              }}
            />
          </div>
        )}
      </div>

      {(consult.orders || []).length > 0 && (
        <div className="tst-existing">
          {consult.orders.map((o) => (
            <div key={o.id}>
              <strong>{o.tests.length} already ordered</strong> · {o.urgency.replace("_", " ")} ·{" "}
              {o.payment_status} · {o.tests.join(", ")}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <>
          <div className="cn-head">When are these needed?</div>
          <div className="cp-chips">
            {URGENCY.map((u) => (
              <button
                type="button"
                key={u.key}
                className={urgency === u.key ? "on" : ""}
                onClick={() => setUrgency(u.key)}
              >
                {u.label}
                {u.key === "next_visit" && consult.nextVisitDate
                  ? ` · ${monthLabel(consult.nextVisitDate)}`
                  : ""}{" "}
                <em>— {u.sub}</em>
              </button>
            ))}
          </div>

          <div className="cn-head">Quick panels</div>
          <div className="tst-panels">
            {panels.map((p) => {
              const all = p.tests.every((t) => selected.has(t));
              return (
                <button
                  type="button"
                  key={p.key}
                  className={`tst-panel${all ? " on" : ""}`}
                  onClick={() => togglePanel(p)}
                >
                  <strong>
                    {p.icon} {p.label}
                  </strong>
                  <em>{p.tests.join(" · ")}</em>
                  <span>{p.tests.length} tests</span>
                </button>
              );
            })}
          </div>

          <div className="cn-head tst-head">
            {searching ? "Matching tests" : showAll ? "All tests" : "Most used tests"}
            {!searching && (
              <button type="button" className="btn-sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show most used only" : `Show all ${catalog.length}`}
              </button>
            )}
          </div>
          <div className="tst-heard">
            <input
              ref={filterRef}
              type="search"
              className="cp-inp tst-filter"
              value={filter}
              placeholder="Search tests by name or purpose — e.g. TSH, kidney, lipid"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilter("");
              }}
              aria-label="Search tests"
            />
            {filter && (
              <span className="tst-count" aria-live="polite">
                {searching
                  ? `${visibleTests.length} of ${catalog.length} tests`
                  : `Type at least ${MIN_SEARCH_LENGTH} characters to search`}
              </span>
            )}
            {filter && (
              <button type="button" className="btn-sm" onClick={() => setFilter("")}>
                Clear
              </button>
            )}
          </div>
          {(() => {
            const typed = filter.trim();
            const known =
              catalog.some((t) => t.name.toLowerCase() === typed.toLowerCase()) ||
              custom.some((t) => t.name.toLowerCase() === typed.toLowerCase());
            if (typed.length < 2 || known) return null;
            return (
              <div className="tst-new">
                <span>“{typed}” is not in the list — order it for this patient only?</span>
                <input
                  className="cp-inp tst-new__price"
                  inputMode="decimal"
                  placeholder="₹ price"
                  value={customPrice}
                  onChange={(e) => setCustomPrice(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-sm on"
                  onClick={() => {
                    setCustom((prev) => [
                      ...prev,
                      { name: typed, price: Number(customPrice) > 0 ? Number(customPrice) : 0 },
                    ]);
                    setSelected((prev) => new Set(prev).add(typed));
                    setFilter("");
                    setCustomPrice("");
                  }}
                >
                  + Add for this patient
                </button>
              </div>
            );
          })()}
          {custom.length > 0 && (
            <div className="tst-customlist">
              {custom.map((t) => (
                <span key={t.name} className="tst-custom">
                  {t.name} · {t.price ? `₹${t.price}` : "price not set"}
                  <button
                    type="button"
                    aria-label={`Remove ${t.name}`}
                    onClick={() => {
                      setCustom((prev) => prev.filter((c) => c.name !== t.name));
                      setSelected((prev) => {
                        const next = new Set(prev);
                        next.delete(t.name);
                        return next;
                      });
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="tst-list">
            {visibleTests.map((t) => (
              <button
                type="button"
                key={t.name}
                className={`tst-chip${selected.has(t.name) ? " on" : ""}${
                  alreadyOrdered.has(t.name) ? " done" : ""
                }`}
                onClick={() => toggle(t.name)}
              >
                <span className="tst-name">
                  {t.name}
                  {alreadyOrdered.has(t.name) && " ✓"}
                </span>
                {/* The reason a consultant picks this test, printed rather
                      than hidden in a tooltip no tablet can show. */}
                {t.gloss && <span className="tst-gloss">{t.gloss}</span>}
                <span
                  className="tst-price"
                  title={
                    t.schemePriced ? `Scheme rate · usual price ${rupees(t.basePrice)}` : undefined
                  }
                >
                  {t.price ? rupees(t.price) : "price not set"}
                  {t.schemePriced && " · scheme"}
                </span>
              </button>
            ))}
            {searching && visibleTests.length === 0 && (
              <div className="cn-empty">No test matches “{filter.trim()}”.</div>
            )}
          </div>

          {selected.size > 0 && (
            <div className="tst-bar">
              <span>
                📋 <strong>{selected.size} tests selected</strong> · {rupees(selectedTotal)} for{" "}
                {URGENCY.find((u) => u.key === urgency).label.toLowerCase()}
                {urgency === "next_visit" && consult.nextVisitDate
                  ? ` (${monthLabel(consult.nextVisitDate)})`
                  : ""}{" "}
                —{" "}
                {urgency === "next_visit"
                  ? "goes to reception and the lab when the visit is confirmed"
                  : "goes to reception and the lab"}
                {[...selected].some((t) => alreadyOrdered.has(t))
                  ? " · ⚠ some of these are already ordered"
                  : ""}
              </span>
              <button
                type="button"
                className="btn-sm on"
                disabled={orderTests.isPending}
                onClick={submit}
              >
                {orderTests.isPending ? "Ordering…" : "Confirm →"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
