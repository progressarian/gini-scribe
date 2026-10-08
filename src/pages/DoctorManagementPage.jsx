import { useEffect, useMemo, useState, useCallback } from "react";
import api from "../services/api";
import useAuthStore from "../stores/authStore";
import { toast } from "../stores/uiStore";
import DeleteDoctorModal from "../components/doctors/DeleteDoctorModal";
import { VITALS_REST_MINUTES } from "../../shared/giniflowStatus";
import "./DoctorManagementPage.css";

const todayISO = () => new Date().toISOString().split("T")[0];

const TABS = [
  { id: "schedule", label: "Schedule" },
  { id: "timeoff", label: "Time off" },
  { id: "settings", label: "Settings" },
];

const ROLE_LABELS = {
  consultant: "Consultant",
  mo: "Medical officer",
  admin: "Admin",
};

function LetterheadSection({ doctor, onSaved }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(doctor?.qualification || "");
  }, [doctor?.id, doctor?.qualification]);

  const dirty = value.trim() !== (doctor?.qualification || "");

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/doctors/${doctor.id}`, { qualification: value.trim() });
      await onSaved();
      toast("Qualification saved — applies to the next prescription printed", "success");
    } catch (err) {
      toast(err?.response?.data?.error || "Could not save the qualification", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="docmgmt-setting"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save();
      }}
    >
      <div className="docmgmt-setting-text">
        <label htmlFor="docmgmt-qualification">Qualification on letterhead</label>
        <p className="docmgmt-hint">
          Printed under the name on prescriptions and referral letters. Leave blank to omit it.
        </p>
      </div>
      <div className="docmgmt-setting-control">
        <input
          id="docmgmt-qualification"
          value={value}
          maxLength={120}
          placeholder="e.g. MBBS, MD (Medicine)"
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="docmgmt-primary" type="submit" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function ToggleSetting({ doctor, field, checked, disabled, label, hint, successText, onSaved }) {
  const [saving, setSaving] = useState(false);
  const toggle = async (next) => {
    setSaving(true);
    try {
      await api.patch(`/api/doctors/${doctor.id}`, { [field]: next });
      await onSaved();
      toast(successText(next), "success");
    } catch (err) {
      toast(err?.response?.data?.error || "Update failed", "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="docmgmt-setting docmgmt-setting--toggle">
      <div className="docmgmt-setting-text">
        <label htmlFor={`docmgmt-${field}`}>{label}</label>
        <p className="docmgmt-hint">{hint}</p>
      </div>
      <div className="docmgmt-setting-control">
        <input
          id={`docmgmt-${field}`}
          type="checkbox"
          className="docmgmt-switch"
          checked={checked}
          disabled={saving || disabled}
          onChange={(e) => toggle(e.target.checked)}
        />
      </div>
    </div>
  );
}

function SettingsTab({ doctor, onSaved }) {
  const name = doctor.short_name || doctor.name;
  return (
    <div className="docmgmt-settings">
      {(doctor.role === "consultant" || doctor.is_chief) && (
        <ToggleSetting
          doctor={doctor}
          field="is_chief"
          checked={!!doctor.is_chief}
          label="Chief consultant"
          hint="Used by patient-flow check-in to route patients to a Chief."
          successText={(on) => `${name} ${on ? "marked as" : "removed as"} Chief`}
          onSaved={onSaved}
        />
      )}
      {doctor.role === "consultant" && (
        <ToggleSetting
          doctor={doctor}
          field="vitals_rest"
          checked={doctor.vitals_rest !== false}
          label={`${VITALS_REST_MINUTES}-min rest before vitals`}
          hint={`Patients rest ${VITALS_REST_MINUTES} minutes after arrival before the Vitals station can call them.`}
          successText={(on) =>
            `${name}'s patients ${on ? `now rest ${VITALS_REST_MINUTES} minutes` : "no longer rest"} before vitals`
          }
          onSaved={onSaved}
        />
      )}
      <ToggleSetting
        doctor={doctor}
        field="can_assign_calls"
        checked={doctor.can_assign_calls === true || doctor.role === "admin"}
        disabled={doctor.role === "admin"}
        label="Can assign GHM calls"
        hint={
          doctor.role === "admin"
            ? "Admins can always assign and unassign patients on the GHM Ops sheet."
            : "Lets this person assign and unassign patients to the OBT team on the GHM Ops sheet."
        }
        successText={(on) => `${name} ${on ? "can now assign" : "can no longer assign"} GHM calls`}
        onSaved={onSaved}
      />
      <LetterheadSection doctor={doctor} onSaved={onSaved} />
    </div>
  );
}

