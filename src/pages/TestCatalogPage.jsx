import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { toast } from "../stores/uiStore.js";
// Same vocabulary as the other settings panels: .flow-* from flow.css, the
// .fset__* wrappers from FlowSettings.css, and the .flow-root .fset wrapper
// they are scoped under.
import "../styles/flow.css";
import "./flow/FlowSettings.css";
import "./TestCatalogPage.css";

// The clinic's test price list. One table behind the consultant's picker, the
// MO's chips and reception's payment card — so a test the floor added mid-clinic
// is priced here, and a typo is retired here, without a database session.
//
// The Test catalogue tab of /settings. It was its own page at
// /admin/test-catalog, which is now a redirect.

const useCatalog = () =>
  useQuery({
    queryKey: ["giniflow", "test-catalog"],
    queryFn: async () => (await api.get("/api/giniflow/test-catalog")).data,
  });

const useUpdateTest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }) =>
      (await api.patch(`/api/giniflow/test-catalog/${id}`, patch)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "test-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "test-panels"] });
    },
  });
};

const SOURCE_LABEL = (s) =>
  s === "prototype_placeholder"
    ? "placeholder price"
    : s === "priced_by_admin"
      ? "priced here"
      : s?.startsWith("added_by_doctor")
        ? "added on the floor"
        : s || "—";

function PriceCell({ test, onSave, saving }) {
  const [value, setValue] = useState(String(test.price));
  const dirty = value.trim() !== String(test.price);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ color: "#64748b" }}>₹</span>
      <input
        className="tcat__price"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && dirty && onSave(Number(value))}
      />
      {dirty && (
        <button
          type="button"
          className="tcat__save"
          disabled={saving || !(Number(value) >= 0)}
          onClick={() => onSave(Number(value))}
        >
          Save
        </button>
      )}
    </div>
  );
}

// Which station a test belongs to. Changing it moves where the NEXT order lands;
// orders already raised keep the station they were raised in, so a sample the lab
// has drawn cannot vanish off their queue because somebody re-filed the test.
const STATIONS = [
  { value: "lab", label: "🩸 Lab" },
  { value: "machine", label: "🫀 Machine" },
];

function StationCell({ test, onSave, saving }) {
  return (
    <select
      className="tcat__station"
      value={test.category || "lab"}
      disabled={saving}
      aria-label={`Station for ${test.name}`}
      onChange={(e) => onSave(e.target.value)}
    >
      {STATIONS.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

const useAddTest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => (await api.post("/api/giniflow/test-catalog", body)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "test-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "test-panels"] });
    },
  });
};

