import { useEffect, useId, useState } from "react";
import { Download } from "lucide-react";
import Shimmer from "../../components/Shimmer.jsx";
import Pagination from "../../components/ui/Pagination.jsx";
import { errorOf } from "../../components/billing/format";
import { saveBlob } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import {
  useHomeCollections,
  useHomeCollectionsExport,
} from "../../queries/hooks/useHomeCollections";
import { HOME_SITE_LABEL, istClock } from "../../../shared/homeCollection.js";

const SITE_OPTIONS = [
  { value: "", label: "All" },
  { value: "home", label: "🏠 Collected at home" },
  { value: "ghm", label: "🏥 Came to GHM" },
  { value: "pending", label: "Not collected yet" },
];
const SITE_TEXT = { ...HOME_SITE_LABEL, pending: "Not collected yet" };
const PAGE_SIZES = [25, 50, 100];
const SEARCH_DELAY_MS = 300;
const SORTABLE = [
  { key: "date", label: "Date", first: "desc" },
  { key: "patient", label: "Patient", first: "asc" },
  { key: "collected", label: "Collected at", first: "desc" },
];

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");
const dayLabel = (ymd) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

function SortHeader({ column, sort, onSort }) {
  const [key, dir] = sort.split("_");
  const on = key === column.key;
  const next = on ? (dir === "asc" ? "desc" : "asc") : column.first;
  return (
    <th scope="col" aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="ms-sort" onClick={() => onSort(`${column.key}_${next}`)}>
        {column.label}
        <span aria-hidden="true">{on ? (dir === "asc" ? " ▲" : " ▼") : ""}</span>
      </button>
    </th>
  );
}

export default function HomeCollectionsSection({ from, to }) {
  const titleId = useId();
  const searchId = useId();
  const siteId = useId();
  const collectorId = useId();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [site, setSite] = useState("");
  const [collector, setCollector] = useState("");
  const [sort, setSort] = useState("date_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => setPage(1), [from, to]);

  const filters = { from, to, site, collectorId: collector, q, sort, page, pageSize };
  const list = useHomeCollections(filters);
  const download = useHomeCollectionsExport();
  const data = list.data;
  const s = data?.summary;
  const filtered = !!(site || collector || q);
  const reset = () => {
    setText("");
    setQ("");
    setSite("");
    setCollector("");
    setPage(1);
  };

  const exportFile = () =>
    download.mutate(
      { from, to, site, collectorId: collector, q, sort },
      {
        onSuccess: (file) => {
          saveBlob(file);
          toast(`Downloaded ${file.fileName}`, "success");
        },
        onError: (e) => toast(errorOf(e, "Could not download the home collections"), "error"),
      },
    );

  return (
    <section className="flow-card bill-stack" aria-labelledby={titleId}>
      <div className="fset__cardhead">
        <h2 id={titleId} className="flow-sec-title">
          Home collections
        </h2>
        {data ? <span className="fset__count">{fmt(data.total)}</span> : null}
        {list.isFetching && data ? <span className="ms-muted">updating…</span> : null}
        <button
          type="button"
          className="flow-btn brep-export"
          onClick={exportFile}
          disabled={!data || download.isPending}
        >
          <Download size={14} aria-hidden="true" />
          {download.isPending ? "Preparing…" : "Download Excel"}
        </button>
      </div>
      <div className="fset__cardsub">
        Samples of patients booked for home collection, and where each was taken.
      </div>

      {s ? (
        <>
          <div className="ms-tiles hc-tiles" aria-label="Home collection totals">
            <div className="ms-tile ms-tile--main">
              <span className="ms-tile__val">{fmt(s.home)}</span>
              <span className="ms-tile__lbl">🏠 Collected at home</span>
            </div>
            <div className="ms-tile">
              <span className="ms-tile__val">{fmt(s.ghm)}</span>
              <span className="ms-tile__lbl">🏥 Came to GHM</span>
            </div>
            <div className="ms-tile">
              <span className="ms-tile__val">{fmt(s.pending)}</span>
              <span className="ms-tile__lbl">Not collected yet</span>
            </div>
          </div>
          {s.byCollector.length ? (
            <p className="ms-foot">
              At home by {s.byCollector.map((c) => `${c.name || "—"} ${fmt(c.count)}`).join(" · ")}
            </p>
          ) : null}
        </>
      ) : null}

      <div className="bill-form brep-filters ms-listbar">
        <div className="fset__field ms-search">
          <label htmlFor={searchId}>Search home collections</label>
          <input
            id={searchId}
            type="search"
            className="jb-assign"
            value={text}
            maxLength={100}
            placeholder="Search by patient name, UHID or phone"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="fset__field brep-field">
          <label htmlFor={siteId}>Site</label>
          <select
            id={siteId}
            className="jb-assign"
            value={site}
            onChange={(e) => {
              setSite(e.target.value);
              setPage(1);
            }}
          >
            {SITE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="fset__field brep-field">
          <label htmlFor={collectorId}>Collected by</label>
          <select
            id={collectorId}
            className="jb-assign"
            value={collector}
            onChange={(e) => {
              setCollector(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Anyone</option>
            {(s?.byCollector || [])
              .filter((c) => c.id)
              .map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name || `Staff ${c.id}`}
                </option>
              ))}
          </select>
        </div>
        {filtered ? (
          <button type="button" className="flow-btn flow-btn-mini" onClick={reset}>
            Reset filters
          </button>
        ) : null}
      </div>

      {list.isError ? (
        <div className="ms-state" role="alert">
          <p>{errorOf(list.error, "Couldn't load the home collections.")}</p>
          <button type="button" className="flow-btn" onClick={() => list.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <Shimmer type="table" count={4} />
      ) : !data.total ? (
        <div className="ms-state">
          <p className="ms-empty">
            {filtered
              ? `No home collections match these filters${q ? ` and the search “${q}”` : ""}.`
              : "No home-collection patients with tests in these dates."}
          </p>
          {filtered ? (
            <button type="button" className="flow-btn" onClick={reset}>
              Reset filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="fset__scroll fset__scroll--wide hc-scroll">
            <table className="flow-table brep-table hc-table">
              <thead>
                <tr>
                  <SortHeader column={SORTABLE[0]} sort={sort} onSort={setSort} />
                  <SortHeader column={SORTABLE[1]} sort={sort} onSort={setSort} />
                  <th scope="col">Tests</th>
                  <th scope="col">Site</th>
                  <th scope="col">Collected by</th>
                  <SortHeader column={SORTABLE[2]} sort={sort} onSort={setSort} />
                  <th scope="col">Lab status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.visitId}>
                    <td className="ms-nowrap" data-label="Date">
                      {dayLabel(r.date)}
                    </td>
                    <td data-label="Patient" className="hc-patient">
                      <div className="ms-patient">{r.name}</div>
                      <div className="ms-muted">{r.fileNo || "No UHID"}</div>
                    </td>
                    <td data-label="Tests">{r.tests.join(", ") || "—"}</td>
                    <td data-label="Site">
                      <span className={`ms-state-pill hc-site hc-site--${r.site}`}>
                        {SITE_TEXT[r.site] || r.site}
                      </span>
                    </td>
                    <td data-label="Collected by">{r.collectedBy || "—"}</td>
                    <td data-label="Collected at">{istClock(r.collectedAt) || "—"}</td>
                    <td data-label="Lab status">{r.labStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            onChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={PAGE_SIZES}
            disabled={list.isFetching}
            unit="patients"
          />
        </>
      )}
    </section>
  );
}
