import { useId, useState } from "react";
import { istClock } from "../../../shared/homeCollection.js";
import { requestErrorOf } from "../billing/format";
import { useLabSite, useSetLabSite } from "../../queries/hooks/useLabSite";
import "./labSite.css";

const SITES = [
  { value: "ghm", label: "🏥 At GHM" },
  { value: "home", label: "🏠 Home collection" },
];
const labelOf = (site) => SITES.find((s) => s.value === site)?.label || site;

export default function LabSiteControl({ visitId, card = false, atCheckIn = false }) {
  const { data } = useLabSite(visitId);
  const save = useSetLabSite();
  const [asking, setAsking] = useState(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const uid = useId();

  if (!data?.today || !(data.applies || (atCheckIn && data.notArrived))) return null;

  const checkInOnly = atCheckIn && data.notArrived && !data.locked;
  const who = `${data.name}${data.fileNo ? ` (${data.fileNo})` : ""}`;
  const shown = asking ?? data.site;

  const confirm = async () => {
    setError("");
    try {
      await save.mutateAsync({ visitId, site: asking, atCheckIn: checkInOnly });
      setDone(`${data.name}: lab sample set to ${labelOf(asking)}`);
      setAsking(null);
    } catch (e) {
      setError(requestErrorOf(e, "Could not change the lab sample"));
    }
  };

  const Box = card ? "section" : "div";
  return (
    <Box
      className={card ? "bc-card lsite" : "lsite"}
      aria-label={card ? "Lab sample category" : undefined}
    >
      <fieldset className="lsite__set" disabled={!(data.editable || checkInOnly) || save.isPending}>
        <legend className="lsite__legend">Lab sample</legend>
        {SITES.map((s) => (
          <label key={s.value} className="lsite__opt">
            <input
              type="radio"
              name={`${uid}-site`}
              value={s.value}
              checked={shown === s.value}
              onChange={() => {
                setDone("");
                setError("");
                setAsking(s.value === data.site ? null : s.value);
              }}
            />
            {s.label}
          </label>
        ))}
        {data.setOnFloor && data.setBy && (
          <span className="lsite__meta">
            set by {data.setBy} {istClock(data.setAt)}
          </span>
        )}
      </fieldset>
      {data.locked && (
        <p className="lsite__note">Sample already collected — the category can't change</p>
      )}
      {asking && (
        <div className="lsite__ask" role="group" aria-label="Confirm lab sample">
          <span>
            Mark <strong>{who}</strong> as {labelOf(asking)} for today?
          </span>
          <button
            type="button"
            className="st-btn st-btn-grn"
            disabled={save.isPending}
            onClick={confirm}
          >
            {save.isPending ? "Saving…" : "Confirm"}
          </button>
          <button
            type="button"
            className="st-btn st-btn-g"
            disabled={save.isPending}
            onClick={() => setAsking(null)}
          >
            Back
          </button>
        </div>
      )}
      {error && (
        <p className="lsite__error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="lsite__done" role="status">
          {done}
        </p>
      )}
    </Box>
  );
}
