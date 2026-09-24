import { useId, useState } from "react";
import { useBillingNotPriced, useSetBillingItemActive } from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import Pagination from "../ui/Pagination";
import { errorOf, rupees } from "./format";

const REPORT_STATUS = {
  not_in_catalogue: "Not in the test catalogue",
  retired_in_catalogue: "Retired in the test catalogue",
};

function Status({ tone, children }) {
  return <span className={`bill-status bill-status--${tone}`}>{children}</span>;
}

function RowAction({ row, label, onCreate }) {
  const activate = useSetBillingItemActive();
  if (row.status === "item_deactivated") {
    return (
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        aria-label={`Activate item ${row.item_code} for ${label}`}
        disabled={activate.isPending}
        onClick={async () => {
          try {
            await activate.mutateAsync({ id: row.item_id, is_active: true });
            toast(`Activated ${row.item_code}`, "success");
          } catch (e) {
            toast(errorOf(e), "error");
          }
        }}
      >
        Activate {row.item_code}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="flow-btn flow-btn-primary flow-btn-mini"
      aria-label={`Create item for ${label}`}
      onClick={onCreate}
    >
      Create item
    </button>
  );
}

const matches = (needle, ...values) =>
  !needle ||
  values.some((v) =>
    String(v ?? "")
      .toLowerCase()
      .includes(needle),
  );

const LISTS = [
  {
    key: "tests",
    title: "Tests without an item",
    short: "need a billing item",
    about: "Catalogue tests the floor can order but billing has no item for yet.",
    allClear: "Every catalogue test has an item.",
    rowsOf: (data) => data.tests,
    find: (t, needle) => matches(needle, t.test_name, t.category, t.item_code),
  },
  {
    key: "consultants",
    title: "Consultants without a fee",
    short: "need a consultation fee",
    about:
      "Consultants with no consultation item of their own for a visit type. Where the hospital default covers them, their visits are billed at the default fee meanwhile.",
    allClear: "Every consultant has a fee for each visit type.",
    rowsOf: (data) => data.consultants,
    find: (c, needle) => matches(needle, c.name, c.visit_type, c.item_code),
  },
  {
    key: "reports",
    title: "Lab reports not in the catalogue",
    short: "need a catalogue test",
    about:
      "These can't be priced until the test is in the test catalogue. Where one looks like a test already there, add the name as an alias of that test instead of a second test that could be billed twice.",
    allClear: "Every lab report is in the catalogue.",
    rowsOf: (data) => data.reportsNotInCatalogue,
    find: (r, needle) => matches(needle, r.name, ...r.possibly_same_as),
  },
];

function TestRows({ rows, onCreate }) {
  return (
    <table className="flow-table" aria-label="Tests without an item">
      <thead>
        <tr>
          <th>Test</th>
          <th>Category</th>
          <th>Catalogue price</th>
          <th>Status</th>
          <th className="bill-items__actions-head">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.test_catalog_id}>
            <td data-label="Test">{t.test_name}</td>
            <td data-label="Category">{t.category}</td>
            <td data-label="Catalogue price">
              {t.catalogue_price === null ? "—" : rupees(t.catalogue_price)}
            </td>
            <td data-label="Status">
              {t.status === "no_item" ? (
                <Status tone="todo">No item</Status>
              ) : (
                <Status tone="off">{t.item_code} is off</Status>
              )}
            </td>
            <td data-label="" className="bill-items__actions">
              <RowAction
                row={t}
                label={t.test_name}
                onCreate={() =>
                  onCreate({
                    name: t.test_name,
                    kind: "test",
                    test_catalog_id: t.test_catalog_id,
                    base_price: t.catalogue_price,
                  })
                }
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConsultantRows({ rows, onCreate }) {
  return (
    <table className="flow-table" aria-label="Consultants without a fee">
      <thead>
        <tr>
          <th>Consultant</th>
          <th>Visit type</th>
          <th>Billed meanwhile</th>
          <th>Status</th>
          <th className="bill-items__actions-head">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const label = `${c.name} (${c.visit_type})`;
          return (
            <tr key={`${c.doctor_id}-${c.visit_type}`}>
              <td data-label="Consultant">{c.name}</td>
              <td data-label="Visit type">{c.visit_type}</td>
              <td data-label="Billed meanwhile">
                {c.default_covers ? "Hospital default fee" : "Nothing — no fee"}
              </td>
              <td data-label="Status">
                {c.status === "no_item" ? (
                  <Status tone="todo">No item</Status>
                ) : (
                  <Status tone="off">{c.item_code} is off</Status>
                )}
              </td>
              <td data-label="" className="bill-items__actions">
                <RowAction
                  row={c}
                  label={label}
                  onCreate={() =>
                    onCreate({
                      name: `Consultation — ${c.name} (${c.visit_type})`,
                      kind: "consultation",
                      doctor_id: c.doctor_id,
                      visit_type: c.visit_type,
                    })
                  }
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ReportRows({ rows }) {
  return (
    <table className="flow-table" aria-label="Lab reports not in the catalogue">
      <thead>
        <tr>
          <th>Report</th>
          <th>Possibly the same as</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td data-label="Report">{r.name}</td>
            <td data-label="Possibly the same as">
              {r.possibly_same_as.length ? r.possibly_same_as.join(", ") : "—"}
            </td>
            <td data-label="Status">
              <Status tone={r.status === "retired_in_catalogue" ? "off" : "todo"}>
                {REPORT_STATUS[r.status] ?? r.status}
              </Status>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ROWS = { tests: TestRows, consultants: ConsultantRows, reports: ReportRows };

export default function NotPricedPanel({ onCreate }) {
  const { data, isLoading, isError } = useBillingNotPriced();
  const [picked, setPicked] = useState(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const id = useId();

  if (isLoading) return <div className="flow-card fset__cardsub">Loading…</div>;
  if (isError) return <div className="flow-card fset__cardsub">Could not load the list.</div>;

  const firstWithWork = LISTS.find((l) => l.rowsOf(data).length) ?? LISTS[0];
  const list = LISTS.find((l) => l.key === picked) ?? firstWithWork;
  const all = list.rowsOf(data);
  const needle = q.trim().toLowerCase();
  const found = all.filter((row) => list.find(row, needle));
  const lastPage = Math.max(1, Math.ceil(found.length / pageSize));
  const current = Math.min(page, lastPage);
  const rows = found.slice((current - 1) * pageSize, current * pageSize);
  const Rows = ROWS[list.key];

  const pick = (key) => {
    setPicked(key);
    setQ("");
    setPage(1);
  };

  return (
    <div className="bill-notpriced">
      <div className="bill-np-tiles" role="tablist" aria-label="Not priced lists">
        {LISTS.map((l) => {
          const count = l.rowsOf(data).length;
          const on = l.key === list.key;
          return (
            <button
              key={l.key}
              type="button"
              role="tab"
              id={`${id}-${l.key}-tab`}
              aria-selected={on}
              aria-controls={`${id}-panel`}
              className={`bill-np-tile bill-np-tile--${count ? "todo" : "done"}${on ? " bill-np-tile--on" : ""}`}
              onClick={() => pick(l.key)}
            >
              <span className="bill-np-tile__count">{count}</span>
              <span className="bill-np-tile__text">
                <span className="bill-np-tile__title">{l.title}</span>
                <span className="bill-np-tile__sub">{count ? l.short : "All done"}</span>
              </span>
            </button>
          );
        })}
      </div>

      <section
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${list.key}-tab`}
        className="flow-card bill-stack bill-np-panel"
      >
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">{list.title}</h2>
          <span className={`fset__count bill-count--${all.length ? "todo" : "done"}`}>
            {all.length}
          </span>
          {all.length ? (
            <input
              type="search"
              className="jb-assign bill-np-search"
              aria-label="Search this list"
              placeholder="Search this list"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          ) : null}
        </div>
        <div className="fset__cardsub">{list.about}</div>
        {!all.length ? (
          <div className="bill-allclear">{list.allClear}</div>
        ) : (
          <>
            {!found.length ? (
              <div className="fset__cardsub">Nothing in this list matches that search.</div>
            ) : (
              <div className="fset__scroll">
                <Rows rows={rows} onCreate={onCreate} />
              </div>
            )}
            <Pagination
              page={current}
              pageSize={pageSize}
              total={found.length}
              onChange={setPage}
              onPageSizeChange={setPageSize}
              unit="rows"
            />
          </>
        )}
      </section>
    </div>
  );
}
