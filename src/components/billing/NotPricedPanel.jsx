import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  useAddBillingItemAlias,
  useBillingItems,
  useBillingNotPriced,
  useSetBillingItemActive,
} from "../../queries/hooks/useBillingMaster";
import useDebounced from "../../hooks/useDebounced";
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
    key: "reports",
    title: "Lab reports not in the catalogue",
    short: "need a catalogue test",
    about:
      "These can't be priced until the test is in the test catalogue. Where one looks like a test already there, add the name as an alias of that test instead of a second test that could be billed twice.",
    allClear: "Every lab report is in the catalogue.",
    rowsOf: (data) => data.reportsNotInCatalogue,
    find: (r, needle) => matches(needle, r.name, ...r.possibly_same_as),
  },
  {
    key: "ordered",
    title: "Ordered names with no price",
    short: "need linking to a service",
    about:
      "Names the floor ordered in the last 30 days that billing can't match to an active test service. Link each to the service it is billed as, or create the item.",
    allClear: "Every name ordered in the last 30 days has a price.",
    rowsOf: (data) => data.orderedNames ?? [],
    find: (r, needle) => matches(needle, r.test_name, r.suggestion?.code, r.suggestion?.name),
  },
];

const SERVICE_SEARCH_MIN = 2;

function LinkResults({ q, onLink, busy, label }) {
  const { data, isLoading, isError } = useBillingItems({
    q,
    kind: "test",
    active: "true",
    limit: 20,
  });
  if (isLoading) return <p className="flow-muted">Searching…</p>;
  if (isError) return <p className="flow-muted">Could not search the services.</p>;
  if (!data.items.length) return <p className="flow-muted">No active test service matches.</p>;
  return (
    <ul className="bill-aliases" aria-label={`Services for ${label}`}>
      {data.items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="flow-btn flow-btn-ghost flow-btn-mini"
            disabled={busy}
            onClick={() => onLink(item)}
          >
            Link to {item.code} — {item.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

function LinkToService({ row }) {
  const [q, setQ] = useState("");
  const settled = useDebounced(q.trim(), 250);
  const add = useAddBillingItemAlias();

  const link = async (item) => {
    try {
      await add.mutateAsync({ itemId: item.id ?? item.item_id, name: row.test_name });
      toast(`${row.test_name} is now billed as ${item.code}`, "success");
    } catch (e) {
      toast(errorOf(e), "error");
    }
  };

  return (
    <div className="bill-np-link" role="group" aria-label={`Link ${row.test_name} to a service`}>
      {row.suggestion ? (
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini"
          disabled={add.isPending}
          onClick={() => link(row.suggestion)}
        >
          Link to {row.suggestion.code} — {row.suggestion.name}
        </button>
      ) : null}
      <input
        type="search"
        className="jb-assign"
        aria-label={`Search services for ${row.test_name}`}
        placeholder="Search test services"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {settled.length >= SERVICE_SEARCH_MIN ? (
        <LinkResults q={settled} busy={add.isPending} onLink={link} label={row.test_name} />
      ) : null}
    </div>
  );
}

function OrderedRows({ rows }) {
  return (
    <table className="flow-table" aria-label="Ordered names with no price">
      <thead>
        <tr>
          <th>Ordered as</th>
          <th>Times ordered</th>
          <th>Last ordered</th>
          <th>Link to service</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.test_name}>
            <td data-label="Ordered as">{r.test_name}</td>
            <td data-label="Times ordered">{r.times_ordered}</td>
            <td data-label="Last ordered">{r.last_ordered}</td>
            <td data-label="Link to service">
              <LinkToService row={r} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

const ROWS = { tests: TestRows, reports: ReportRows, ordered: OrderedRows };

export default function NotPricedPanel({ onCreate }) {
  const { data, isLoading, isError } = useBillingNotPriced();
  const [params, setParams] = useSearchParams();
  const picked = params.get("list");
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
    setParams(
      (current) => {
        const kept = new URLSearchParams(current);
        kept.set("list", key);
        return kept;
      },
      { replace: true },
    );
    setQ("");
    setPage(1);
  };

  const feesMissing = data.consultants.length;

  return (
    <div className="bill-notpriced">
      {feesMissing ? (
        <p className="fset__cardsub bill-np-fees">
          <Link to="/settings/consultant-fees?view=not-priced">
            {feesMissing} doctor {feesMissing === 1 ? "fee" : "fees"} missing — set them on the
            Consultant fees page →
          </Link>
        </p>
      ) : null}
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