export default function TestCatalogPage() {
  const { data, isLoading } = useCatalog();
  const update = useUpdateTest();
  const addTest = useAddTest();
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [q, setQ] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [station, setStation] = useState("all");
  const [newStation, setNewStation] = useState("lab");

  const tests = data?.tests || [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tests.filter(
      (t) =>
        (showRetired || t.isActive) &&
        (station === "all" || (t.category || "lab") === station) &&
        (!needle || `${t.name} ${t.gloss || ""}`.toLowerCase().includes(needle)),
    );
  }, [tests, q, showRetired, station]);

  const perStation = useMemo(
    () =>
      STATIONS.map((s) => ({
        ...s,
        count: tests.filter((t) => t.isActive && (t.category || "lab") === s.value).length,
      })),
    [tests],
  );

  const unpriced = tests.filter((t) => t.isActive && !t.price).length;

  const save = (test, patch) =>
    update.mutate(
      { id: test.id, ...patch },
      {
        onSuccess: (t) => toast(`✓ ${t.name} updated`, "success"),
        onError: (e) => toast(e?.response?.data?.error || "Could not save that", "error"),
      },
    );

  return (
    <div className="flow-root fset tcat">
      <div className="flow-card">
        <div className="fset__cardhead">
          <div className="flow-sec-title">Test catalogue</div>
          <span className="fset__count">{tests.length}</span>
        </div>
        <div className="fset__cardsub">
          What the floor can order and what reception charges. A test added during a consultation
          arrives here priced ₹0 until someone sets it.
        </div>

        {unpriced > 0 && (
          <div className="tcat__warn">
            ⚠ {unpriced} active test{unpriced === 1 ? "" : "s"} priced ₹0 — they can be ordered and
            will bill nothing.
          </div>
        )}

        <div className="tcat__add">
          <strong>Add a test to the clinic list</strong>
          <input
            className="tcat__search"
            value={newName}
            placeholder="Test name — offered to every patient"
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="tcat__price"
            inputMode="decimal"
            value={newPrice}
            placeholder="₹ price"
            onChange={(e) => setNewPrice(e.target.value)}
          />
          <select
            className="tcat__station"
            value={newStation}
            aria-label="Station for the new test"
            onChange={(e) => setNewStation(e.target.value)}
          >
            {STATIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="tcat__save"
            disabled={newName.trim().length < 2 || addTest.isPending}
            onClick={() =>
              addTest.mutate(
                { name: newName.trim(), category: newStation },
                {
                  onSuccess: async (t) => {
                    const price = Number(newPrice);
                    if (price > 0) {
                      const row = (await api.get("/api/giniflow/test-catalog")).data.tests.find(
                        (x) => x.name === t.name,
                      );
                      if (row) update.mutate({ id: row.id, price });
                    }
                    setNewName("");
                    setNewPrice("");
                    toast(
                      t.created ? `✓ ${t.name} added` : `${t.name} was already listed`,
                      "success",
                    );
                  },
                  onError: (e) => toast(e?.response?.data?.error || "Could not add that", "error"),
                },
              )
            }
          >
            {addTest.isPending ? "Adding…" : "+ Add"}
          </button>
        </div>

        <div className="tcat__bar">
          <input
            className="tcat__search"
            value={q}
            placeholder="Search tests…"
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="tcat__toggle">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
            />
            Show retired
          </label>
          <div className="tcat__stations" role="group" aria-label="Filter by station">
            <button
              type="button"
              className={station === "all" ? "on" : ""}
              aria-pressed={station === "all"}
              onClick={() => setStation("all")}
            >
              All
            </button>
            {perStation.map((s) => (
              <button
                key={s.value}
                type="button"
                className={station === s.value ? "on" : ""}
                aria-pressed={station === s.value}
                onClick={() => setStation(station === s.value ? "all" : s.value)}
              >
                {s.label} <span className="tcat__scount">{s.count}</span>
              </button>
            ))}
          </div>
          <span className="tcat__count">
            {rows.length} of {tests.length}
          </span>
        </div>

        {isLoading ? (
          <div className="tcat__empty">Loading the catalogue…</div>
        ) : (
          <div className="tcat__scroll">
            <table className="tcat__table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Station</th>
                  <th>Price</th>
                  <th>What it is for</th>
                  <th>Where it came from</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className={t.isActive ? "" : "tcat__retired"}>
                    <td>
                      <strong>{t.name}</strong>
                    </td>
                    <td>
                      <StationCell
                        test={t}
                        saving={update.isPending}
                        onSave={(category) => save(t, { category })}
                      />
                    </td>
                    <td>
                      <PriceCell
                        test={t}
                        saving={update.isPending}
                        onSave={(price) => save(t, { price })}
                      />
                    </td>
                    <td>
                      <input
                        className="tcat__gloss"
                        defaultValue={t.gloss || ""}
                        placeholder="Why a doctor orders it"
                        onBlur={(e) => {
                          const gloss = e.target.value.trim();
                          if (gloss !== (t.gloss || "")) save(t, { gloss });
                        }}
                      />
                    </td>
                    <td className="tcat__src">{SOURCE_LABEL(t.source)}</td>
                    <td>
                      <button
                        type="button"
                        className="tcat__retire"
                        disabled={update.isPending}
                        onClick={() => save(t, { isActive: !t.isActive })}
                      >
                        {t.isActive ? "Retire" : "Restore"}
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="tcat__empty">
                      Nothing matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
