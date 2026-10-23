import { useEffect, useMemo, useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import queryClient from "../../queries/client";
import { qk } from "../../queries/keys";
import ConfirmModal from "../ui/ConfirmModal";
import ReassignModal, { enrichAffected } from "./ReassignModal";
import BookingAvailability from "./BookingAvailability";
import useAuthStore from "../../stores/authStore";
import { SCHEDULED_ROLES } from "../../../shared/staffRoles";
import {
  APPLY_BATCH,
  CAP_MAX,
  MAX_BREAKS_PER_DAY,
  MAX_WINDOWS_PER_DAY,
  WEEKDAY_NAMES,
  dayPlan,
  formatTime,
  toClock,
  toMinutes,
  validateTemplate,
  weekdayOf,
} from "../../../shared/slotTemplates";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SLOT_LENGTHS = [5, 10, 15, 20, 25, 30, 40, 45, 60, 90, 120, 180, 240];
const DEFAULT_WINDOW = { start: "09:00", end: "17:00", slotMinutes: 30 };
const EMPTY = { partialLast: "drop", hours: [], breaks: [] };

const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const stamp = (ts) =>
  ts
    ? new Date(ts).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "";

const clockRange = (start, end) => `${formatTime(toMinutes(start))}–${formatTime(toMinutes(end))}`;

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const startShortcuts = (today) => {
  const weekday = weekdayOf(today);
  const [y, m] = today.split("-").map(Number);
  const firstNext = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return [
    ["Today", today],
    ["Next Monday", addDays(today, (8 - weekday) % 7 || 7)],
    ["1st of next month", firstNext],
  ];
};

const periodShortcuts = (today) => {
  const weekday = weekdayOf(today);
  const monday = addDays(today, (8 - weekday) % 7 || 7);
  const [y, m] = today.split("-").map(Number);
  const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  return [
    ["Next week only", monday, addDays(monday, 6)],
    ["Next month only", first, last],
  ];
};

const CAP_FIELDS = [
  ["capNew", "New"],
  ["capFollowup", "Follow-up"],
  ["capWalkin", "Walk-in"],
];

const capsText = (h) => {
  const parts = [
    h.capNew != null && `${h.capNew} new`,
    h.capFollowup != null && `${h.capFollowup} follow-up`,
    h.capWalkin != null && `${h.capWalkin} walk-in`,
  ].filter(Boolean);
  return parts.length ? ` · per slot ${parts.join(", ")}` : "";
};

const rulesOf = (v) => ({
  partialLast: v?.partialLast || "drop",
  hours: (v?.hours || []).map(
    ({ weekday, start, end, slotMinutes, capNew, capFollowup, capWalkin }) => ({
      weekday,
      start,
      end,
      slotMinutes,
      capNew: capNew ?? null,
      capFollowup: capFollowup ?? null,
      capWalkin: capWalkin ?? null,
    }),
  ),
  breaks: (v?.breaks || []).map(({ weekday, name, start, end }) => ({
    weekday,
    name,
    start,
    end,
  })),
});

const dayRuns = (days) => {
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    const pos = WEEK_ORDER.indexOf(d);
    if (last && WEEK_ORDER.indexOf(last.at(-1)) === pos - 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) =>
      r.length > 2
        ? `${WEEKDAY_NAMES[r[0]]}–${WEEKDAY_NAMES[r.at(-1)]}`
        : r.map((d) => WEEKDAY_NAMES[d]).join(", "),
    )
    .join(", ");
};

export const summarizeTemplate = (t) => {
  const byDay = new Map();
  for (const d of WEEK_ORDER) {
    const windows = t.hours
      .filter((h) => h.weekday === d)
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
      .map((h) => `${clockRange(h.start, h.end)} (${h.slotMinutes} min${capsText(h)})`)
      .join(", ");
    if (!windows) continue;
    if (!byDay.has(windows)) byDay.set(windows, []);
    byDay.get(windows).push(d);
  }
  const parts = [...byDay.entries()].map(([windows, days]) => `${dayRuns(days)} ${windows}`);
  for (const b of t.breaks)
    parts.push(
      `${b.name} ${clockRange(b.start, b.end)}${b.weekday == null ? "" : ` (${WEEKDAY_NAMES[b.weekday]})`}`,
    );
  return parts.join(" · ") || "Off every day";
};

const versionSummary = (v) =>
  v.clears ? "Schedule cleared — no slots" : summarizeTemplate(rulesOf(v));

const versionStatus = (v, currentId, today) => {
  if (v.status === "withdrawn") return { label: "Withdrawn", tone: "muted" };
  if (v.clears && v.effectiveFrom <= today) return { label: "Cleared", tone: "muted" };
  if (v.id === currentId) return { label: "In use", tone: "on" };
  if (v.effectiveFrom > today) return { label: "Starts later", tone: "later" };
  return { label: "Replaced", tone: "muted" };
};

function FieldErrors({ errors, id }) {
  if (!errors.length) return null;
  return (
    <ul className="docmgmt-fielderr" id={id}>
      {errors.map((e) => (
        <li key={e.field + e.message}>{e.message}</li>
      ))}
    </ul>
  );
}

