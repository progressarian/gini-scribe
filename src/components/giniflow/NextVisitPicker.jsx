import { useEffect, useId, useState } from "react";
import {
  FOLLOW_UP_UNITS,
  followUpDueDate,
  followUpIntervalLabel,
  intervalEndDate,
  isClosedDay,
  parseFollowUpInterval,
} from "../../../shared/followUp.js";

const COUNTS = Array.from({ length: 50 }, (_, i) => String(i + 1));

const UNIT_LABEL = { days: "Days", weeks: "Weeks", months: "Months" };

const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export default function NextVisitPicker({
  fromDate,
  interval,
  date,
  disabled,
  onChange,
  required = false,
}) {
  const labelId = useId();
  const [picked, setPicked] = useState(() => parseFollowUpInterval(interval));
  const from = fromDate || todayIst();

  useEffect(() => {
    const saved = parseFollowUpInterval(interval);
    if (saved.count && saved.unit) setPicked(saved);
  }, [interval]);

  const pick = (next) => {
    setPicked(next);
    const label = followUpIntervalLabel(next.count, next.unit);
    if (!label && !interval && !date) return;
    onChange({ interval: label, date: label ? followUpDueDate(from, label) : "" });
  };

  const clear = () => {
    setPicked({ count: "", unit: "" });
    if (interval || date) onChange({ interval: "", date: "" });
  };
  const hasValue = !!(date || interval || picked.count || picked.unit);

  const end = intervalEndDate(from, interval);
  const movedOffSunday = !!date && isClosedDay(end) && date !== end;

  const missing = required && !date;
  const farOff = !!date && date > followUpDueDate(from, "3 months");

  return (
    <div className={`cp-row cp-next-box${missing ? " is-missing" : ""}`}>
      <div>
        <span className="cp-lab" id={labelId}>
          Next visit after
          {required && (
            <em className="cp-req" aria-hidden="true">
              {" "}
              *
            </em>
          )}
        </span>
        <div className="cp-next" role="group" aria-labelledby={labelId}>
          <select
            className="cp-inp"
            aria-label="Number"
            disabled={disabled}
            value={picked.count}
            onChange={(e) => pick({ ...picked, count: e.target.value })}
          >
            <option value="">—</option>
            {COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select
            className="cp-inp"
            aria-label="Days, weeks or months"
            disabled={disabled}
            value={picked.unit}
            onChange={(e) => pick({ ...picked, unit: e.target.value })}
          >
            <option value="">—</option>
            {FOLLOW_UP_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <span className="cp-lab">Next visit date</span>
        <div className="cp-next-val">
          <output className="cp-next-date" aria-live="polite">
            {date ? longDate(date) : "Not set"}
            {movedOffSunday && <em> · moved from Sunday</em>}
          </output>
          {!disabled && hasValue && (
            <button
              type="button"
              className="btn-sm"
              aria-label="Clear the next visit"
              onClick={clear}
            >
              Clear
            </button>
          )}
        </div>
        {farOff && (
          <span className="cp-next-far" role="alert">
            ⚠ More than 3 months away — check this follow-up is intended
          </span>
        )}
        {missing && (
          <span className="cp-next-need" role="note">
            Required — set the next visit before you finalize
          </span>
        )}
      </div>
    </div>
  );
}
