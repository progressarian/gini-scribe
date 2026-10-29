import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import api from "../services/api";
import { qk } from "../queries/keys";
import useAuthStore from "../stores/authStore";
import { toast } from "../stores/uiStore";
import DeleteDoctorModal from "../components/doctors/DeleteDoctorModal";
import ScheduleEditor from "../components/doctors/ScheduleEditor";
import StaffOverview from "../components/doctors/StaffOverview";
import AddStaffModal from "../components/doctors/AddStaffModal";
import ReassignModal, { enrichAffected } from "../components/doctors/ReassignModal";
import ConfirmModal from "../components/ui/ConfirmModal";
import { VITALS_REST_MINUTES } from "../../shared/giniflowStatus";
import { SCHEDULED_ROLES, staffRoleLabel } from "../../shared/staffRoles";
import "./DoctorManagementPage.css";

const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "schedule", label: "Schedule", scheduled: true },
  { id: "timeoff", label: "Time off", scheduled: true },
  { id: "settings", label: "Settings" },
];

const isScheduled = (d) => SCHEDULED_ROLES.includes(d?.role);

const hasSettings = (doctor) =>
  doctor.role === "consultant" ||
  doctor.is_chief ||
  doctor.role === "obt" ||
  doctor.can_assign_calls === true ||
  doctor.role === "rx_mo" ||
  isScheduled(doctor);

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

