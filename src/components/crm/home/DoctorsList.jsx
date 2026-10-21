import { useState } from "react";
import api from "../../../services/api.js";
import usePagedList from "./usePagedList.js";
import DoctorRow from "./DoctorRow.jsx";
import ListPager from "../ListPager.jsx";
import { SearchField, FilterSelect, ListStatus, ListBody } from "./ListToolbar.jsx";
import { PRIORITY_OPTIONS, DUE_OPTIONS, territoryOptions, hasFilters } from "./options.js";
import { DOCTOR_PRIORITIES } from "../../../../shared/crmVocab.js";
import { errorText } from "../import/importText.js";

const FILTER_KEYS = ["q", "territory", "priority", "due", "incomplete"];

export default function DoctorsList({ filters, onChange, refreshKey, onChanged }) {
  const list = usePagedList(
    "/api/crm/home/doctors",
    filters,
    refreshKey,
    "Unable to load your doctors.",
  );
  const { data, loading } = list;
  const [classifying, setClassifying] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null);
  const update = (patch) => {
    setBulkMsg(null);
    onChange({ ...filters, ...patch, page: 1 });
  };
  const clear = () => update({ q: "", territory: "", priority: "", due: "", incomplete: "" });
  const active = hasFilters(filters, FILTER_KEYS);

  const classifyTerritory = async (priority) => {
    setClassifying(true);
    setBulkMsg(null);
    try {
      const { data: r } = await api.post("/api/crm/doctors/priority", {
        territory: filters.territory,
        priority,
      });
      setBulkMsg(
        `${r.updated} doctor${r.updated === 1 ? "" : "s"} in ${filters.territory} set to ${priority}`,
      );
      onChanged();
    } catch (e) {
      setBulkMsg(errorText(e, "Unable to update the priority."));
    } finally {
      setClassifying(false);
    }
  };

  return (
    <section className="home__panel" aria-label="My doctors">
      <div className="asg__filters">
        <SearchField
          value={filters.q}
          onSearch={(q) => update({ q })}
          label="Search my doctors"
          placeholder="Search by doctor name, specialty, area, city or mobile"
        />
        <FilterSelect
          label="Territory"
          value={filters.territory}
          onChange={(territory) => update({ territory })}
          allLabel="All territories"
          options={territoryOptions(data)}
        />
        <FilterSelect
          label="Priority"
          value={filters.priority}
          onChange={(priority) => update({ priority })}
          allLabel="All priorities"
          options={PRIORITY_OPTIONS}
        />
        <FilterSelect
          label="Visit status"
          value={filters.due}
          onChange={(due) => update({ due })}
          allLabel="Any visit status"
          options={DUE_OPTIONS}
        />
        <button
          type="button"
          className={`rep__chip ${filters.incomplete ? "rep__chip--on" : ""}`}
          aria-pressed={!!filters.incomplete}
          onClick={() => update({ incomplete: filters.incomplete ? "" : "1" })}
        >
          Need details <strong>{data?.counts?.incomplete ?? "–"}</strong>
        </button>
      </div>

      {filters.territory && data?.counts?.territory != null && (
        <div className="rep__bulk">
          <span className="rep__hint">
            Set all {data.counts.territory} in {filters.territory} to
          </span>
          {DOCTOR_PRIORITIES.filter((p) => p.value !== "unclassified").map((p) => (
            <button
              key={p.value}
              type="button"
              className="rep__btn rep__btn--sm"
              disabled={classifying}
              onClick={() => classifyTerritory(p.value)}
            >
              {p.short}
            </button>
          ))}
          {bulkMsg && (
            <span className="rep__saved" role="status">
              {bulkMsg}
            </span>
          )}
        </div>
      )}

      <ListStatus {...list} noun="doctor" active={active} onClear={clear} />
      <ListBody
        data={data}
        loading={loading}
        active={active}
        onClear={clear}
        empty="No doctors assigned to you yet."
        filteredEmpty="No doctors match these filters."
      >
        {data?.rows.map((d) => (
          <DoctorRow key={d.doctor_id} d={d} />
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