export default function ScheduleEditor({
  doctorId,
  doctor,
  onChange,
  refresh,
  editSignal,
  bulk = false,
  onClose,
}) {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [previewDate, setPreviewDate] = useState("");
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [serverErrors, setServerErrors] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [withdrawing, setWithdrawing] = useState(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [clearFrom, setClearFrom] = useState(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [target, setTarget] = useState("one");
  const [picked, setPicked] = useState([]);
  const [many, setMany] = useState(null);
  const [confirmMany, setConfirmMany] = useState(false);
  const [progress, setProgress] = useState(null);
  const [manyResult, setManyResult] = useState(null);
  const [reassign, setReassign] = useState(null);
  const [editing, setEditing] = useState(bulk);
  const [copyFrom, setCopyFrom] = useState("");
  const [untilOn, setUntilOn] = useState(false);
  const [untilDate, setUntilDate] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const scheduled = useMemo(
    () =>
      (doctorsList || [])
        .filter((d) => SCHEDULED_ROLES.includes(d.role))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [doctorsList],
  );

  useEffect(() => {
    setData(null);
    setSaved(null);
    setShowHistory(false);
    setTarget(bulk ? "all" : "one");
    setPicked(bulk ? [] : [doctorId]);
    setMany(null);
    setManyResult(null);
    setEditing(bulk);
  }, [doctorId, bulk]);

  useEffect(() => {
    if (editSignal) setEditing(true);
  }, [editSignal]);

  useEffect(() => {
    setLoading(true);
    setLoadFailed(false);
    const source = bulk ? copyFrom : doctorId;
    const request = source
      ? api.get(`/api/doctors/${source}/slot-templates`)
      : Promise.resolve({ data: { today: istToday(), current_id: null, versions: [] } });
    request
      .then((r) => {
        const body = r.data;
        const current = body.versions.find((v) => v.id === body.current_id);
        setData(bulk ? { today: body.today, current_id: null, versions: [] } : body);
        setDraft(rulesOf(current));
        setEffectiveFrom(body.today);
        setPreviewDate(body.today);
        setCheck(null);
        setServerErrors([]);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, [doctorId, reload, bulk, copyFrom]);

  const current = data?.versions.find((v) => v.id === data.current_id) || null;
  const upcoming = (data?.versions || [])
    .filter((v) => v.status === "active" && v.effectiveFrom > data.today)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const errors = useMemo(() => validateTemplate(draft), [draft]);
  const allErrors = [...serverErrors, ...errors];
  const fieldErrors = (prefix) =>
    allErrors.filter((e) => e.field === prefix || e.field.startsWith(`${prefix}.`));
  const dirty = !!data && JSON.stringify(draft) !== JSON.stringify(rulesOf(current));
  const pastStart = effectiveFrom && data && effectiveFrom < data.today;
  const replacing =
    target === "one" && effectiveFrom
      ? upcoming.filter((v) => v.effectiveFrom >= effectiveFrom)
      : [];

  const resetResults = () => {
    setCheck(null);
    setSaved(null);
    setMany(null);
    setManyResult(null);
  };

  const edit = (fn) => {
    setDraft((d) => fn(structuredClone(d)));
    resetResults();
    setServerErrors([]);
  };

  const setHour = (index, patch) =>
    edit((d) => {
      Object.assign(d.hours[index], patch);
      return d;
    });
  const setBreak = (index, patch) =>
    edit((d) => {
      Object.assign(d.breaks[index], patch);
      return d;
    });

  const toggleDay = (weekday) =>
    edit((d) => {
      if (d.hours.some((h) => h.weekday === weekday)) {
        d.hours = d.hours.filter((h) => h.weekday !== weekday);
        return d;
      }
      const model = WEEK_ORDER.map((w) => d.hours.filter((h) => h.weekday === w)).find(
        (list) => list.length,
      ) || [DEFAULT_WINDOW];
      d.hours.push(...model.map((h) => ({ ...h, weekday })));
      return d;
    });

  const addWindow = (weekday) =>
    edit((d) => {
      const last = d.hours
        .filter((h) => h.weekday === weekday)
        .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
        .at(-1);
      const start = last ? last.end : DEFAULT_WINDOW.start;
      const end = toClock((toMinutes(start) + 180) % 1440);
      d.hours.push({ weekday, start, end, slotMinutes: last?.slotMinutes || 30 });
      return d;
    });

  const removeWindow = (index) =>
    edit((d) => {
      d.hours.splice(index, 1);
      return d;
    });

  const firstWorkingDay = WEEK_ORDER.find((w) => draft.hours.some((h) => h.weekday === w));
  const copyTargets = WEEK_ORDER.filter(
    (w) => w !== firstWorkingDay && (w !== 0 || draft.hours.some((h) => h.weekday === 0)),
  );
  const copyFirstDay = () => {
    edit((d) => {
      const model = d.hours.filter((h) => h.weekday === firstWorkingDay);
      d.hours = [firstWorkingDay, ...copyTargets].flatMap((w) =>
        model.map((h) => ({ ...h, weekday: w })),
      );
      return d;
    });
    toast(`${WEEKDAY_NAMES[firstWorkingDay]}'s hours copied to ${dayRuns(copyTargets)}`, "success");
  };

  const addBreak = () =>
    edit((d) => {
      d.breaks.push({ weekday: null, name: "", start: "13:00", end: "14:00" });
      return d;
    });
  const removeBreak = (index) =>
    edit((d) => {
      d.breaks.splice(index, 1);
      return d;
    });

  const previewDates = useMemo(
    () =>
      effectiveFrom && !pastStart
        ? Array.from({ length: 7 }, (_, i) => addDays(effectiveFrom, i))
        : [],
    [effectiveFrom, pastStart],
  );
  const shownDate = previewDates.includes(previewDate) ? previewDate : previewDates[0];
  const plan = shownDate && !errors.length ? dayPlan(draft, shownDate) : null;
  const previewItems = plan
    ? [
        ...plan.slots.map((s) => ({ key: `s${s.startMin}`, at: s.startMin, label: s.label })),
        ...plan.breaks.map((b) => ({
          key: `b${b.startMin}`,
          at: b.startMin,
          label: clockRange(b.start, b.end),
          name: b.name,
        })),
      ].sort((a, b) => a.at - b.at)
    : [];

  const until = bulk && untilOn ? untilDate : null;
  const payload = () => ({
    effective_from: effectiveFrom,
    template: draft,
    ...(until ? { effective_until: until } : {}),
  });

  const failed = (e, fallback) => {
    const body = e.response?.data;
    if (body?.errors?.length) setServerErrors(body.errors);
    toast(body?.error || fallback, "error");
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await api.post(`/api/doctors/${doctorId}/slot-templates/check`, payload());
      setCheck(r.data);
    } catch (e) {
      failed(e, "Could not check bookings. Try again.");
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post(`/api/doctors/${doctorId}/slot-templates`, payload());
      toast(
        r.data.replaced
          ? `Schedule saved. It replaced ${r.data.replaced} later change${r.data.replaced === 1 ? "" : "s"}.`
          : "Schedule saved",
        "success",
      );
      queryClient.invalidateQueries({ queryKey: qk.ghm.any.availability });
      setReload((n) => n + 1);
      onChange?.();
      setSaved({ ...r.data, effectiveFrom });
      setEditing(false);
    } catch (e) {
      failed(e, "Could not save the schedule. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const targetBody = () =>
    target === "all" ? { all: true } : { doctor_ids: target === "one" ? [doctorId] : picked };

  const checkMany = async () => {
    setChecking(true);
    try {
      const r = await api.post(`/api/doctor-slot-templates/apply`, {
        ...payload(),
        ...targetBody(),
        dry_run: true,
      });
      setMany(r.data.doctors);
      return r.data.doctors;
    } catch (e) {
      failed(e, "Could not check bookings. Try again.");
      return null;
    } finally {
      setChecking(false);
    }
  };

  const askSaveMany = async () => {
    const list = many && !manyResult ? many : await checkMany();
    setManyResult(null);
    if (list) setConfirmMany(true);
  };

  const saveMany = async () => {
    setConfirmMany(false);
    const ids = many.filter((d) => !d.unchanged).map((d) => d.doctor_id);
    const result = {
      saved: [],
      skipped: many.filter((d) => d.unchanged).map((d) => d.doctor_id),
      failed: null,
    };
    setProgress({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i += APPLY_BATCH) {
        const r = await api.post(`/api/doctor-slot-templates/apply`, {
          ...payload(),
          doctor_ids: ids.slice(i, i + APPLY_BATCH),
          dry_run: false,
        });
        result.saved.push(...r.data.saved);
        result.skipped.push(...r.data.skipped);
        setProgress({ done: Math.min(i + APPLY_BATCH, ids.length), total: ids.length });
        if (r.data.failed) {
          result.failed = r.data.failed;
          break;
        }
      }
    } catch (e) {
      result.failed = { error: e.response?.data?.error || "The save stopped. Try again." };
    } finally {
      setProgress(null);
    }
    setManyResult({ ...result, effectiveFrom, until });
    if (result.saved.length && !bulk) setEditing(false);
    if (result.saved.length) {
      toast(
        `Schedule saved for ${result.saved.length} doctor${result.saved.length === 1 ? "" : "s"}`,
        "success",
      );
      queryClient.invalidateQueries({ queryKey: qk.ghm.any.availability });
      if (result.saved.includes(doctorId)) setReload((n) => n + 1);
      onChange?.();
    }
    if (result.failed) toast("The save stopped before every doctor was done", "error");
  };

  const openReassign = async (doc, affected) => {
    const rows = affected.filter((a) => !a.healthray);
    const enriched = await enrichAffected(rows, doc.id, doc);
    setReassign({ affected: enriched, doctor: doc });
  };

  const startEditing = () => {
    resetResults();
    setEditing(true);
  };

  const stopEditing = () => {
    if (bulk) return onClose?.();
    setReload((n) => n + 1);
    setCheck(null);
    setMany(null);
    setEditing(false);
  };

  const withdraw = async () => {
    setWithdrawBusy(true);
    try {
      await api.post(`/api/doctors/${doctorId}/slot-templates/${withdrawing.id}/withdraw`);
      toast("Upcoming schedule withdrawn", "success");
      queryClient.invalidateQueries({ queryKey: qk.ghm.any.availability });
      setWithdrawing(null);
      setReload((n) => n + 1);
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not withdraw the schedule. Try again.", "error");
    } finally {
      setWithdrawBusy(false);
    }
  };

  const clearSchedule = async () => {
    setClearBusy(true);
    try {
      await api.post(`/api/doctors/${doctorId}/slot-templates/clear`, {
        effective_from: clearFrom,
      });
      toast(`Schedule cleared from ${shortDate(clearFrom)}`, "success");
      queryClient.invalidateQueries({ queryKey: qk.ghm.any.availability });
      setClearFrom(null);
      setReload((n) => n + 1);
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not clear the schedule. Try again.", "error");
    } finally {
      setClearBusy(false);
    }
  };

  if (loading && !data) return <p className="docmgmt-empty">Loading…</p>;

  if (loadFailed)
    return (
      <div className="docmgmt-empty" role="alert">
        <p>
          Could not load {doctor?.name || "this person"}'s schedule, so it can't be edited right
          now. Try again; if it keeps failing, contact an administrator.
        </p>
        <button type="button" className="docmgmt-secondary" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      </div>
    );

  const untilBad = bulk && untilOn && (!untilDate || untilDate < effectiveFrom);
  const conflicts = (many || []).filter((d) => d.conflict && !d.unchanged);
  const affectedCount = check?.affected.length || 0;
  const manyCount = target === "all" ? scheduled.length : picked.length;
  const blocked =
    !!allErrors.length ||
    pastStart ||
    !effectiveFrom ||
    untilBad ||
    (target === "some" && !picked.length);
  const busy = saving || checking || !!progress;
  const byId = new Map(scheduled.map((d) => [d.id, d]));
  const savedFor = new Set(manyResult?.saved || []);
  const toMove = (many || []).filter(
    (d) => savedFor.has(d.doctor_id) && d.affected.some((a) => !a.healthray),
  );

  const manyResultBlock = manyResult && (
    <div className={`docmgmt-note${manyResult.failed ? " warn" : ""}`} role="status">
      <p>
        Saved for <strong>{manyResult.saved.length}</strong> doctor
        {manyResult.saved.length === 1 ? "" : "s"} from{" "}
        <strong>{longDate(manyResult.effectiveFrom)}</strong>
        {manyResult.until && (
          <>
            {" "}
            until <strong>{longDate(manyResult.until)}</strong>, then each goes back to their usual
            schedule
          </>
        )}
        {manyResult.skipped.length
          ? `; ${manyResult.skipped.length} already had this schedule`
          : ""}
        .
      </p>
      {manyResult.failed && (
        <p>
          Stopped
          {manyResult.failed.doctor_name ? ` at ${manyResult.failed.doctor_name}` : ""}:{" "}
          {manyResult.failed.error} Saving again continues with the doctors not done yet.
        </p>
      )}
      {toMove.length > 0 && (
        <ul className="docmgmt-movelist">
          {toMove.map((d) => {
            const n = d.affected.filter((a) => !a.healthray).length;
            return (
              <li key={d.doctor_id}>
                {d.doctor_name}: {n} Scribe booking{n === 1 ? "" : "s"} outside the new schedule{" "}
                <button
                  type="button"
                  className="docmgmt-secondary docmgmt-small"
                  onClick={() =>
                    openReassign(
                      byId.get(d.doctor_id) || { id: d.doctor_id, name: d.doctor_name },
                      d.affected,
                    )
                  }
                >
                  Move patients
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div className="docmgmt-schedule">
      {!editing && !bulk && (
        <>
          <div className="docmgmt-sectionhead">
            <div>
              <h3 className="docmgmt-subhead first">Weekly schedule</h3>
              <p className="docmgmt-hint">
                {current
                  ? `In use since ${shortDate(current.effectiveFrom)}`
                  : data.cleared_from
                    ? `Cleared since ${shortDate(data.cleared_from)} — booking treats this doctor as available all day.`
                    : "No schedule saved yet — booking treats this doctor as available all day."}
              </p>
            </div>
            <div className="docmgmt-rowactions">
              {(current || upcoming.some((v) => !v.clears)) && (
                <button
                  type="button"
                  className="docmgmt-secondary"
                  onClick={() => setClearFrom(data.today)}
                >
                  Clear schedule
                </button>
              )}
              <button type="button" className="docmgmt-primary" onClick={startEditing}>
                Edit schedule
              </button>
            </div>
          </div>
          {manyResultBlock}
          {saved && (
            <div className="docmgmt-note" role="status">
              <p>
                Saved. Booking follows this schedule from{" "}
                <strong>{longDate(saved.effectiveFrom)}</strong>.
              </p>
              {saved.affected.length > 0 && (
                <BookingImpact result={saved} effectiveFrom={saved.effectiveFrom} bare />
              )}
              {saved.affected.some((a) => !a.healthray) && (
                <button
                  type="button"
                  className="docmgmt-secondary docmgmt-small"
                  onClick={() => openReassign(doctor, saved.affected)}
                >
                  Move Scribe patients to another doctor
                </button>
              )}
            </div>
          )}

          {current && <ScheduleSummary template={rulesOf(current)} />}
          {upcoming.map((v) => (
            <p key={v.id} className="docmgmt-note" role="status">
              {v.clears ? (
                <>
                  The schedule is cleared from <strong>{longDate(v.effectiveFrom)}</strong>.{" "}
                </>
              ) : (
                <>
                  A new schedule starts on <strong>{longDate(v.effectiveFrom)}</strong>:{" "}
                  {summarizeTemplate(rulesOf(v))}.{" "}
                </>
              )}
              <button type="button" className="docmgmt-linkbtn" onClick={() => setWithdrawing(v)}>
                Withdraw it
              </button>
            </p>
          ))}
          <button
            type="button"
            className="docmgmt-linkbtn docmgmt-historytoggle"
            aria-expanded={showHistory}
            aria-controls="docmgmt-history"
            onClick={() => setShowHistory((s) => !s)}
          >
            {showHistory ? "Hide version history" : `Version history (${data.versions.length})`}
          </button>
          {showHistory && (
            <VersionHistory
              versions={data.versions}
              currentId={data.current_id}
              today={data.today}
              onWithdraw={setWithdrawing}
            />
          )}
          <BookingAvailability
            doctorId={doctorId}
            doctor={doctor}
            refresh={refresh}
            onChange={onChange}
          />
        </>
      )}
      {editing && (
        <>
          <div className="docmgmt-sectionhead">
            <div>
              <h3 className="docmgmt-subhead first">
                {bulk ? "Bulk schedule" : "Edit weekly schedule"}
              </h3>
              <p className="docmgmt-hint">
                {bulk
                  ? "Build one weekly schedule and save it for many consultants and MOs at once. "
                  : ""}
                Nothing changes until you save. Saving never moves or cancels booked patients.
              </p>
            </div>
            {bulk && (
              <label className="docmgmt-check docmgmt-copyfrom">
                Start from
                <select
                  value={copyFrom}
                  onChange={(e) => {
                    setCopyFrom(e.target.value);
                    resetResults();
                  }}
                >
                  <option value="">Empty (set hours yourself)</option>
                  {scheduled.map((d) => (
                    <option key={d.id} value={d.id}>
                      Copy from {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {bulk && manyResultBlock}
          <section className="docmgmt-step">
            <h3 className="docmgmt-steptitle">
              <span className="docmgmt-stepnum" aria-hidden="true">
                1
              </span>
              Working hours
            </h3>
            <p className="docmgmt-hint">
              Slots are cut from each block of hours at the chosen length. Hours ending at or before
              they start run overnight into the next day.
            </p>
            <div className="docmgmt-week">
              {WEEK_ORDER.map((weekday) => {
                const rows = draft.hours
                  .map((h, index) => ({ ...h, index }))
                  .filter((h) => h.weekday === weekday)
                  .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
                const day = WEEKDAY_NAMES[weekday];
                const dayErrors = rows.flatMap((r) => fieldErrors(`hours.${r.index}`));
                return (
                  <div key={weekday} className="docmgmt-weekrow">
                    <label className="docmgmt-check docmgmt-weekday">
                      <input
                        type="checkbox"
                        checked={rows.length > 0}
                        onChange={() => toggleDay(weekday)}
                      />
                      {day}
                    </label>
                    <div className="docmgmt-windows">
                      {rows.length === 0 && <span className="docmgmt-hint">Off</span>}
                      {rows.map((h, i) => {
                        const overnight =
                          toMinutes(h.start) != null &&
                          toMinutes(h.end) != null &&
                          toMinutes(h.end) <= toMinutes(h.start);
                        const lengths = SLOT_LENGTHS.includes(h.slotMinutes)
                          ? SLOT_LENGTHS
                          : [...SLOT_LENGTHS, h.slotMinutes].sort((a, b) => a - b);
                        const name = `${day} hours ${i + 1}`;
                        return (
                          <div key={h.index} className="docmgmt-windowblock">
                            <div className="docmgmt-window">
                              <label>
                                <span className="docmgmt-visually-hidden">{name} from</span>
                                <input
                                  type="time"
                                  value={h.start}
                                  aria-invalid={
                                    fieldErrors(`hours.${h.index}.start`).length > 0 || undefined
                                  }
                                  onChange={(e) => setHour(h.index, { start: e.target.value })}
                                />
                              </label>
                              <span aria-hidden="true">–</span>
                              <label>
                                <span className="docmgmt-visually-hidden">{name} to</span>
                                <input
                                  type="time"
                                  value={h.end}
                                  aria-invalid={
                                    fieldErrors(`hours.${h.index}.end`).length > 0 || undefined
                                  }
                                  onChange={(e) => setHour(h.index, { end: e.target.value })}
                                />
                              </label>
                              <label>
                                <span className="docmgmt-visually-hidden">{name} slot length</span>
                                <select
                                  value={h.slotMinutes}
                                  onChange={(e) =>
                                    setHour(h.index, { slotMinutes: Number(e.target.value) })
                                  }
                                >
                                  {lengths.map((m) => (
                                    <option key={m} value={m}>
                                      {m < 60 || m % 60 ? `${m} min` : `${m / 60} h`} slots
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {overnight && <span className="docmgmt-hint">ends next day</span>}
                              <button
                                type="button"
                                className="docmgmt-iconbtn"
                                aria-label={`Remove ${day} ${clockRange(h.start, h.end)}`}
                                onClick={() => removeWindow(h.index)}
                              >
                                ✕
                              </button>
                            </div>
                            <fieldset className="docmgmt-caps">
                              <legend>Patients per slot</legend>
                              {CAP_FIELDS.map(([key, label]) => (
                                <label key={key}>
                                  {label}
                                  <input
                                    type="number"
                                    min="0"
                                    max={CAP_MAX}
                                    inputMode="numeric"
                                    placeholder="No limit"
                                    aria-label={`${name} ${label.toLowerCase()} per slot`}
                                    value={h[key] ?? ""}
                                    aria-invalid={
                                      fieldErrors(`hours.${h.index}.${key}`).length > 0 || undefined
                                    }
                                    onChange={(e) =>
                                      setHour(h.index, {
                                        [key]:
                                          e.target.value === "" ? null : Number(e.target.value),
                                      })
                                    }
                                  />
                                </label>
                              ))}
                            </fieldset>
                          </div>
                        );
                      })}
                      {rows.length > 0 && rows.length < MAX_WINDOWS_PER_DAY && (
                        <button
                          type="button"
                          className="docmgmt-linkbtn"
                          onClick={() => addWindow(weekday)}
                        >
                          + Add hours on {day}
                        </button>
                      )}
                      <FieldErrors errors={dayErrors} />
                    </div>
                  </div>
                );
              })}
            </div>
            {firstWorkingDay != null && copyTargets.length > 0 && (
              <button
                type="button"
                className="docmgmt-secondary docmgmt-small"
                onClick={copyFirstDay}
              >
                Copy {WEEKDAY_NAMES[firstWorkingDay]} to {dayRuns(copyTargets)}
              </button>
            )}
            <FieldErrors errors={fieldErrors("hours").filter((e) => e.field === "hours")} />
          </section>
          <section className="docmgmt-step">
            <h3 className="docmgmt-steptitle">
              <span className="docmgmt-stepnum" aria-hidden="true">
                2
              </span>
              Breaks
            </h3>
            <p className="docmgmt-hint">
              No slots are made during a break; slots start again when it ends.
            </p>
            {draft.breaks.length === 0 && <p className="docmgmt-empty">No breaks.</p>}
            <div className="docmgmt-breaks">
              {draft.breaks.map((b, index) => {
                const label = b.name.trim() || `Break ${index + 1}`;
                return (
                  <div key={index} className="docmgmt-breakrow">
                    <div className="docmgmt-window">
                      <label>
                        <span className="docmgmt-visually-hidden">Break {index + 1} name</span>
                        <input
                          type="text"
                          value={b.name}
                          placeholder="Name, e.g. Lunch"
                          maxLength={40}
                          aria-invalid={fieldErrors(`breaks.${index}.name`).length > 0 || undefined}
                          onChange={(e) => setBreak(index, { name: e.target.value })}
                        />
                      </label>
                      <label>
                        <span className="docmgmt-visually-hidden">{label} from</span>
                        <input
                          type="time"
                          value={b.start}
                          onChange={(e) => setBreak(index, { start: e.target.value })}
                        />
                      </label>
                      <span aria-hidden="true">–</span>
                      <label>
                        <span className="docmgmt-visually-hidden">{label} to</span>
                        <input
                          type="time"
                          value={b.end}
                          onChange={(e) => setBreak(index, { end: e.target.value })}
                        />
                      </label>
                      <label>
                        <span className="docmgmt-visually-hidden">{label} days</span>
                        <select
                          value={b.weekday == null ? "" : b.weekday}
                          onChange={(e) =>
                            setBreak(index, {
                              weekday: e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                        >
                          <option value="">Every working day</option>
                          {WEEK_ORDER.map((w) => (
                            <option key={w} value={w}>
                              {WEEKDAY_NAMES[w]} only
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="docmgmt-iconbtn"
                        aria-label={`Remove ${label}`}
                        onClick={() => removeBreak(index)}
                      >
                        ✕
                      </button>
                    </div>
                    <FieldErrors errors={fieldErrors(`breaks.${index}`)} />
                  </div>
                );
              })}
            </div>
            {draft.breaks.length < MAX_BREAKS_PER_DAY && (
              <button type="button" className="docmgmt-secondary docmgmt-small" onClick={addBreak}>
                + Add break
              </button>
            )}
            <FieldErrors errors={fieldErrors("breaks").filter((e) => e.field === "breaks")} />
          </section>
          <section className="docmgmt-step">
            <h3 className="docmgmt-steptitle">
              <span className="docmgmt-stepnum" aria-hidden="true">
                3
              </span>
              Start date and doctors
            </h3>
            <div className="docmgmt-form wrap docmgmt-schedule-top">
              <label>
                Applies from
                <input
                  type="date"
                  value={effectiveFrom}
                  min={data.today}
                  aria-invalid={pastStart || undefined}
                  onChange={(e) => {
                    setEffectiveFrom(e.target.value);
                    resetResults();
                  }}
                />
              </label>
              <div className="docmgmt-quickdates" role="group" aria-label="Quick start dates">
                {startShortcuts(data.today).map(([label, date]) => (
                  <button
                    key={label}
                    type="button"
                    className="docmgmt-secondary docmgmt-small"
                    aria-pressed={effectiveFrom === date}
                    onClick={() => {
                      setEffectiveFrom(date);
                      resetResults();
                    }}
                  >
                    {label}
                  </button>
                ))}
                {bulk &&
                  periodShortcuts(data.today).map(([label, from, to]) => (
                    <button
                      key={label}
                      type="button"
                      className="docmgmt-secondary docmgmt-small"
                      aria-pressed={untilOn && effectiveFrom === from && untilDate === to}
                      onClick={() => {
                        setEffectiveFrom(from);
                        setUntilOn(true);
                        setUntilDate(to);
                        resetResults();
                      }}
                    >
                      {label}
                    </button>
                  ))}
              </div>
              {bulk && (
                <fieldset className="docmgmt-radios">
                  <legend>Ends</legend>
                  <label>
                    <input
                      type="radio"
                      name="ends"
                      checked={!untilOn}
                      onChange={() => {
                        setUntilOn(false);
                        resetResults();
                      }}
                    />
                    No end date — keep going
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="ends"
                      checked={untilOn}
                      onChange={() => {
                        setUntilOn(true);
                        if (!untilDate) setUntilDate(addDays(effectiveFrom || data.today, 6));
                        resetResults();
                      }}
                    />
                    Until
                  </label>
                  <label>
                    <span className="docmgmt-visually-hidden">Last day of this schedule</span>
                    <input
                      type="date"
                      value={untilDate}
                      min={effectiveFrom || data.today}
                      disabled={!untilOn}
                      aria-invalid={untilBad || undefined}
                      onChange={(e) => {
                        setUntilDate(e.target.value);
                        resetResults();
                      }}
                    />
                  </label>
                </fieldset>
              )}
              <fieldset className="docmgmt-radios">
                <legend>If time is left over at the end</legend>
                <label>
                  <input
                    type="radio"
                    name="partial-last"
                    checked={draft.partialLast !== "short"}
                    onChange={() => edit((d) => ({ ...d, partialLast: "drop" }))}
                  />
                  Don't book it
                </label>
                <label>
                  <input
                    type="radio"
                    name="partial-last"
                    checked={draft.partialLast === "short"}
                    onChange={() => edit((d) => ({ ...d, partialLast: "short" }))}
                  />
                  Offer a shorter slot
                </label>
              </fieldset>
            </div>
            {pastStart && (
              <p className="docmgmt-fielderr" role="alert">
                A schedule can't start in the past. Pick today or a later date.
              </p>
            )}
            <FieldErrors errors={fieldErrors("effective_from")} />
            {untilBad && (
              <p className="docmgmt-fielderr" role="alert">
                Pick a last day on or after the start date.
              </p>
            )}
            {bulk && untilOn && !untilBad && (
              <p className="docmgmt-hint">
                From {longDate(addDays(untilDate, 1))} each doctor goes back to the schedule they
                had before.
              </p>
            )}
            {replacing.length > 0 && !pastStart && (
              <p className="docmgmt-note warn" role="status">
                Saving replaces {replacing.length === 1 ? "the later change" : "the later changes"}{" "}
                already planned from {shortDate(effectiveFrom)}:{" "}
                {replacing.map(replacedLabel).join(", ")}. This schedule applies to every day from{" "}
                {shortDate(effectiveFrom)} instead.
              </p>
            )}

            <h4 className="docmgmt-substep">Apply to</h4>
            <fieldset className="docmgmt-radios">
              <legend className="docmgmt-visually-hidden">Apply this schedule to</legend>
              {[
                ["one", `${doctor?.name || "This doctor"} only`],
                ["some", "Choose doctors"],
                ["all", `All consultants and MOs (${scheduled.length})`],
              ]
                .filter(([value]) => !bulk || value !== "one")
                .map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="apply-to"
                      checked={target === value}
                      onChange={() => {
                        setTarget(value);
                        resetResults();
                      }}
                    />
                    {label}
                  </label>
                ))}
            </fieldset>
            {target === "some" && (
              <fieldset className="docmgmt-slotmulti docmgmt-pickdocs">
                <legend className="docmgmt-visually-hidden">
                  Doctors to apply this schedule to
                </legend>
                {scheduled.map((d) => {
                  const on = picked.includes(d.id);
                  return (
                    <label key={d.id} className={on ? "on" : ""}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          setPicked((p) => (on ? p.filter((x) => x !== d.id) : [...p, d.id]));
                          resetResults();
                        }}
                      />
                      {d.name}
                    </label>
                  );
                })}
              </fieldset>
            )}
            {target === "some" && !picked.length && (
              <p className="docmgmt-fielderr">Choose at least one doctor.</p>
            )}
          </section>
          <section className="docmgmt-step">
            <div className="docmgmt-dayhead">
              <h3 className="docmgmt-steptitle">
                <span className="docmgmt-stepnum" aria-hidden="true">
                  4
                </span>
                Preview of the new slots
              </h3>
              {previewDates.length > 0 && (
                <label className="docmgmt-check">
                  <span className="docmgmt-visually-hidden">Schedule preview day</span>
                  <select value={shownDate} onChange={(e) => setPreviewDate(e.target.value)}>
                    {previewDates.map((d) => (
                      <option key={d} value={d}>
                        {longDate(d)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {!plan ? (
              <p className="docmgmt-empty">
                {errors.length
                  ? "Fix the problems above to see the slots."
                  : "Pick the date this schedule starts."}
              </p>
            ) : plan.off ? (
              <p className="docmgmt-empty">{WEEKDAY_NAMES[weekdayOf(shownDate)]} is a day off.</p>
            ) : (
              <>
                <p className="docmgmt-hint">
                  {plan.slots.length} slot{plan.slots.length === 1 ? "" : "s"}
                  {plan.breaks.length
                    ? ` · ${plan.breaks.map((b) => `${b.name} ${clockRange(b.start, b.end)}`).join(", ")} skipped`
                    : ""}
                </p>
                <div className="docmgmt-slots" aria-label="Slots on the preview day">
                  {previewItems.map((x) => (
                    <div key={x.key} className={`slotpill ${x.name ? "blocked" : "free"}`}>
                      <span>{x.label}</span>
                      {x.name && <small>{x.name}</small>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
          <section className="docmgmt-step">
            <h3 className="docmgmt-steptitle">
              <span className="docmgmt-stepnum" aria-hidden="true">
                5
              </span>
              Check existing bookings
            </h3>
            {!check && !many && !progress && (
              <p className="docmgmt-hint">
                Check bookings lists patients already booked who would fall outside the new
                schedule. You can save without checking; the list is shown after saving.
              </p>
            )}
            {check && target === "one" && (
              <BookingImpact result={check} effectiveFrom={effectiveFrom} />
            )}
            {many && target !== "one" && !manyResult && (
              <ManyImpact doctors={many} effectiveFrom={effectiveFrom} until={until} />
            )}
            {progress && (
              <p className="docmgmt-note" role="status">
                Saving… {progress.done} of {progress.total} doctors done.
              </p>
            )}
          </section>
          <div className="docmgmt-savebar" role="region" aria-label="Save schedule">
            <span className={allErrors.length ? "docmgmt-fielderr" : "docmgmt-hint"} role="status">
              {allErrors.length
                ? `Fix ${allErrors.length} problem${allErrors.length === 1 ? "" : "s"} before saving.`
                : dirty
                  ? "Unsaved schedule changes"
                  : "No changes yet"}
            </span>
            <button
              type="button"
              className="docmgmt-secondary"
              disabled={busy}
              onClick={dirty ? () => setConfirmDiscard(true) : stopEditing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="docmgmt-secondary"
              disabled={blocked || busy}
              onClick={target === "one" ? runCheck : checkMany}
            >
              {checking ? "Checking…" : "Check bookings"}
            </button>
            <button
              type="button"
              className="docmgmt-primary"
              disabled={blocked || busy}
              onClick={target === "one" ? save : askSaveMany}
            >
              {saving || progress
                ? "Saving…"
                : target !== "one"
                  ? `Save for ${manyCount} doctor${manyCount === 1 ? "" : "s"}`
                  : affectedCount
                    ? `Save — ${affectedCount} booked patient${affectedCount === 1 ? "" : "s"} ${affectedCount === 1 ? "falls" : "fall"} outside`
                    : "Save schedule"}
            </button>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmMany && !!many}
        title={`Save this schedule for ${many?.filter((d) => !d.unchanged).length || 0} doctors?`}
        variant="primary"
        message={
          many && (
            <>
              <p>
                Starts <strong>{longDate(effectiveFrom)}</strong>
                {until && (
                  <>
                    {" "}
                    and ends <strong>{longDate(until)}</strong>
                  </>
                )}
                : {summarizeTemplate(draft)}
              </p>
              {until && (
                <p>
                  From {longDate(addDays(until, 1))} each doctor goes back to the schedule they had
                  before.
                </p>
              )}
              {many.some((d) => !d.unchanged && d.replaces?.length) && (
                <p>
                  Later changes already planned in this period are replaced:{" "}
                  {many
                    .filter((d) => !d.unchanged && d.replaces?.length)
                    .map((d) => `${d.doctor_name} (${d.replaces.map(replacedLabel).join(", ")})`)
                    .join("; ")}
                  .
                </p>
              )}
              {conflicts.length > 0 && (
                <p className="docmgmt-fielderr">
                  {conflicts.length} doctor{conflicts.length === 1 ? " has" : "s have"} a problem —
                  untick them or fix it first:{" "}
                  {conflicts.map((d) => `${d.doctor_name}: ${d.conflict}`).join(" ")}
                </p>
              )}
              <p>
                {many
                  .filter((d) => !d.unchanged)
                  .map((d) => d.doctor_name)
                  .join(", ")}
              </p>
              {many.some((d) => d.unchanged) && (
                <p>
                  {many.filter((d) => d.unchanged).length} already have this schedule from that date
                  and are skipped.
                </p>
              )}
              <p>
                {many.reduce((n, d) => n + d.affected.length, 0)} booked patients fall outside it.
                Their bookings are not changed; you can move Scribe bookings after saving. Each
                doctor gets a new version you can withdraw before it starts.
              </p>
            </>
          )
        }
        confirmLabel="Save schedule"
        cancelLabel="Go back"
        confirmDisabled={!many?.some((d) => !d.unchanged) || conflicts.length > 0}
        onConfirm={saveMany}
        onCancel={() => setConfirmMany(false)}
      />

      {reassign && (
        <ReassignModal
          {...reassign}
          trigger="schedule_change"
          saved="The new schedule is already saved"
          onClose={() => setReassign(null)}
          onDone={() => {
            setReassign(null);
            toast("Reassignment complete", "success");
            onChange?.();
          }}
        />
      )}

      <ConfirmModal
        open={confirmDiscard}
        title="Discard your schedule changes?"
        message={<p>The schedule in use stays as it is.</p>}
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setConfirmDiscard(false);
          stopEditing();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />

      <ConfirmModal
        open={!!withdrawing}
        title={`Withdraw the schedule starting ${withdrawing ? shortDate(withdrawing.effectiveFrom) : ""}?`}
        message={
          withdrawing && (
            <>
              <p>
                {doctor?.name}: {versionSummary(withdrawing)}
              </p>
              <p>
                Booking keeps using the schedule in use before it. The withdrawn version stays in
                the history and can't be brought back, but you can save it again.
              </p>
            </>
          )
        }
        confirmLabel="Withdraw schedule"
        cancelLabel="Keep it"
        busy={withdrawBusy}
        onConfirm={withdraw}
        onCancel={() => !withdrawBusy && setWithdrawing(null)}
      />

      <ConfirmModal
        open={!!clearFrom}
        title={`Clear ${doctor?.name || "this doctor"}'s schedule?`}
        message={
          clearFrom && (
            <div className="docmgmt-confirmbody">
              <label className="docmgmt-reason">
                Clear from
                <input
                  type="date"
                  value={clearFrom}
                  min={data.today}
                  onChange={(e) => e.target.value && setClearFrom(e.target.value)}
                />
              </label>
              <p>
                From <strong>{longDate(clearFrom)}</strong>, {doctor?.name} has no slots. Booking
                treats them as available all day with no per-slot patient limits, as before
                schedules existed.
              </p>
              {upcoming.some((v) => !v.clears && v.effectiveFrom >= clearFrom) && (
                <p>
                  These later schedules are withdrawn too:{" "}
                  {upcoming
                    .filter((v) => !v.clears && v.effectiveFrom >= clearFrom)
                    .map((v) => shortDate(v.effectiveFrom))
                    .join(", ")}
                  .
                </p>
              )}
              <p>
                Days before {shortDate(clearFrom)} keep their schedule. Booked patients keep their
                bookings and time slots, and time off stays as it is. You can save a new schedule
                again at any time.
              </p>
            </div>
          )
        }
        confirmLabel={clearFrom ? `Clear from ${shortDate(clearFrom)}` : "Clear schedule"}
        cancelLabel="Keep schedule"
        confirmDisabled={!clearFrom || clearFrom < (data?.today || "")}
        busy={clearBusy}
        onConfirm={clearSchedule}
        onCancel={() => !clearBusy && setClearFrom(null)}
      />
    </div>
  );
}

function BookingImpact({ result, effectiveFrom, bare = false }) {
  const { affected, unreadable, until } = result;
  const range = until
    ? `from ${shortDate(effectiveFrom)} until ${shortDate(addDays(until, -1))}`
    : `from ${shortDate(effectiveFrom)}`;
  const body =
    affected.length === 0 ? (
      <p>No booked patients fall outside this schedule {range}.</p>
    ) : (
      <>
        <p>
          <strong>
            {affected.length} booked patient{affected.length === 1 ? "" : "s"}
          </strong>{" "}
          {affected.length === 1 ? "falls" : "fall"} outside this schedule {range}. Their bookings
          stay as they are — move them to another time or doctor.
          {affected.some((a) => a.healthray) &&
            " Patients booked in HealthRay must be moved in HealthRay too."}
        </p>
        <table className="docmgmt-list">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Time</th>
              <th scope="col">Patient</th>
              <th scope="col">Why</th>
              <th scope="col">Booked in</th>
            </tr>
          </thead>
          <tbody>
            {affected.map((a) => (
              <tr key={a.appointment_id}>
                <td>{shortDate(a.appointment_date)}</td>
                <td>{a.time_slot}</td>
                <td>
                  {a.patient_name}
                  {a.file_no && <small> · {a.file_no}</small>}
                </td>
                <td>{a.reason[0].toUpperCase() + a.reason.slice(1)}</td>
                <td>{a.healthray ? "HealthRay" : "Scribe"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  if (bare) return body;
  return (
    <div className={`docmgmt-note${affected.length ? " warn" : ""}`} role="status">
      {body}
      {unreadable > 0 && (
        <p className="docmgmt-hint">
          {unreadable} booking{unreadable === 1 ? " has" : "s have"} no readable time and{" "}
          {unreadable === 1 ? "was" : "were"} not checked.
        </p>
      )}
    </div>
  );
}

const replacedLabel = (v) =>
  v.clears
    ? `clear from ${shortDate(v.effectiveFrom)}`
    : `schedule from ${shortDate(v.effectiveFrom)}`;

function ManyImpact({ doctors, effectiveFrom, until }) {
  const outside = doctors.reduce((n, d) => n + d.affected.length, 0);
  return (
    <div className={`docmgmt-note${outside ? " warn" : ""}`} role="status">
      <p>
        From {shortDate(effectiveFrom)}
        {until ? ` until ${shortDate(until)}` : ""}: <strong>{outside}</strong> booked patient
        {outside === 1 ? "" : "s"} across {doctors.length} doctor{doctors.length === 1 ? "" : "s"}{" "}
        {outside === 1 ? "falls" : "fall"} outside this schedule. Bookings are not changed by
        saving.
      </p>
      <table className="docmgmt-list" aria-label="Bookings outside the schedule by doctor">
        <thead>
          <tr>
            <th scope="col">Doctor</th>
            <th scope="col">Outside the schedule</th>
            <th scope="col">Booked in HealthRay</th>
            <th scope="col">On save</th>
          </tr>
        </thead>
        <tbody>
          {doctors.map((d) => (
            <tr key={d.doctor_id}>
              <td>{d.doctor_name}</td>
              <td>{d.affected.length}</td>
              <td>{d.affected.filter((a) => a.healthray).length}</td>
              <td className={d.conflict && !d.unchanged ? "docmgmt-fielderr" : undefined}>
                {d.unchanged
                  ? "Already has it — skipped"
                  : d.conflict
                    ? d.conflict
                    : [
                        until
                          ? `New version, back to usual on ${shortDate(addDays(until, 1))}`
                          : "New version",
                        d.replaces?.length
                          ? `replaces ${d.replaces.map(replacedLabel).join(", ")}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join("; ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleSummary({ template }) {
  const working = WEEK_ORDER.filter((d) => template.hours.some((h) => h.weekday === d));
  const lengths = [...new Set(template.hours.map((h) => h.slotMinutes))].sort((a, b) => a - b);
  const lengthText = (m) => (m < 60 || m % 60 ? `${m} min` : `${m / 60} h`);
  return (
    <div className="docmgmt-summary">
      <dl className="docmgmt-facts">
        <div>
          <dt>Working days</dt>
          <dd>{working.length ? dayRuns(working) : "None"}</dd>
        </div>
        <div>
          <dt>Slot length</dt>
          <dd>{lengths.length ? lengths.map(lengthText).join(", ") : "—"}</dd>
        </div>
        <div>
          <dt>Breaks</dt>
          <dd>
            {template.breaks.length
              ? template.breaks
                  .map(
                    (b) =>
                      `${b.name} ${clockRange(b.start, b.end)}${b.weekday == null ? "" : ` (${WEEKDAY_NAMES[b.weekday]})`}`,
                  )
                  .join(", ")
              : "None"}
          </dd>
        </div>
      </dl>
      <table className="docmgmt-list docmgmt-weektable" aria-label="Working hours by day">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Hours</th>
          </tr>
        </thead>
        <tbody>
          {WEEK_ORDER.map((d) => {
            const windows = template.hours
              .filter((h) => h.weekday === d)
              .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
            return (
              <tr key={d} className={windows.length ? "" : "locked"}>
                <th scope="row">{WEEKDAY_NAMES[d]}</th>
                <td>
                  {windows.length
                    ? windows
                        .map(
                          (h) =>
                            `${clockRange(h.start, h.end)} · ${lengthText(h.slotMinutes)} slots${capsText(h)}`,
                        )
                        .join(", ")
                    : "Not working"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VersionHistory({ versions, currentId, today, onWithdraw }) {
  return (
    <table className="docmgmt-list" id="docmgmt-history" aria-label="Schedule version history">
      <thead>
        <tr>
          <th scope="col">Starts</th>
          <th scope="col">Status</th>
          <th scope="col">Schedule</th>
          <th scope="col">Saved</th>
          <th scope="col">
            <span className="docmgmt-visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => {
          const status = versionStatus(v, currentId, today);
          return (
            <tr key={v.id} className={status.tone === "muted" ? "locked" : ""}>
              <td>{shortDate(v.effectiveFrom)}</td>
              <td>
                <span className={`docmgmt-vstatus docmgmt-vstatus--${status.tone}`}>
                  {status.label}
                </span>
              </td>
              <td>
                {versionSummary(v)}
                {v.note && !v.clears && <small> · {v.note}</small>}
              </td>
              <td>
                {v.createdBy || "System"}
                <small> · {stamp(v.createdAt)}</small>
                {v.status === "withdrawn" && (
                  <small>
                    {" "}
                    · withdrawn{v.withdrawnBy ? ` by ${v.withdrawnBy}` : ""} {stamp(v.withdrawnAt)}
                  </small>
                )}
              </td>
              <td className="docmgmt-cell-action">
                {v.status === "active" && v.effectiveFrom > today && (
                  <button
                    type="button"
                    className="docmgmt-secondary docmgmt-small"
                    onClick={() => onWithdraw(v)}
                  >
                    Withdraw
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
