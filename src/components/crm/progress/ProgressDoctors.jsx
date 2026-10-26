import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import usePagedList from "../home/usePagedList.js";
import { ListBody, ListStatus, SearchField } from "../home/ListToolbar.jsx";
import ListPager from "../ListPager.jsx";
import { outcomeLabel } from "../visits/visitText.js";
import { shortDateTime } from "./progressText.js";

const STATES = [
  { key: "not_visited", label: "Not visited in this period" },
  { key: "visited", label: "Visited in this period" },
];

export default function ProgressDoctors({ params, showRep }) {
  const [state, setState] = useState("not_visited");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const scope = JSON.stringify(params);

  useEffect(() => setPage(1), [scope, state, q]);

  const { data, loading, err, retry } = usePagedList(
    "/api/crm/progress/doctors",
    { ...params, state, q: q || undefined, page },
    0,
    "Unable to load the doctor list.",
  );

  return (
    <section className="prg__section" aria-labelledby="prg-doctors">
      <h2 id="prg-doctors" className="prg__h2">
        Doctors
      </h2>
      <div className="rep__tabs" role="group" aria-label="Doctor list">
        {STATES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`rep__tab ${state === s.key ? "rep__tab--on" : ""}`}
            aria-pressed={state === s.key}
            onClick={() => setState(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="asg__filters">
        <SearchField
          value={q}
          onSearch={setQ}
          label="Search doctors"
          placeholder="Search by doctor name, area or mobile"
        />
      </div>
      <ListStatus
        data={data}
        loading={loading}
        err={err}
        retry={retry}
        noun="doctor"
        active={Boolean(q)}
        onClear={() => setQ("")}
      />
      <ListBody
        data={data}
        loading={loading}
        empty={
          state === "visited"
            ? "No doctors were visited in this period."
            : "Every assigned doctor was visited in this period."
        }
        filteredEmpty={`No doctors match “${q}”.`}
        active={Boolean(q)}
        onClear={() => setQ("")}
      >
        {data?.rows.map((d) => (
          <li key={d.doctor_id}>
            <Link to={`/crm/doctor/${d.doctor_id}`} className="rep__row rep__row--tap prg__doctor">
              <div className="rep__row-main">
                <strong>{d.full_name}</strong>
                <span className="rep__row-sub">
                  {[d.specialty, d.area, d.territory, d.priority !== "unclassified" && d.priority]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="rep__row-sub">
                  {state === "visited"
                    ? [
                        `${d.visits} visit${d.visits === 1 ? "" : "s"}`,
                        `last ${shortDateTime(d.last_visit_at)}`,
                        outcomeLabel(d.last_outcome),
                        showRep && d.rep,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : [
                        d.last_visit_at
                          ? `Last visit ${shortDateTime(d.last_visit_at)}`
                          : "Never visited",
                        showRep && `Owner ${d.rep}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </div>
              <span className="rep__chev" aria-hidden="true">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ListBody>
      <ListPager page={data?.page} pages={data?.pages} loading={loading} onPage={setPage} />
    </section>
  );
}
