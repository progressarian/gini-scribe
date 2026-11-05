import { Link } from "react-router-dom";
import { Change } from "../../billing/dashboard/KpiTiles";
import { count, rangeLabel, shareOf } from "../../billing/dashboard/dashboardText";
import { OPD_DEFINITIONS } from "../../../../shared/opdMetrics.js";
import { visitsHref } from "./opdFilters";

const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" });

function Tile({ label, value, hint, to, back, children }) {
  return (
    <Link
      className="bdash-tile opd-tile"
      to={to}
      state={{ back }}
      aria-label={`${label}: ${value}. Open the list`}
    >
      <span className="bdash-tile__label" title={hint}>
        {label}
      </span>
      <span className="bdash-tile__value">{value}</span>
      {children}
    </Link>
  );
}

function Against({ data, keyName }) {
  const now = data.totals[keyName];
  const was = data.previous[keyName];
  if (data.compare.kind === "same_weekday") {
    const name = WEEKDAY.format(new Date(`${data.compare.from}T00:00:00Z`));
    return (
      <span className="bdash-tile__change">
        Last {name}: {count(was)}
      </span>
    );
  }
  return (
    <Change
      current={now}
      previous={was}
      against={rangeLabel(data.compare.from, data.compare.to)}
      format={count}
    />
  );
}

function LengthTile({ times }) {
  const value = times?.enough && times.visitLength !== null ? `${times.visitLength} min` : "—";
  return (
    <a
      className="bdash-tile opd-tile"
      href="#opd-times"
      aria-label={`Typical visit length: ${value}. Go to time on the floor`}
    >
      <span className="bdash-tile__label" title={OPD_DEFINITIONS.visit_length}>
        Typical visit length
      </span>
      <span className="bdash-tile__value">{value}</span>
      {!times ? (
        <span className="bdash-tile__change">Working it out…</span>
      ) : times.enough ? (
        <>
          {times.dayOpen ? null : (
            <Change
              current={times.visitLength}
              previous={times.previous.visitLength}
              against={rangeLabel(times.compare.from, times.compare.to)}
              format={(minutes) => `${minutes} min`}
            />
          )}
          <span className="bdash-tile__change">
            {times.onTimePct === null ? "" : `On time ${times.onTimePct}% · `}
            timed {count(times.timed)} of {count(times.visits)}
          </span>
        </>
      ) : (
        <span className="bdash-tile__change">
          Too few visits tracked on the floor ({count(times.timed)})
        </span>
      )}
    </a>
  );
}

export default function OpdTiles({ data, times, filters, back }) {
  const t = data.totals;
  const to = (extra) => visitsHref(filters, extra);
  return (
    <section className="bdash-tiles" aria-label="Headline figures">
      <Tile
        back={back}
        label="Visits"
        value={count(t.came)}
        hint={OPD_DEFINITIONS.came}
        to={to({ state: "came" })}
      >
        <Against data={data} keyName="came" />
        <span className="bdash-tile__change" title={OPD_DEFINITIONS.unique_patients}>
          {count(t.uniquePatients)} unique {t.uniquePatients === 1 ? "patient" : "patients"}
        </span>
      </Tile>
      <Tile
        back={back}
        label="Completed"
        value={count(t.completed)}
        hint={OPD_DEFINITIONS.completed}
        to={to({ state: "completed" })}
      >
        <span className="bdash-tile__change">{shareOf(t.completed, t.came)} of visits</span>
        <span className="bdash-tile__change">
          {count(t.inProgress)} in progress · {count(t.notClosed)} not closed
        </span>
      </Tile>
      <Tile
        back={back}
        label="New patients"
        value={count(t.new)}
        to={to({ state: "came", type: "new" })}
      >
        <Against data={data} keyName="new" />
        <span className="bdash-tile__change">{shareOf(t.new, t.came)} of visits</span>
      </Tile>
      <Tile
        back={back}
        label="Follow-ups"
        value={count(t.followUp)}
        to={to({ state: "came", type: "follow_up" })}
      >
        <Against data={data} keyName="followUp" />
        <span className="bdash-tile__change" title={OPD_DEFINITIONS.repeat_patients}>
          {count(t.repeatPatients)} came more than once
        </span>
      </Tile>
      <Tile
        back={back}
        label="Did not come"
        value={count(t.didNotCome)}
        hint={OPD_DEFINITIONS.did_not_come}
        to={to({ state: "did_not_come" })}
      >
        <span className="bdash-tile__change">{shareOf(t.didNotCome, t.booked)} of booked</span>
        <span className="bdash-tile__change" title={OPD_DEFINITIONS.not_updated}>
          {count(t.notUpdated)} not updated in HealthRay
        </span>
      </Tile>
      {data.includesToday ? (
        <Tile
          back={back}
          label="Pending today"
          value={count(t.pending)}
          hint={OPD_DEFINITIONS.pending}
          to={to({ state: "pending" })}
        >
          <span className="bdash-tile__change">Booked for today, not arrived yet</span>
        </Tile>
      ) : null}
      <LengthTile times={times} />
    </section>
  );
}
