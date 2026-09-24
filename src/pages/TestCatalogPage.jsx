import { useMemo, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { toast } from "../stores/uiStore.js";
// Same vocabulary as the other settings panels: .flow-* from flow.css, the
// .fset__* wrappers from FlowSettings.css, and the .flow-root .fset wrapper
// they are scoped under.
import Pagination from "../components/ui/Pagination";
import useDialog from "../components/billing/useDialog";
import "../styles/flow.css";
import "./flow/FlowSettings.css";
import "./billing/billingUi.css";
import "./TestCatalogPage.css";

// The clinic's test price list. One table behind the consultant's picker, the
// MO's chips and reception's payment card — so a test the floor added mid-clinic
// is listed here, and a typo is retired here, without a database session. Its
// price comes from its billing item in Settings → Services.
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

function PriceCell({ test }) {
  const amount = `₹${Number(test.price || 0).toLocaleString("en-IN")}`;
  if (test.serviceItemCode) {
    return (
      <div className="tcat__priced">
        <strong>{amount}</strong>
        <Link
          to={`/settings/services?q=${encodeURIComponent(test.serviceItemCode)}`}
          aria-label={`${test.serviceItemCode} — change the price of ${test.name} in Services`}
        >
          {test.serviceItemCode}
        </Link>
      </div>
    );
  }
  return (
    <div className="tcat__priced">
      <span className="tcat__unbilled">{amount}</span>
      {test.offItemCode ? (
        <Link
          to={`/settings/services?q=${encodeURIComponent(test.offItemCode)}`}
          aria-label={`${test.offItemCode} is off — the billing item for ${test.name}`}
        >
          {test.offItemCode} is off
        </Link>
      ) : test.isActive ? (
        <Link
          to={`/settings/services?createTest=${encodeURIComponent(test.id)}`}
          aria-label={`Create item for ${test.name}`}
        >
          Create item
        </Link>
      ) : (
        <span className="tcat__unbilled">Retired</span>
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

function AddTestDialog({ busy, onAdd, onClose }) {
  const ref = useDialog(true, onClose);
  const [name, setName] = useState("");
  const [station, setStation] = useState("lab");
  const submit = (e) => {
    e.preventDefault();
    onAdd({ name: name.trim(), category: station });
  };
  return (
    <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog bill-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-test-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="add-test-title" className="bill-dialog__title">
          Add a test
        </h2>
        <p className="fset__cardsub">
          Offered to every patient on the floor. It has no price until you create its billing item
          in Services.
        </p>
        <div className="bill-form tcat__addform">
          <div className="fset__field">
            <label htmlFor="add-test-name">Test name</label>
            <input
              id="add-test-name"
              className="jb-assign"
              value={name}
              maxLength={120}
              placeholder="e.g. Vitamin D (25-OH)"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="fset__field">
            <label htmlFor="add-test-station">Station</label>
            <select
              id="add-test-station"
              className="jb-assign"
              value={station}
              onChange={(e) => setStation(e.target.value)}
            >
              {STATIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="flow-btn flow-btn-primary"
            disabled={name.trim().length < 2 || busy}
          >
            {busy ? "Adding…" : "Add test"}
          </button>
        </div>
      </form>
    </div>
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
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [station, setStation] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const tests = data?.tests || [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tests.filter(
      (t) =>
        (showRetired || t.isActive) &&
        (station === "all" || (t.category || "lab") === station) &&
        (!needle ||
          [t.name, t.gloss, t.serviceItemCode, t.offItemCode]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle)),
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

  const unbilled = tests.filter((t) => t.isActive && !t.serviceItemCode).length;
  const lastPage = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, lastPage);
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);
  const filter = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  const add = (body) =>
    addTest.mutate(body, {
      onSuccess: (t) => {
        setAdding(false);
        toast(t.created ? `✓ ${t.name} added` : `${t.name} was already listed`, "success");
      },
      onError: (e) => toast(e?.response?.data?.error || "Could not add that", "error"),
    });

  const save = (test, patch) =>
    update.mutate(
      { id: test.id, ...patch },
      {
        onSuccess: (t) => toast(`✓ ${t.name} updated`, "success"),
        onError: (e) => toast(e?.response?.data?.error || "Could not save that", "error"),
      },
    );

  return (
    <div className="flow-root fset bill-ui tcat">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Test catalogue</h2>
          <span className="fset__count">{tests.length}</span>
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini bill-tree__headbtn"
            onClick={() => setAdding(true)}
          >
            + Add test
          </button>
        </div>
        <div className="fset__cardsub">
          What the floor can order. Prices come from each test's billing item in Services — change
          them there.
        </div>

        {unbilled > 0 && (
          <div className="tcat__warn">
            <strong>
              {unbilled} active test{unbilled === 1 ? " has" : "s have"} no active billing item.
            </strong>{" "}
            Reception charges the old catalogue price until one is created.{" "}
            <Link to="/settings/services">Create them in Services</Link>
          </div>
        )}

        <div className="tcat__bar">
          <input
            type="search"
            className="jb-assign tcat__search"
            value={q}
            aria-label="Search tests by name or code"
            placeholder="Search name or code…"
            onChange={(e) => filter(setQ)(e.target.value)}
          />
          <div className="tcat__stations" role="group" aria-label="Filter by station">
            <button
              type="button"
              className={station === "all" ? "on" : ""}
              aria-pressed={station === "all"}
              onClick={() => filter(setStation)("all")}
            >
              All
            </button>
            {perStation.map((s) => (
              <button
                key={s.value}
                type="button"
                className={station === s.value ? "on" : ""}
                aria-pressed={station === s.value}
                onClick={() => filter(setStation)(station === s.value ? "all" : s.value)}
              >
                {s.label} <span className="tcat__scount">{s.count}</span>
              </button>
            ))}
          </div>
          <label className="tcat__toggle">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => filter(setShowRetired)(e.target.checked)}
            />
            Show retired
          </label>
          <span className="tcat__count">
            {rows.length} of {tests.length}
          </span>
        </div>

        {isLoading ? (
          <div className="tcat__empty">Loading the catalogue…</div>
        ) : !rows.length ? (
          <div className="tcat__empty">Nothing matches.</div>
        ) : (
          <>
            <div className="fset__scroll tcat__scroll">
              <table className="flow-table tcat__table">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th>Station</th>
                    <th>Price</th>
                    <th>What it is for</th>
                    <th>Where it came from</th>
                    <th className="bill-items__actions-head">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((t) => (
                    <tr key={t.id} className={t.isActive ? "" : "tcat__retired"}>
                      <td data-label="Test">
                        <strong>{t.name}</strong>
                        {t.isActive ? null : <span className="bill-tree__badge">Retired</span>}
                      </td>
                      <td data-label="Station">
                        <StationCell
                          test={t}
                          saving={update.isPending}
                          onSave={(category) => save(t, { category })}
                        />
                      </td>
                      <td data-label="Price">
                        <PriceCell test={t} />
                      </td>
                      <td data-label="What it is for">
                        <input
                          className="jb-assign tcat__gloss"
                          defaultValue={t.gloss || ""}
                          maxLength={160}
                          placeholder="Why a doctor orders it"
                          onBlur={(e) => {
                            const gloss = e.target.value.trim();
                            if (gloss !== (t.gloss || "")) save(t, { gloss });
                          }}
                        />
                      </td>
                      <td data-label="Where it came from" className="tcat__src">
                        {SOURCE_LABEL(t.source)}
                      </td>
                      <td data-label="" className="bill-items__actions">
                        <button
                          type="button"
                          className="flow-btn flow-btn-ghost flow-btn-mini tcat__retire"
                          disabled={update.isPending}
                          onClick={() => save(t, { isActive: !t.isActive })}
                        >
                          {t.isActive ? (
                            <Archive size={14} aria-hidden="true" />
                          ) : (
                            <ArchiveRestore size={14} aria-hidden="true" />
                          )}
                          {t.isActive ? "Retire" : "Restore"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={current}
              pageSize={pageSize}
              total={rows.length}
              onChange={setPage}
              onPageSizeChange={setPageSize}
              unit="tests"
            />
          </>
        )}
      </div>
      {adding ? (
        <AddTestDialog busy={addTest.isPending} onAdd={add} onClose={() => setAdding(false)} />
      ) : null}
    </div>
  );
}