function AssistsSetting({ doctor, consultants, onSaved }) {
  const [saving, setSaving] = useState(false);
  const save = async (id) => {
    setSaving(true);
    try {
      await api.patch(`/api/doctors/${doctor.id}`, { assists_doctor_id: Number(id) });
      await onSaved();
      const who = consultants.find((c) => c.id === Number(id));
      toast(
        `${doctor.short_name || doctor.name} now writes prescriptions for ${who?.name}`,
        "success",
      );
    } catch (err) {
      toast(err?.response?.data?.error || "Could not change who this MO assists", "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="docmgmt-setting">
      <div className="docmgmt-setting-text">
        <label htmlFor="docmgmt-assists">Writes prescriptions for</label>
        <p className="docmgmt-hint">
          This login only sees and writes for this consultant's patients. The prescription prints
          the consultant's name.
        </p>
      </div>
      <div className="docmgmt-setting-control">
        <select
          id="docmgmt-assists"
          value={doctor.assists_doctor_id ?? ""}
          disabled={saving}
          onChange={(e) => e.target.value && save(e.target.value)}
        >
          {!doctor.assists_doctor_id && <option value="">Choose a consultant…</option>}
          {consultants.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function SettingsGroup({ title, hint, children }) {
  return (
    <section className="docmgmt-setgroup">
      <h3 className="docmgmt-subhead first">{title}</h3>
      {hint && <p className="docmgmt-hint">{hint}</p>}
      <div className="docmgmt-settings">{children}</div>
    </section>
  );
}

function SettingsTab({ doctor, consultants, onSaved }) {
  const name = doctor.short_name || doctor.name;
  const consultant = doctor.role === "consultant";
  const routing = consultant || doctor.is_chief;
  const calls = doctor.role === "obt" || doctor.can_assign_calls === true;
  return (
    <div className="docmgmt-setgroups">
      {routing && (
        <SettingsGroup
          title="Patient flow routing"
          hint="Where this consultant's patients go on the floor after check-in and vitals."
        >
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
              field="chief_step"
              checked={doctor.chief_step === true}
              label="Chief Endocrinologist step"
              hint="Patients of this consultant see the Chief Endocrinologist after vitals. When off, they go straight from vitals to this consultant."
              successText={(on) =>
                `${name}'s patients ${on ? "now see" : "now skip"} the Chief Endocrinologist`
              }
              onSaved={onSaved}
            />
          )}
          {doctor.role === "consultant" && (
            <ToggleSetting
              doctor={doctor}
              field="direct_consult"
              checked={doctor.direct_consult === true}
              label="Runs own floor"
              hint="HealthRay only marks this consultant's patients no-show or cancelled — the floor moves them. Never sends them to the Chief Endocrinologist. A same-day booking with another consultant is an echo referral, and tests ordered during the consult bring the patient back to this consultant."
              successText={(on) => `${name} ${on ? "now runs" : "no longer runs"} their own floor`}
              onSaved={onSaved}
            />
          )}
        </SettingsGroup>
      )}
      {consultant && VITALS_REST_MINUTES > 0 && (
        <SettingsGroup title="Clinic timing">
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
        </SettingsGroup>
      )}
      {isScheduled(doctor) && (
        <SettingsGroup title="Prescriptions">
          <LetterheadSection doctor={doctor} onSaved={onSaved} />
          {consultant && (
            <ToggleSetting
              doctor={doctor}
              field="new_patient_workup"
              checked={doctor.new_patient_workup === true}
              label="New-patient History & Examination"
              hint="A new patient's visit page asks for the general history and the examination checklist, and both print on the prescription."
              successText={(on) =>
                `${name}'s new patients ${on ? "now get" : "no longer get"} the History & Examination form`
              }
              onSaved={onSaved}
            />
          )}
        </SettingsGroup>
      )}
      {doctor.role === "rx_mo" && (
        <SettingsGroup title="Prescriptions">
          <AssistsSetting doctor={doctor} consultants={consultants} onSaved={onSaved} />
        </SettingsGroup>
      )}
      {calls && (
        <SettingsGroup title="Access">
          {(doctor.role === "obt" || doctor.can_assign_calls === true) && (
            <ToggleSetting
              doctor={doctor}
              field="can_assign_calls"
              checked={doctor.can_assign_calls === true}
              label="Can assign GHM calls"
              hint={
                doctor.role === "obt"
                  ? "Lets this person assign and unassign patients to the OBT team on the GHM Ops sheet."
                  : "Only the OBT team uses this. Switch it off — it stops this person assigning GHM calls."
              }
              successText={(on) =>
                `${name} ${on ? "can now assign" : "can no longer assign"} GHM calls`
              }
              onSaved={onSaved}
            />
          )}
        </SettingsGroup>
      )}
    </div>
  );
}

const FILTERS = [
  ["all", "All staff", () => true],
  ["consultants", "Consultants", (d) => d.role === "consultant"],
  ["mo", "Medical officers", (d) => d.role === "mo"],
  ["other", "Other roles", (d) => !isScheduled(d)],
];

const isSlotDoctor = (d) => d.slot_booking === true;

const OFF_LABEL = { leave: "On leave", holiday: "On holiday", emergency: "Emergency leave" };

function DoctorList({
  doctors,
  filter,
  setFilter,
  selectedId,
  onSelect,
  showRemoved,
  onShowRemoved,
  offToday,
  slotsOnly,
  setSlotsOnly,
  slotCount,
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const keep = slotsOnly
    ? isSlotDoctor
    : FILTERS.find(([id]) => id === filter)?.[2] || (() => true);
  const visible = doctors
    .filter(keep)
    .filter(
      (d) =>
        !q ||
        [d.name, d.short_name, d.specialty, staffRoleLabel(d.role)].some((v) =>
          v?.toLowerCase().includes(q),
        ),
    );

  return (
    <aside className="docmgmt-side" aria-label="Staff">
      <label className="docmgmt-search">
        <span className="docmgmt-visually-hidden">Search staff</span>
        <input
          type="search"
          value={query}
          placeholder="Search by name, role or specialty"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {slotCount > 0 && (
        <div className="docmgmt-filter" role="group" aria-label="Doctors shown">
          <button
            type="button"
            aria-pressed={!showRemoved && slotsOnly}
            onClick={() => setSlotsOnly(true)}
          >
            Slot doctors ({slotCount})
          </button>
          <button
            type="button"
            aria-pressed={!showRemoved && !slotsOnly}
            onClick={() => setSlotsOnly(false)}
          >
            Everyone
          </button>
        </div>
      )}
      {!slotsOnly && (
        <div className="docmgmt-filter" role="group" aria-label="Show">
          {FILTERS.map(([id, label]) => (
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
      )}
      <p className="docmgmt-listhead">
        {slotsOnly ? "Slot doctors" : "Staff directory"} <span>{visible.length}</span>
      </p>
      <ul className="docmgmt-doclist" aria-label="Staff list">
        {visible.length === 0 && (
          <li className="docmgmt-empty">
            {q
              ? "No one matches this search."
              : slotsOnly
                ? "No slot doctors yet."
                : "No staff in this group."}
          </li>
        )}
        {visible.map((d) => {
          const off = offToday.get(d.id);
          return (
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
                  {!slotsOnly && isSlotDoctor(d) && <span className="docmgmt-chip">Slots</span>}
                </span>
                <span className="docmgmt-docitem-meta">
                  {[staffRoleLabel(d.role), d.specialty].filter(Boolean).join(" · ")}
                </span>
                {off && (
                  <span className="docmgmt-offbadge">{OFF_LABEL[off.type] || "Off"} today</span>
                )}
              </button>
            </li>
          );
        })}
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

function SlotDoctorButton({ doctor, onSaved }) {
  const [saving, setSaving] = useState(false);
  const on = isSlotDoctor(doctor);
  const toggle = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/doctors/${doctor.id}`, { slot_booking: !on });
      await onSaved();
      toast(
        on ? `${doctor.name} hidden from slot doctors` : `${doctor.name} added to slot doctors`,
        "success",
      );
    } catch (err) {
      toast(err?.response?.data?.error || "Could not update slot doctors. Try again.", "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <button
      type="button"
      className="docmgmt-secondary docmgmt-small"
      aria-pressed={on}
      disabled={saving}
      onClick={toggle}
    >
      {saving ? "Saving…" : on ? "Hide from slot doctors" : "Show in slot doctors"}
    </button>
  );
}

function MoreActions({ doctor, isSelf, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (e.type === "keydown" ? e.key === "Escape" : !ref.current?.contains(e.target))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="docmgmt-more" ref={ref}>
      <button
        type="button"
        className="docmgmt-secondary docmgmt-small"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${doctor.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="docmgmt-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={isSelf}
            title={isSelf ? "You can't delete your own account" : undefined}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete staff member
          </button>
        </div>
      )}
    </div>
  );
}

export default function DoctorManagementPage() {
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const fetchDoctorsList = useAuthStore((s) => s.fetchDoctorsList);
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("consultants");
  const [slotsPicked, setSlotsOnly] = useState(true);
  const [showRemoved, setShowRemoved] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [addTimeOff, setAddTimeOff] = useState(0);
  const [editSchedule, setEditSchedule] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const onChange = () => setRefresh((n) => n + 1);
  const [deleting, setDeleting] = useState(false);
  const [addingStaff, setAddingStaff] = useState(false);
  const [removedRefresh, setRemovedRefresh] = useState(0);
  const [offToday, setOffToday] = useState(new Map());
  const { data: approvalData } = useQuery({
    queryKey: qk.bookingApprovals.count,
    queryFn: async () => (await api.get("/api/booking-approvals/count")).data,
    refetchInterval: 60_000,
  });
  const approvalCount = approvalData?.pending || 0;

  useEffect(() => {
    if (!doctorsList?.length) fetchDoctorsList();
  }, [doctorsList?.length, fetchDoctorsList]);

  useEffect(() => {
    api
      .get("/api/doctors/time-off-today")
      .then((r) => setOffToday(new Map((r.data || []).map((u) => [u.doctor_id, u]))))
      .catch(() => setOffToday(new Map()));
  }, [refresh]);

  const setQuery = useCallback(
    (patch, { replace = false } = {}) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch))
            if (value == null) next.delete(key);
            else next.set(key, String(value));
          return next;
        },
        { replace },
      ),
    [setParams],
  );
  const urlDoctor = Number(params.get("doctor")) || null;
  const doctorId = doctorsList?.some((d) => d.id === urlDoctor) ? urlDoctor : null;
  const tab = params.get("tab") || "overview";
  const setTab = (next) => setQuery({ tab: next });

  const slotCount = (doctorsList || []).filter(isSlotDoctor).length;
  const slotsOnly = slotsPicked && slotCount > 0;

  useEffect(() => {
    if (doctorId || !doctorsList?.length) return;
    const own = doctorsList.find((d) => d.id === currentDoctor?.id && d.role === "consultant");
    const pick =
      doctorsList.find(isSlotDoctor) ||
      own ||
      doctorsList.find((d) => d.role === "consultant") ||
      doctorsList[0];
    setQuery({ doctor: pick.id }, { replace: true });
  }, [currentDoctor, doctorsList, doctorId, setQuery]);

  const doctor = useMemo(
    () => doctorsList?.find((d) => d.id === doctorId) || null,
    [doctorsList, doctorId],
  );

  const staff = doctorsList || [];
  const scheduledCount = staff.filter(isScheduled).length;
  const offCount = staff.filter((d) => offToday.has(d.id)).length;
  const settingsShown = doctor ? hasSettings(doctor) : false;
  const visibleTabs = TABS.filter(
    (t) => (!t.scheduled || isScheduled(doctor)) && (t.id !== "settings" || settingsShown),
  );
  const activeTab = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0].id;
  const off = doctor ? offToday.get(doctor.id) : null;

  const select = (id) => {
    setShowRemoved(false);
    setShowBulk(false);
    setQuery({ doctor: id, tab: "overview" });
  };

  const openAddTimeOff = () => {
    setTab("timeoff");
    setAddTimeOff((n) => n + 1);
  };

  const openEditSchedule = () => {
    setTab("schedule");
    setEditSchedule((n) => n + 1);
  };

  return (
    <div className="docmgmt">
      <div className="docmgmt-head">
        <div>
          <h1>Slot settings</h1>
          <p className="docmgmt-hint">
            Doctor slot timings, patients per slot, time off and staff.
          </p>
        </div>
        <div className="docmgmt-headactions">
          <Link to="/desk-requests?tab=bookings" className="docmgmt-secondary">
            Approvals{approvalCount ? ` (${approvalCount})` : ""}
          </Link>
          <button
            type="button"
            className="docmgmt-secondary"
            aria-pressed={showBulk}
            onClick={() => {
              setShowRemoved(false);
              setShowBulk(true);
            }}
          >
            Bulk schedule
          </button>
          <button type="button" className="docmgmt-primary" onClick={() => setAddingStaff(true)}>
            + Add staff
          </button>
        </div>
      </div>

      <dl className="docmgmt-kpis">
        <div>
          <dt>Total staff</dt>
          <dd>{staff.length}</dd>
        </div>
        <div>
          <dt>Consultants and MOs</dt>
          <dd>{scheduledCount}</dd>
        </div>
        <div>
          <dt>Off today</dt>
          <dd>{offCount}</dd>
        </div>
      </dl>

      <div className="docmgmt-layout">
        <DoctorList
          doctors={staff}
          filter={filter}
          setFilter={(f) => {
            setFilter(f);
            setShowRemoved(false);
          }}
          selectedId={showBulk ? null : doctorId}
          onSelect={select}
          showRemoved={showRemoved}
          onShowRemoved={() => {
            setShowBulk(false);
            setShowRemoved(true);
          }}
          offToday={offToday}
          slotsOnly={slotsOnly}
          setSlotsOnly={(on) => {
            setSlotsOnly(on);
            setShowRemoved(false);
          }}
          slotCount={slotCount}
        />

        <main className="docmgmt-main">
          {showBulk ? (
            <section className="docmgmt-panel" aria-label="Bulk schedule">
              <ScheduleEditor
                bulk
                onChange={onChange}
                refresh={refresh}
                onClose={() => setShowBulk(false)}
              />
            </section>
          ) : showRemoved ? (
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
                  <h2 id="docmgmt-doctor-name">{doctor.name}</h2>
                  <p className="docmgmt-docmeta">
                    {[staffRoleLabel(doctor.role), doctor.specialty, doctor.qualification]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="docmgmt-chips">
                    {doctor.is_chief && <span className="docmgmt-badge">Chief</span>}
                    <span className="docmgmt-chip">Active</span>
                    {off && (
                      <span className="docmgmt-offbadge">{OFF_LABEL[off.type] || "Off"} today</span>
                    )}
                  </div>
                </div>
                <div className="docmgmt-rowactions">
                  {isScheduled(doctor) && (
                    <SlotDoctorButton doctor={doctor} onSaved={fetchDoctorsList} />
                  )}
                  <MoreActions
                    doctor={doctor}
                    isSelf={doctor.id === currentDoctor?.id}
                    onDelete={() => setDeleting(true)}
                  />
                </div>
              </div>

              <div className="docmgmt-tabs" role="tablist" aria-label="Staff sections">
                {visibleTabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`docmgmt-tab-${t.id}`}
                    aria-selected={activeTab === t.id}
                    aria-controls="docmgmt-tabpanel"
                    className={activeTab === t.id ? "active" : ""}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div
                id="docmgmt-tabpanel"
                role="tabpanel"
                aria-labelledby={`docmgmt-tab-${activeTab}`}
                className="docmgmt-tabpanel"
              >
                {activeTab === "overview" && (
                  <StaffOverview
                    doctor={doctor}
                    refresh={refresh}
                    hasSettings={settingsShown}
                    onEditSchedule={openEditSchedule}
                    onAddTimeOff={openAddTimeOff}
                    onSettings={() => setTab("settings")}
                  />
                )}
                {activeTab === "schedule" && (
                  <ScheduleEditor
                    doctorId={doctorId}
                    doctor={doctor}
                    onChange={onChange}
                    refresh={refresh}
                    editSignal={editSchedule}
                  />
                )}
                {activeTab === "timeoff" && (
                  <TimeOffTab
                    doctorId={doctorId}
                    doctor={doctor}
                    refresh={refresh}
                    onChange={onChange}
                    openSignal={addTimeOff}
                  />
                )}
                {activeTab === "settings" && (
                  <SettingsTab
                    doctor={doctor}
                    consultants={(doctorsList || []).filter((d) => d.role === "consultant")}
                    onSaved={fetchDoctorsList}
                  />
                )}
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
            setQuery({ doctor: null, tab: null }, { replace: true });
            setRemovedRefresh((n) => n + 1);
            await fetchDoctorsList();
          }}
        />
      )}

      {addingStaff && (
        <AddStaffModal
          consultants={(doctorsList || []).filter((d) => d.role === "consultant")}
          onClose={() => setAddingStaff(false)}
          onCreated={async (created) => {
            setAddingStaff(false);
            await fetchDoctorsList();
            setSlotsOnly(false);
            setFilter("all");
            select(created.id);
          }}
        />
      )}
    </div>
  );
}

function RemovedDoctors({ refresh, onRestored }) {
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(false);
  const [restoring, setRestoring] = useState(null);

  const load = useCallback(() => {
    setFailed(false);
    api
      .get("/api/doctors/removed")
      .then((r) => setList(r.data || []))
      .catch(() => {
        setList([]);
        setFailed(true);
      });
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
            <th>Staff member</th>
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
          {failed && <LoadFailedRow what="removed staff" onRetry={load} />}
          {!failed && list?.length === 0 && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                No removed staff.
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

const TIME_OFF_VIEWS = [
  ["upcoming", "Upcoming"],
  ["past", "Past"],
  ["cancelled", "Cancelled"],
];

const timeOf = (u) =>
  u.start_time && u.end_time
    ? `${String(u.start_time).slice(0, 5)}–${String(u.end_time).slice(0, 5)}`
    : u.slot_labels?.length
      ? u.slot_labels.join(", ")
      : "Whole day";

function TimeOffTab({ doctorId, doctor, refresh, onChange, openSignal }) {
  const [list, setList] = useState(null);
  const [view, setView] = useState("upcoming");
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
  const [cancelling, setCancelling] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const isEmergency = type === "emergency";
  const isBreak = type === "break";

  useEffect(() => {
    if (openSignal) setFormOpen(true);
  }, [openSignal]);

  const [listFailed, setListFailed] = useState(false);
  const load = useCallback(() => {
    setListFailed(false);
    api
      .get(`/api/doctors/${doctorId}/unavailability?scope=all`)
      .then((r) => setList(r.data || []))
      .catch(() => {
        setList([]);
        setListFailed(true);
      });
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
          from_now: fromNow && start === todayISO() && end === start,
          slot_labels: null,
          reason,
        });
        finish();
        if (data.requires_reassignment) {
          setReassign({
            affected: data.affected,
            doctor,
            unavailability_id: data.unavailability_id,
            trigger: "emergency_leave",
          });
        } else if (data.affected?.length) {
          toast(
            `Emergency leave set. ${data.affected.length} patient(s) are already in their visit with ${doctor?.name} and stay with them.`,
            "success",
          );
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
    setCancelBusy(true);
    try {
      await api.patch(`/api/doctors/${doctorId}/unavailability/${u.id}`, { status: "cancelled" });
      toast(`${TIME_OFF_TYPES[u.type] || "Time off"} cancelled`, "success");
      setCancelling(null);
      onChange?.();
    } catch (e) {
      toast(e.response?.data?.error || "Could not cancel it", "error");
    } finally {
      setCancelBusy(false);
    }
  };

  const today = todayISO();
  const grouped = { upcoming: [], past: [], cancelled: [] };
  for (const u of list || []) {
    if (u.status !== "active") grouped.cancelled.push(u);
    else if (String(u.end_date).slice(0, 10) >= today) grouped.upcoming.push(u);
    else grouped.past.push(u);
  }
  grouped.past.reverse();
  grouped.cancelled.reverse();
  const rows = grouped[view];

  const describe = (u) =>
    `${TIME_OFF_TYPES[u.type] || "Time off"} · ${prettyDate(u.start_date)}${
      u.end_date && String(u.end_date).slice(0, 10) !== String(u.start_date).slice(0, 10)
        ? ` – ${prettyDate(u.end_date)}`
        : ""
    } · ${timeOf(u)}`;

  const submitLabel = isEmergency ? "Mark emergency" : `Add ${TIME_OFF_TYPES[type].toLowerCase()}`;

  return (
    <div>
      <div className="docmgmt-sectionhead">
        <div>
          <h3 className="docmgmt-subhead first">Time off</h3>
          <p className="docmgmt-hint">
            Leave, holidays, emergencies and one-off breaks. Booking can't use these times.
          </p>
        </div>
        {!formOpen && (
          <button type="button" className="docmgmt-primary" onClick={() => setFormOpen(true)}>
            + Add time off
          </button>
        )}
      </div>
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
            {isEmergency && start === todayISO() && end === start && (
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
      ) : null}

      <div className="docmgmt-filter docmgmt-viewfilter" role="group" aria-label="Show time off">
        {TIME_OFF_VIEWS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
            {label} <span className="docmgmt-count">{grouped[id].length}</span>
          </button>
        ))}
      </div>

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
          {listFailed && <LoadFailedRow what="time off" onRetry={load} />}
          {!listFailed && list && rows.length === 0 && (
            <tr>
              <td colSpan="5" className="docmgmt-empty">
                {view === "upcoming"
                  ? "No upcoming time off. Use “Add time off” to mark leave, a holiday or a break."
                  : view === "past"
                    ? "No past time off."
                    : "Nothing has been cancelled."}
              </td>
            </tr>
          )}
          {rows.map((u) => (
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
              <td>{timeOf(u)}</td>
              <td>{u.reason || "—"}</td>
              <td className="docmgmt-cell-action">
                {view === "upcoming" && (
                  <button type="button" className="docmgmt-del" onClick={() => setCancelling(u)}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmModal
        open={!!cancelling}
        title={`Cancel ${(TIME_OFF_TYPES[cancelling?.type] || "time off").toLowerCase()} for ${doctor?.name}?`}
        message={
          cancelling && (
            <>
              <p>{describe(cancelling)}</p>
              {cancelling.reason && <p>Reason: {cancelling.reason}</p>}
              <p>
                {doctor?.name} becomes bookable again in this time.
                {cancelling.type === "emergency" || cancelling.type === "leave"
                  ? " Patients already moved to another doctor stay with that doctor — this does not move them back."
                  : ""}
              </p>
            </>
          )
        }
        confirmLabel={`Cancel ${(TIME_OFF_TYPES[cancelling?.type] || "time off").toLowerCase()}`}
        cancelLabel="Keep it"
        busy={cancelBusy}
        onConfirm={() => cancel(cancelling)}
        onCancel={() => !cancelBusy && setCancelling(null)}
      />

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

function LoadFailedRow({ what, onRetry }) {
  return (
    <tr>
      <td colSpan="5" className="docmgmt-empty" role="alert">
        Could not load {what}. This list may be incomplete — try again before adding anything.{" "}
        <button type="button" className="docmgmt-secondary docmgmt-small" onClick={onRetry}>
          Try again
        </button>
      </td>
    </tr>
  );
}
