import { deltaText, pct } from "./progressText.js";

function Card({ label, value, before, note, tone }) {
  const delta = before === undefined ? null : deltaText(value, before);
  return (
    <div className={`prg__card ${tone ? `prg__card--${tone}` : ""}`}>
      <span className="prg__card-n">{value ?? "—"}</span>
      <span className="prg__card-l">{label}</span>
      {delta && <span className="prg__card-d">{delta}</span>}
      {note && <span className="prg__card-d">{note}</span>}
    </div>
  );
}

function Section({ title, children }) {
  const id = `prg-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className="prg__section" aria-labelledby={id}>
      <h2 id={id} className="prg__h2">
        {title}
      </h2>
      <div className="prg__cards">{children}</div>
    </section>
  );
}

export default function ProgressCards({ cards, previous }) {
  const v = cards.visits;
  const pv = previous.visits;
  const r = cards.referrals;
  const pr = previous.referrals;
  const t = cards.tasks;
  const pt = previous.tasks;
  return (
    <>
      <Section title="Visits and coverage">
        <Card label="Visits" value={v.visits} before={pv.visits} />
        <Card label="Unique doctors" value={v.unique_doctors} before={pv.unique_doctors} />
        <Card
          label="Coverage"
          value={pct(v.coverage_pct)}
          note={`${v.covered} of ${v.assigned} assigned doctors`}
        />
        <Card
          label="Doctor unavailable"
          value={v.doctor_unavailable}
          before={pv.doctor_unavailable}
        />
        <Card label="Follow-ups set" value={v.follow_ups} before={pv.follow_ups} />
        <Card
          label="Overdue doctors"
          value={v.overdue_now + v.never_visited_now}
          note={`As of now · ${v.never_visited_now} never visited`}
          tone={v.overdue_now + v.never_visited_now ? "warn" : null}
        />
      </Section>
      <Section title="Referrals">
        <Card label="Referrals logged" value={r.logged} before={pr.logged} />
        <Card label="Verified" value={r.verified} before={pr.verified} />
        <Card label="Claimed" value={r.claimed} before={pr.claimed} />
        <Card label="Reached consultation" value={r.reached} before={pr.reached} />
        <Card label="Lost" value={r.lost} before={pr.lost} />
        <Card
          label="Untouched"
          value={r.untouched_now}
          note="As of now · still at New"
          tone={r.untouched_now ? "warn" : null}
        />
      </Section>
      <Section title="Tasks">
        <Card label="Tasks completed" value={t.completed} before={pt.completed} />
        <Card label="Completed on time" value={t.on_time} before={pt.on_time} />
        <Card
          label="Tasks overdue"
          value={t.overdue_now}
          note="As of now"
          tone={t.overdue_now ? "warn" : null}
        />
      </Section>
    </>
  );
}
