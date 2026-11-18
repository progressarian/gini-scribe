import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  FOLLOW_UP_UNITS,
  followUpDueDate,
  followUpIntervalLabel,
  intervalEndDate,
  isClosedDay,
  parseFollowUpInterval,
} from "../../../shared/followUp.js";
import FollowUpCalendar from "./FollowUpCalendar.jsx";
import useDismissOnOutside from "../../hooks/useDismissOnOutside.js";
import { followUpLoadQuery, useFollowUpLoad } from "../../queries/hooks/useFollowUpLoad.js";

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

const pad = (n) => String(n).padStart(2, "0");
const monthOf = (iso) => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1 });
const monthRange = ({ y, m }) => ({
  from: `${y}-${pad(m + 1)}-01`,
  to: `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`,
});
const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const nextDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

function intervalFor(from, date) {
  const days = daysBetween(from, date);
  if (days < 1) return "";
  if (days % 7 === 0 && days / 7 <= 50) return followUpIntervalLabel(days / 7, "weeks");
  return days <= 50 ? followUpIntervalLabel(days, "days") : "";
}

function dayState(count, limits) {
  const { allowedPerDay: allowed, maxPerDay: max } = limits || {};
  if (max && count >= max) return "full";
  if (allowed && count + 1 > allowed) return "over";
  return null;
}

export default function NextVisitPicker({
  fromDate,
  interval,
  date,
  disabled,
  onChange,
  required = false,
  visitId,
}) {
  const labelId = useId();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState(() => parseFollowUpInterval(interval));
  const [blocked, setBlocked] = useState(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const from = fromDate || todayIst();
  const today = todayIst();
  const [view, setView] = useState(() => monthOf(date || today));
  const calendarRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const firstBookable = nextDay(from > today ? from : today);

  useEffect(() => {
    const saved = parseFollowUpInterval(interval);
    if (saved.count && saved.unit) setPicked(saved);
  }, [interval]);

  useEffect(() => {
    if (date) setView(monthOf(date));
  }, [date]);

  const month = useFollowUpLoad({ ...monthRange(view), visitId, enabled: !disabled });
  const chosen = useFollowUpLoad({ from: date, to: date, visitId, enabled: !disabled && !!date });
  const limits = month.data?.limits || chosen.data?.limits;

  const closeCalendar = useCallback((returnFocus) => {
    setCalendarOpen(false);
    if (returnFocus === true) triggerRef.current?.focus();
  }, []);

  useDismissOnOutside([calendarRef, popoverRef], closeCalendar, calendarOpen);

  const toggleCalendar = () => {
    if (!calendarOpen) setView(monthOf(date && date >= firstBookable ? date : firstBookable));
    setCalendarOpen((open) => !open);
  };

  const bookedOn = async (day) => {
    try {
      const load = await queryClient.fetchQuery(followUpLoadQuery({ from: day, to: day, visitId }));
      return { count: load.days[day] || 0, limits: load.limits };
    } catch {
      return { count: 0, limits: {} };
    }
  };

  const send = async (next) => {
    if (next.date) {
      const { count, limits: current } = await bookedOn(next.date);
      if (next.date !== date && dayState(count, current) === "full") {
        setBlocked({ date: next.date, count, max: current.maxPerDay });
        return;
      }
    }
    setBlocked(null);
    onChange(next);
  };

  const pick = (next) => {
    setPicked(next);
    const label = followUpIntervalLabel(next.count, next.unit);
    if (!label && !interval && !date) return;
    send({ interval: label, date: label ? followUpDueDate(from, label) : "" });
  };

  const pickDay = (day) => {
    closeCalendar(true);
    const label = intervalFor(from, day);
    setPicked(label ? parseFollowUpInterval(label) : { count: "", unit: "" });
    send({ interval: label, date: day });
  };

  const clear = () => {
    setPicked({ count: "", unit: "" });
    setBlocked(null);
    if (interval || date) onChange({ interval: "", date: "" });
  };
  const hasValue = !!(date || interval || picked.count || picked.unit);

  const end = intervalEndDate(from, interval);
  const movedOffSunday = !!date && isClosedDay(end) && date !== end;

  const missing = required && !date;
  const farOff = !!date && date > followUpDueDate(from, "3 months");
  const dateCount = date ? chosen.data?.days?.[date] : undefined;
  const overAllowed =
    !!date &&
    dateCount !== undefined &&
    !!limits?.allowedPerDay &&
    dateCount + 1 > limits.allowedPerDay;

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
            {date && dateCount !== undefined && (
              <em> · {plural(dateCount, "other follow-up")} booked</em>
            )}
          </output>
          {!disabled && (
            <div className="cp-next-cal" ref={calendarRef}>
              <button
                type="button"
                ref={triggerRef}
                className="btn-sm cp-next-calbtn"
                aria-expanded={calendarOpen}
                aria-haspopup="dialog"
                onClick={toggleCalendar}
              >
                Follow-ups by date
              </button>
              {calendarOpen && (
                <FollowUpCalendar
                  anchorRef={triggerRef}
                  popoverRef={popoverRef}
                  value={date || ""}
                  minDate={firstBookable}
                  today={today}
                  view={view}
                  onViewChange={setView}
                  counts={month.data?.days}
                  limits={limits}
                  loading={month.isFetching && !month.data}
                  error={month.isError}
                  onRetry={() => month.refetch()}
                  onSelect={pickDay}
                  onClose={closeCalendar}
                />
              )}
            </div>
          )}
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
        {blocked && (
          <span className="cp-next-full" role="alert">
            {longDate(blocked.date)} is full ({plural(blocked.count, "follow-up")}, max{" "}
            {blocked.max} a day). Pick another date.
          </span>
        )}
        {overAllowed && (
          <span className="cp-next-over" role="alert">
            This date already has {plural(dateCount, "follow-up")} — the allowed number is{" "}
            {limits.allowedPerDay} a day. You can still book it.
          </span>
        )}
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