function DoctorList({
  doctors,
  filter,
  setFilter,
  selectedId,
  onSelect,
  showRemoved,
  onShowRemoved,
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const itemMeta = (d) =>
    [filter === "all" ? ROLE_LABELS[d.role] || d.role : null, d.specialty]
      .filter(Boolean)
      .join(" · ");
  const visible = doctors
    .filter((d) => filter === "all" || d.role === "consultant")
    .filter(
      (d) => !q || d.name?.toLowerCase().includes(q) || d.specialty?.toLowerCase().includes(q),
    );

  return (
    <aside className="docmgmt-side" aria-label="Staff">
      <label className="docmgmt-search">
        <span className="docmgmt-visually-hidden">Search staff</span>
        <input
          type="search"
          value={query}
          placeholder="Search staff"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="docmgmt-filter" role="group" aria-label="Show">
        {[
          ["consultants", "Consultants"],
          ["all", "All staff"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={!showRemoved && filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="docmgmt-doclist" aria-label="Staff list">
        {visible.length === 0 && (
          <li className="docmgmt-empty">
            {q ? "No one matches this search." : "No staff to show."}
          </li>
        )}
        {visible.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="docmgmt-docitem"
              aria-current={!showRemoved && d.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(d.id)}
            >
              <span className="docmgmt-docitem-name">
                {d.name}
                {d.is_chief && <span className="docmgmt-badge">Chief</span>}
              </span>
              {itemMeta(d) && <span className="docmgmt-docitem-meta">{itemMeta(d)}</span>}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="docmgmt-removed-link"
        aria-pressed={showRemoved}
        onClick={onShowRemoved}
      >
        Removed staff
      </button>
    </aside>
  );
}

export default function DoctorManagementPage() {
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const fetchDoctorsList = useAuthStore((s) => s.fetchDoctorsList);
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const [doctorId, setDoctorId] = useState(null);
  const [filter, setFilter] = useState("consultants");
  const [showRemoved, setShowRemoved] = useState(false);
  const [tab, setTab] = useState("schedule");
  const [addTimeOff, setAddTimeOff] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const onChange = () => setRefresh((n) => n + 1);
  const [deleting, setDeleting] = useState(false);
  const [removedRefresh, setRemovedRefresh] = useState(0);

  useEffect(() => {
    if (!doctorsList?.length) fetchDoctorsList();
  }, [doctorsList?.length, fetchDoctorsList]);

  useEffect(() => {
    if (doctorId || !doctorsList?.length) return;
    const own = doctorsList.find((d) => d.id === currentDoctor?.id && d.role === "consultant");
    setDoctorId((own || doctorsList.find((d) => d.role === "consultant") || doctorsList[0]).id);
  }, [currentDoctor, doctorsList, doctorId]);

  const doctor = useMemo(
    () => doctorsList?.find((d) => d.id === doctorId) || null,
    [doctorsList, doctorId],
  );

  const select = (id) => {
    setShowRemoved(false);
    setDoctorId(id);
  };

  const openAddTimeOff = () => {
    setShowRemoved(false);
    setTab("timeoff");
    setAddTimeOff((n) => n + 1);
  };

  return (
    <div className="docmgmt">
      <div className="docmgmt-head">
        <h1>Staff Management</h1>
        <button
          type="button"
          className="docmgmt-primary"
          disabled={!doctor}
          onClick={openAddTimeOff}
        >
          + Add time off
        </button>
      </div>

      <div className="docmgmt-layout">
        <DoctorList
          doctors={doctorsList || []}
          filter={filter}
          setFilter={(f) => {
            setFilter(f);
            setShowRemoved(false);
          }}
          selectedId={doctorId}
          onSelect={select}
          showRemoved={showRemoved}
          onShowRemoved={() => setShowRemoved(true)}
        />

        <main className="docmgmt-main">
          {showRemoved ? (
            <section className="docmgmt-panel" aria-labelledby="docmgmt-removed-title">
              <h2 className="docmgmt-panel-title" id="docmgmt-removed-title">
                Removed staff
              </h2>
              <RemovedDoctors refresh={removedRefresh} onRestored={fetchDoctorsList} />
            </section>
          ) : !doctor ? (
            <p className="docmgmt-empty">Select a staff member from the list.</p>
          ) : (
            <section className="docmgmt-panel" aria-labelledby="docmgmt-doctor-name">
              <div className="docmgmt-dochead">
                <div>
                  <h2 id="docmgmt-doctor-name">
                    {doctor.name}
                    {doctor.is_chief && <span className="docmgmt-badge">Chief</span>}
                  </h2>
                  <p className="docmgmt-docmeta">
                    {[
                      ROLE_LABELS[doctor.role] || doctor.role,
                      doctor.specialty,
                      doctor.qualification,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  className="docmgmt-del"
                  disabled={doctor.id === currentDoctor?.id}
                  title={
                    doctor.id === currentDoctor?.id
                      ? "You can't delete your own account"
                      : undefined
                  }
                  onClick={() => setDeleting(true)}
                >
                  Delete
                </button>
              </div>

              <div className="docmgmt-tabs" role="tablist" aria-label="Staff sections">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`docmgmt-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls="docmgmt-tabpanel"
                    className={tab === t.id ? "active" : ""}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div
                id="docmgmt-tabpanel"
                role="tabpanel"
                aria-labelledby={`docmgmt-tab-${tab}`}
                className="docmgmt-tabpanel"
              >
                {tab === "schedule" && (
                  <>
                    <ProfileTab
                      doctorId={doctorId}
                      doctor={doctor}
                      refresh={refresh}
                      onChange={onChange}
                    />
                    <DayViewTab doctorId={doctorId} refresh={refresh} />
                  </>
                )}
                {tab === "timeoff" && (
                  <TimeOffTab
                    doctorId={doctorId}
                    doctor={doctor}
                    refresh={refresh}
                    onChange={onChange}
                    openSignal={addTimeOff}
                  />
                )}
                {tab === "settings" && <SettingsTab doctor={doctor} onSaved={fetchDoctorsList} />}
              </div>
            </section>
          )}
        </main>
      </div>

      {deleting && doctor && (
        <DeleteDoctorModal
          doctor={doctor}
          onClose={() => setDeleting(false)}
          onDone={async () => {
            setDeleting(false);
            setDoctorId(null);
            setRemovedRefresh((n) => n + 1);
            await fetchDoctorsList();
          }}
        />
      )}
    </div>
  );
}

function RemovedDoctors({ refresh, onRestored }) {
  const [list, setList] = useState(null);
  const [restoring, setRestoring] = useState(null);

  const load = useCallback(() => {
    api
      .get("/api/doctors/removed")
      .then((r) => setList(r.data || []))
      .catch(() => setList([]));
  }, [refresh]);
  useEffect(load, [load]);

  const restore = async (d) => {
    setRestoring(d.id);
    try {
      await api.delete(`/api/doctors/${d.id}/removal`);
      toast(
        `${d.name} restored — reactivate their consultation items on the Services page`,
        "success",
      );
      load();
      await onRestored?.();
    } catch (e) {
      toast(e.response?.data?.error || "Restore failed", "error");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div>
      <p className="docmgmt-hint">
        Removed staff can't log in and nothing can be billed under them. Restoring lets them log in
        again; their consultation items stay off until an admin reactivates them.
      </p>
      <table className="docmgmt-list">
        <thead>
          <tr>
            <th>Doctor</th>
            <th>Removed on</th>
            <th>By</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list === null && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                Loading…
              </td>
            </tr>
          )}
          {list?.length === 0 && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                No removed doctors.
              </td>
            </tr>
          )}
          {(list || []).map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{d.removed_at ? new Date(d.removed_at).toLocaleDateString("en-IN") : "—"}</td>
              <td>{d.removed_by_name || "—"}</td>
              <td>{d.removed_reason || "—"}</td>
              <td>
                <button
                  type="button"
                  className="docmgmt-secondary docmgmt-small"
                  disabled={restoring === d.id}
                  onClick={() => restore(d)}
                >
                  {restoring === d.id ? "Restoring…" : "Restore"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────── Working Profile ─────────────────────
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (t) => (t ? String(t).slice(0, 5) : ""); // "HH:MM:SS" → "HH:MM"
const toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// Overnight-aware: is time t inside [ws, we] (window wraps midnight if we<=ws)?
const withinWork = (ws, we, t) => {
  const s = toMin(ws),
    e0 = toMin(we),
    x0 = toMin(t);
  if (s == null || e0 == null || x0 == null) return true;
  let e = e0,
    x = x0;
  if (e <= s) e += 1440;
  if (x < s) x += 1440;
  return x >= s && x <= e;
};

function ProfileTab({ doctorId, doctor, refresh, onChange }) {
  const [offDays, setOffDays] = useState([0]);
  const [workStart, setWorkStart] = useState("");
  const [workEnd, setWorkEnd] = useState("");
  const [lunchStart, setLunchStart] = useState("");
  const [lunchEnd, setLunchEnd] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load the doctor's saved profile (or defaults) — prefills the form.
  useEffect(() => {
    setLoading(true);
    api
      .get(`/api/doctors/${doctorId}/profile`)
      .then((r) => {
        const p = r.data || {};
        setOffDays(p.off_weekdays ?? [0]);
        setWorkStart(hhmm(p.work_start));
        setWorkEnd(hhmm(p.work_end));
        setLunchStart(hhmm(p.lunch_start));
        setLunchEnd(hhmm(p.lunch_end));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [doctorId, refresh]);

  const isWorking = (d) => !offDays.includes(d);
  const toggleDay = (d) =>
    setOffDays((o) => (o.includes(d) ? o.filter((x) => x !== d) : [...o, d]));

  const overnight = workStart && workEnd && toMin(workEnd) <= toMin(workStart);

  const save = async () => {
    if ((workStart && !workEnd) || (!workStart && workEnd))
      return toast("Enter both working start and end times", "warn");
    if (workStart && workEnd && workStart === workEnd)
      return toast("Working start and end can't be the same", "warn");
    if ((lunchStart && !lunchEnd) || (!lunchStart && lunchEnd))
      return toast("Enter both lunch start and end times", "warn");
    if (
      workStart &&
      workEnd &&
      lunchStart &&
      lunchEnd &&
      (!withinWork(workStart, workEnd, lunchStart) || !withinWork(workStart, workEnd, lunchEnd))
    )
      return toast("Lunch break must be within working hours", "warn");
    setSaving(true);
    try {
      await api.put(`/api/doctors/${doctorId}/profile`, {
        off_weekdays: offDays,
        work_start: workStart || null,
        work_end: workEnd || null,
        lunch_start: lunchStart || null,
        lunch_end: lunchEnd || null,
      });
      toast("Profile saved", "success");
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || e.response?.data?.details?.[0] || "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="docmgmt-empty">Loading…</p>;

  return (
    <div>
      <h3 className="docmgmt-subhead first">Working days</h3>
      <div className="docmgmt-slotmulti">
        {WEEKDAYS.map((label, d) => (
          <label key={d} className={isWorking(d) ? "on" : ""}>
            <input type="checkbox" checked={isWorking(d)} onChange={() => toggleDay(d)} />
            {label}
          </label>
        ))}
      </div>

      <h3 className="docmgmt-subhead">Working hours</h3>
      <div className="docmgmt-form wrap">
        <label>
          From{" "}
          <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} />
        </label>
        <label>
          To <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} />
        </label>
        <span className="docmgmt-hint">
          {overnight
            ? "Overnight shift — ends next day."
            : "Leave blank = available all day. Overnight (e.g. 17:00–01:00) is supported."}
        </span>
      </div>

      <h3 className="docmgmt-subhead">Lunch break (every working day)</h3>
      <div className="docmgmt-form wrap">
        <label>
          From{" "}
          <input type="time" value={lunchStart} onChange={(e) => setLunchStart(e.target.value)} />
        </label>
        <label>
          To <input type="time" value={lunchEnd} onChange={(e) => setLunchEnd(e.target.value)} />
        </label>
        <span className="docmgmt-hint">
          {workStart && workEnd
            ? `Must be within working hours (${workStart}–${workEnd}).`
            : "Optional."}
        </span>
      </div>

      <div className="docmgmt-form-actions start">
        <button type="button" className="docmgmt-primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </div>
  );
}

const TIME_OFF_TYPES = {
  leave: "Leave",
  holiday: "Holiday",
  emergency: "Emergency",
  break: "Break",
};

const prettyDate = (d) =>
  d
    ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

function TimeOffTab({ doctorId, doctor, refresh, onChange, openSignal }) {
  const [list, setList] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [type, setType] = useState("leave");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const [fromNow, setFromNow] = useState(true);
  const [reason, setReason] = useState("");
  const [pickedSlots, setPickedSlots] = useState([]);
  const [daySlots, setDaySlots] = useState([]);
  const [fullDayLeave, setFullDayLeave] = useState(null);
  const [saving, setSaving] = useState(false);
  const [reassign, setReassign] = useState(null);
  const isEmergency = type === "emergency";
  const isBreak = type === "break";

  useEffect(() => {
    if (openSignal) setFormOpen(true);
  }, [openSignal]);

  const load = useCallback(() => {
    api
      .get(`/api/doctors/${doctorId}/unavailability`)
      .then((r) => setList(r.data || []))
      .catch(() => setList([]));
  }, [doctorId, refresh]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!isBreak) return;
    setPickedSlots([]);
    api
      .get(`/api/doctors/${doctorId}/availability?date=${start}`)
      .then((r) => setDaySlots(r.data?.slots || []))
      .catch(() => setDaySlots([]));
    api
      .get(`/api/doctors/${doctorId}/unavailability?from=${start}&to=${start}`)
      .then((r) =>
        setFullDayLeave(
          (r.data || []).find((u) => u.slot_labels == null && u.type !== "break") || null,
        ),
      )
      .catch(() => setFullDayLeave(null));
  }, [doctorId, start, isBreak, refresh]);

  const openSlots = daySlots.filter((s) => s.available).map((s) => ({ label: s.slot_label }));
  const dayOff = daySlots.length > 0 && daySlots.every((s) => s.blocked_by === "day_off");
  const breakBlocked = isBreak && (!!fullDayLeave || dayOff || openSlots.length === 0);

  const failed = (e) =>
    toast(
      e.response?.data?.message ||
        e.response?.data?.error ||
        e.response?.data?.details?.[0] ||
        "Could not save the time off",
      "error",
    );

  const finish = () => {
    setReason("");
    setPickedSlots([]);
    setFormOpen(false);
    onChange?.();
  };

  const submit = async () => {
    if (start < todayISO()) return toast("Pick today or a later date", "warn");
    if (!isBreak && (!end || end < start))
      return toast("The To date must be on or after the From date", "warn");
    if (isBreak && fullDayLeave)
      return toast(`${doctor?.name} is already on ${fullDayLeave.type} that day`, "warn");
    if (isBreak && !pickedSlots.length) return toast("Pick the slot(s) for the break", "warn");
    setSaving(true);
    try {
      if (isBreak) {
        const { data } = await api.post(`/api/doctors/${doctorId}/break`, {
          start_date: start,
          end_date: start,
          slot_labels: pickedSlots,
          reason,
        });
        finish();
        if (data.requires_reassignment) {
          const enriched = await enrichAffected(data.affected, doctorId, doctor);
          setReassign({ affected: enriched, doctor, trigger: "break" });
        } else {
          toast("Break added", "success");
        }
      } else if (isEmergency) {
        const { data } = await api.post(`/api/doctors/${doctorId}/emergency-leave`, {
          start_date: start,
          end_date: end,
          from_now: fromNow,
          slot_labels: null,
          reason,
        });
        finish();
        if (data.affected?.length) {
          setReassign({
            affected: data.affected,
            doctor,
            unavailability_id: data.unavailability_id,
            trigger: "emergency_leave",
          });
        } else {
          toast("Emergency leave set — no patients were booked in that window.", "success");
        }
      } else {
        const { data } = await api.post(`/api/doctors/${doctorId}/unavailability`, {
          type,
          start_date: start,
          end_date: end,
          slot_labels: null,
          reason,
        });
        finish();
        if (data.requires_reassignment) {
          const enriched = await enrichAffected(data.affected, doctorId, doctor);
          setReassign({ affected: enriched, doctor, trigger: "planned_leave" });
        } else {
          toast(`${TIME_OFF_TYPES[type]} added`, "success");
        }
      }
    } catch (e) {
      failed(e);
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (u) => {
    try {
      await api.patch(`/api/doctors/${doctorId}/unavailability/${u.id}`, { status: "cancelled" });
      toast(`${TIME_OFF_TYPES[u.type] || "Time off"} cancelled`, "success");
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not cancel it", "error");
    }
  };

  const submitLabel = isEmergency ? "Mark emergency" : `Add ${TIME_OFF_TYPES[type].toLowerCase()}`;

  return (
    <div>
      {formOpen ? (
        <form
          className={`docmgmt-timeoff-form${isEmergency ? " docmgmt-emergency" : ""}`}
          aria-label="Add time off"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="docmgmt-form wrap">
            <label>
              Type
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="leave">Leave</option>
                <option value="holiday">Holiday</option>
                <option value="break">Break (some slots, one day)</option>
                <option value="emergency">Emergency (now)</option>
              </select>
            </label>
            <label>
              {isBreak ? "Date" : "From"}
              <input
                type="date"
                min={todayISO()}
                value={start}
                onChange={(e) => {
                  const v = e.target.value;
                  setStart(v);
                  if (end && end < v) setEnd(v);
                }}
              />
            </label>
            {!isBreak && (
              <label>
                To
                <input
                  type="date"
                  min={start || todayISO()}
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
            )}
            {isEmergency && (
              <label className="docmgmt-check">
                <input
                  type="checkbox"
                  checked={fromNow}
                  onChange={(e) => setFromNow(e.target.checked)}
                />
                Only the rest of today
              </label>
            )}
            <label>
              Reason
              <input
                placeholder={isBreak ? "e.g. Meeting" : "Optional"}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>

          {isBreak && (
            <div className="docmgmt-breakslots">
              {fullDayLeave ? (
                <p className="docmgmt-leavebanner">
                  {doctor?.name} is on full-day {fullDayLeave.type}
                  {fullDayLeave.reason ? ` (${fullDayLeave.reason})` : ""} that day — no break
                  needed.
                </p>
              ) : dayOff ? (
                <p className="docmgmt-empty">Not a working day — there are no slots to block.</p>
              ) : openSlots.length === 0 ? (
                <p className="docmgmt-empty">No open slots left on this day.</p>
              ) : (
                <>
                  <p className="docmgmt-hint">
                    Slots to block (the daily lunch is set in Schedule)
                  </p>
                  <SlotMultiSelect
                    slots={openSlots}
                    value={pickedSlots}
                    onChange={setPickedSlots}
                  />
                </>
              )}
            </div>
          )}

          <p className="docmgmt-hint">
            If patients are already booked in this time, you'll be asked to move them to another
            doctor.
          </p>
          <div className="docmgmt-form-actions">
            <button type="button" className="docmgmt-secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className={isEmergency ? "docmgmt-danger" : "docmgmt-primary"}
              disabled={saving || breakBlocked}
            >
              {saving ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      ) : (
        <div className="docmgmt-tabbar">
          <p className="docmgmt-hint">
            Leave, holidays, emergencies and one-off breaks. Booking can't use these times.
          </p>
          <button type="button" className="docmgmt-secondary" onClick={() => setFormOpen(true)}>
            + Add time off
          </button>
        </div>
      )}

      <table className="docmgmt-list">
        <thead>
          <tr>
            <th>Type</th>
            <th>Dates</th>
            <th>Time</th>
            <th>Reason</th>
            <th>
              <span className="docmgmt-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list === null && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                Loading…
              </td>
            </tr>
          )}
          {list?.length === 0 && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                No time off scheduled. Use “Add time off” to mark leave, a holiday or a break.
              </td>
            </tr>
          )}
          {(list || []).map((u) => (
            <tr key={u.id}>
              <td>
                <span className={`docmgmt-type docmgmt-type--${u.type}`}>
                  {TIME_OFF_TYPES[u.type] || u.type}
                </span>
              </td>
              <td>
                {prettyDate(u.start_date)}
                {u.end_date && String(u.end_date).slice(0, 10) !== String(u.start_date).slice(0, 10)
                  ? ` – ${prettyDate(u.end_date)}`
                  : ""}
              </td>
              <td>{u.slot_labels?.length ? u.slot_labels.join(", ") : "Whole day"}</td>
              <td>{u.reason || "—"}</td>
              <td className="docmgmt-cell-action">
                <button type="button" className="docmgmt-del" onClick={() => cancel(u)}>
                  Cancel
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {reassign && (
        <ReassignModal
          {...reassign}
          onClose={() => setReassign(null)}
          onDone={() => {
            setReassign(null);
            toast("Reassignment complete", "success");
            onChange?.();
          }}
        />
      )}
    </div>
  );
}

const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function DayViewTab({ doctorId, refresh }) {
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get(`/api/doctors/${doctorId}/availability?date=${date}`),
      api.get(`/api/doctors/${doctorId}/profile`),
    ])
      .then(([a, p]) => {
        setSlots(a.data?.slots || []);
        setProfile(p.data || null);
      })
      .catch(() => {
        setSlots([]);
        setProfile(null);
      })
      .finally(() => setLoading(false));
  }, [doctorId, date, refresh]);

  // Only show slots inside working hours — hide "not a working slot".
  const dayOff = slots.length > 0 && slots.every((s) => s.blocked_by === "day_off");
  const visible = slots.filter((s) => s.blocked_by !== "not_working");
  const freeCount = visible.filter((s) => s.available).length;
  const t = (x) => (x ? String(x).slice(0, 5) : null);
  const hours =
    profile && t(profile.work_start) && t(profile.work_end)
      ? `${t(profile.work_start)}–${t(profile.work_end)}`
      : "All day";
  const lunch =
    profile && t(profile.lunch_start) && t(profile.lunch_end)
      ? `${t(profile.lunch_start)}–${t(profile.lunch_end)}`
      : null;

  return (
    <div>
      <div className="docmgmt-dayhead">
        <h3 className="docmgmt-subhead">Day preview</h3>
        <div className="docmgmt-daynav">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => setDate(shiftDay(date, -1))}
          >
            ‹
          </button>
          <label>
            <span className="docmgmt-visually-hidden">Preview date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
          <button type="button" aria-label="Next day" onClick={() => setDate(shiftDay(date, 1))}>
            ›
          </button>
        </div>
      </div>
      <p className="docmgmt-hint">What booking sees for this doctor on the chosen day.</p>

      {!loading && profile && (
        <div className="docmgmt-dayinfo">
          <span>
            Hours <strong>{hours}</strong>
          </span>
          {lunch && (
            <span>
              Lunch <strong>{lunch}</strong>
            </span>
          )}
          <span>
            <strong>{freeCount}</strong>/{visible.length} slots open
          </span>
        </div>
      )}

      {loading ? (
        <p className="docmgmt-empty">Loading…</p>
      ) : slots.length === 0 ? (
        <p className="docmgmt-empty">Could not load the day.</p>
      ) : dayOff ? (
        <p className="docmgmt-empty">Day off — not a working day.</p>
      ) : (
        <div className="docmgmt-slots">
          {visible.map((s) => (
            <div key={s.slot_label} className={`slotpill ${s.available ? "free" : "blocked"}`}>
              <span>{s.slot_label}</span>
              <small>
                {s.available
                  ? s.capacity == null
                    ? `Available${s.booked ? ` · ${s.booked} booked` : ""}`
                    : `Available · ${s.booked}/${s.capacity} booked`
                  : labelReason(s.blocked_by)}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Reassignment Modal ──────────────────
function ReassignModal({ affected, doctor, unavailability_id, trigger, onClose, onDone }) {
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(affected);

  const movable = rows.filter((r) => !r.in_progress);
  const allPicked = movable.every((r) => picks[r.appointment_id]);

  const autofill = () => {
    const next = {};
    for (const r of movable) {
      const top = r.suggested_doctors?.[0];
      if (top)
        next[r.appointment_id] = { to_doctor_id: top.doctor_id, to_doctor_name: top.doctor_name };
    }
    setPicks(next);
  };

  const apply = async () => {
    const moves = Object.entries(picks).map(([appointment_id, v]) => ({
      appointment_id: Number(appointment_id),
      to_doctor_id: v.to_doctor_id,
      to_doctor_name: v.to_doctor_name,
    }));
    if (!moves.length) return toast("Pick at least one doctor", "warn");
    setBusy(true);
    try {
      const { data } = await api.post("/api/appointments/reassign", {
        trigger,
        unavailability_id,
        reason: `${doctor?.name} ${trigger}`,
        moves,
      });
      if (data.failed?.length) {
        const failedIds = new Set(data.failed.map((f) => f.appointment_id));
        setRows((rs) => rs.filter((r) => failedIds.has(r.appointment_id)));
        setPicks({});
        toast(
          `${data.moved.length} moved, ${data.failed.length} failed (slot full?). Retry those.`,
          "warn",
        );
      } else {
        onDone();
      }
    } catch (e) {
      toast(e.response?.data?.error || "Reassign failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="docmgmt-modal-bg" onClick={onClose}>
      <div className="docmgmt-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Reassign patients — {doctor?.name} unavailable</h2>
        <p className="docmgmt-hint">
          {movable.length} patient(s) need a new doctor. In-progress visits are locked.
        </p>
        <table className="docmgmt-list">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Date</th>
              <th>Slot</th>
              <th>Reassign to</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.appointment_id} className={r.in_progress ? "locked" : ""}>
                <td>
                  {r.patient_name}
                  {r.file_no ? <small> ({r.file_no})</small> : null}
                </td>
                <td>{r.appointment_date?.slice(0, 10)}</td>
                <td>{r.time_slot}</td>
                <td>
                  {r.in_progress ? (
                    <em>🔒 in progress</em>
                  ) : r.suggested_doctors?.length ? (
                    <select
                      value={picks[r.appointment_id]?.to_doctor_id || ""}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        const d = r.suggested_doctors.find((x) => x.doctor_id === id);
                        setPicks((p) => ({
                          ...p,
                          [r.appointment_id]: d
                            ? { to_doctor_id: d.doctor_id, to_doctor_name: d.doctor_name }
                            : undefined,
                        }));
                      }}
                    >
                      <option value="">— choose —</option>
                      {r.suggested_doctors.map((d) => (
                        <option key={d.doctor_id} value={d.doctor_id}>
                          {d.doctor_name} ({d.free_capacity} free){d.same_specialty ? " ⭐" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <em className="docmgmt-nofree">⚠ no doctor free this slot</em>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="docmgmt-modal-actions">
          <button onClick={autofill}>Auto-fill suggestions</button>
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="docmgmt-primary" disabled={busy || !allPicked} onClick={apply}>
            {busy ? "Reassigning…" : "Reassign all"}
          </button>
        </div>
        {!allPicked && (
          <p className="docmgmt-warnline">
            Every movable patient must have a doctor before you can finish.
          </p>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── helpers ─────────────────────────────
function SlotMultiSelect({ slots, value, onChange }) {
  const toggle = (label) =>
    onChange(value.includes(label) ? value.filter((l) => l !== label) : [...value, label]);
  return (
    <div className="docmgmt-slotmulti">
      {slots.map((s) => (
        <label key={s.label} className={value.includes(s.label) ? "on" : ""}>
          <input
            type="checkbox"
            checked={value.includes(s.label)}
            onChange={() => toggle(s.label)}
          />
          {s.label}
        </label>
      ))}
    </div>
  );
}

// For planned-leave affected lists that arrive without suggestions, fetch them.
async function enrichAffected(affected, doctorId, doctor) {
  const out = [];
  for (const a of affected) {
    let suggested = [];
    if (!a.in_progress) {
      try {
        const { data } = await api.get(
          `/api/availability/doctors-for-slot?date=${a.appointment_date?.slice(0, 10)}&slot=${encodeURIComponent(
            a.time_slot,
          )}&exclude=${doctorId}${doctor?.specialty ? `&specialty=${encodeURIComponent(doctor.specialty)}` : ""}`,
        );
        suggested = data || [];
      } catch {
        suggested = [];
      }
    }
    out.push({ ...a, suggested_doctors: suggested });
  }
  return out;
}

function labelReason(reason) {
  const map = {
    day_off: "Day off",
    not_working: "Not a working slot",
    clinic_holiday: "Clinic holiday",
    leave: "On leave",
    break: "Break",
    emergency: "Emergency leave",
    holiday: "Doctor holiday",
    manual_block: "Blocked",
    full: "Full",
  };
  return map[reason] || reason || "Unavailable";
}
