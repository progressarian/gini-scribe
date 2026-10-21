import usePagedList from "./usePagedList.js";
import DoctorRow from "./DoctorRow.jsx";
import ListPager from "../ListPager.jsx";
import { SearchField, FilterSelect, ListStatus, ListBody } from "./ListToolbar.jsx";
import { PRIORITY_OPTIONS, territoryOptions, hasFilters } from "./options.js";

const STATES = [
  { key: "", label: "All waiting", count: "all" },
  { key: "overdue", label: "Overdue", count: "overdue" },
  { key: "due", label: "Due", count: "due" },
  { key: "never_visited", label: "Never visited", count: "never_visited" },
];
const FILTER_KEYS = ["q", "priority", "territory"];

export default function DueList({ filters, onChange, refreshKey }) {
  const list = usePagedList(
    "/api/crm/home/due",
    filters,
    refreshKey,
    "Unable to load doctors to visit.",
  );
  const { data, loading } = list;
  const update = (patch) => onChange({ ...filters, ...patch, page: 1 });
  const clear = () => onChange({ state: filters.state, page: 1 });
  const active = hasFilters(filters, FILTER_KEYS);

  return (
    <section className="home__panel" aria-label="Doctors to visit">
      <div className="rep__chips" role="group" aria-label="Filter by visit status">
        {STATES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`rep__chip ${(filters.state || "") === s.key ? "rep__chip--on" : ""}`}
            aria-pressed={(filters.state || "") === s.key}
            onClick={() => update({ state: s.key })}
          >
            {s.label} <strong>{data?.counts?.[s.count] ?? "–"}</strong>
          </button>
        ))}
      </div>
      <div className="asg__filters">
        <SearchField
          value={filters.q}
          onSearch={(q) => update({ q })}
          label="Search doctors to visit"
          placeholder="Search by doctor name, specialty, area or mobile"
        />
        <FilterSelect
          label="Priority"
          value={filters.priority}
          onChange={(priority) => update({ priority })}
          allLabel="All priorities"
          options={PRIORITY_OPTIONS}
        />
        <FilterSelect
          label="Territory"
          value={filters.territory}
          onChange={(territory) => update({ territory })}
          allLabel="All territories"
          options={territoryOptions(data)}
        />
      </div>
      <ListStatus {...list} noun="doctor" active={active} onClear={clear} />
      <ListBody
        data={data}
        loading={loading}
        active={active}
        onClear={clear}
        empty="Nobody is due. Good."
        filteredEmpty="No doctors to visit match these filters."
      >
        {data?.rows.map((d) => (
          <DoctorRow key={d.doctor_id} d={d} showDue />
        ))}
      </ListBody>
      <ListPager
        page={data?.page}
        pages={data?.pages}
        loading={loading}
        onPage={(page) => onChange({ ...filters, page })}
      />
    </section>
  );
}
