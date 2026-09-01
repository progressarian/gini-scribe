import { useState } from "react";
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

export default function TestsSection({ visitId, consult, readOnly, onToast }) {
  const { data } = useTestPanels();
  const orderTests = useOrderTests(visitId);
  const [selected, setSelected] = useState(() => new Set());
  const [urgency, setUrgency] = useState("next_visit");
  const [filter, setFilter] = useState("");

  const panels = data?.panels || [];
  const catalog = data?.tests || [];

  // Tests the MO already ordered. Shown as ordered rather than offered again —
  // ordering the same panel twice bills the patient twice.
  const alreadyOrdered = new Set((consult.orders || []).flatMap((o) => o.tests));

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

  const submit = () =>
    orderTests.mutate(
      { urgency, tests: [...selected] },
      {
        onSuccess: (r) => {
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
              onText={setFilter}
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

          <div className="cn-head">Individual tests</div>
          {filter && (
            <div className="tst-heard">
              Heard: &ldquo;{filter}&rdquo; — filtering the list.{" "}
              <button type="button" className="btn-sm" onClick={() => setFilter("")}>
                Clear
              </button>
            </div>
          )}
          <div className="tst-list">
            {catalog
              .filter(
                (t) =>
                  !filter ||
                  `${t.name} ${t.gloss || ""}`.toLowerCase().includes(filter.toLowerCase().trim()),
              )
              .map((t) => (
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
                </button>
              ))}
          </div>

          {selected.size > 0 && (
            <div className="tst-bar">
              <span>
                📋 <strong>{selected.size} tests selected</strong> for{" "}
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
