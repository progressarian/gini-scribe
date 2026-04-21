import "./HomeScreen.css";
import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import useCompanionStore from "../stores/companionStore";
import { useCompanionAppointments } from "../queries/hooks/useCompanionAppointments";
import HomeToggle from "./HomeToggle";
import AppointmentsList from "./AppointmentsList";
import DatePicker from "./DatePicker";
import DoctorSelect from "./DoctorSelect";
import CompanionBell from "./CompanionBell";

const STATUS_ORDER = {
  in_visit: 0,
  checkedin: 1,
  scheduled: 2,
  seen: 3,
  completed: 4,
  cancelled: 5,
  no_show: 6,
};

const timeToMinutes = (slot) => {
  if (!slot || typeof slot !== "string") return 9999;
  const m = slot.match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

const todayStr = () => new Date().toISOString().slice(0, 10);

const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const formatDateLabel = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00`);
  const today = todayStr();
  const tomorrow = shiftDate(today, 1);
  const yesterday = shiftDate(today, -1);
  const prefix =
    dateStr === today
      ? "Today · "
      : dateStr === tomorrow
        ? "Tomorrow · "
        : dateStr === yesterday
          ? "Yesterday · "
          : "";
  return (
    prefix +
    d.toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
  );
};

export default function HomeScreen() {
  const navigate = useNavigate();
  const {
    patients,
    totalPatients,
    searchText,
    setSearchText,
    setSelectedPatient,
    setActiveAppointmentId,
    loadMore,
    loadPatients,
    hasMore,
    loadingPatients,
    homeTab,
    setHomeTab,
  } = useCompanionStore();

  // Refresh patient list (with updated visit_count) on every mount
  useEffect(() => {
    loadPatients();
  }, []);

  const sentinelRef = useRef(null);
  const [localSearch, setLocalSearch] = useState(searchText);
  const debounceRef = useRef(null);

  // Appointment date (defaults to today, user can shift to prev/next)
  const [apptDate, setApptDate] = useState(todayStr());
  const {
    data: appointments = [],
    isLoading: apptLoading,
    isFetching: apptFetching,
    refetch: refetchAppts,
  } = useCompanionAppointments(apptDate);

  // Appointment filters
  const [apptSearch, setApptSearch] = useState("");
  const [doctorFilter, setDoctorFilter] = useState("all");

  const doctors = useMemo(() => {
    const set = new Set();
    appointments.forEach((a) => a.doctor_name && set.add(a.doctor_name));
    return Array.from(set).sort();
  }, [appointments]);

  const filteredAppts = useMemo(() => {
    const q = apptSearch.trim().toLowerCase();
    const filtered = appointments.filter((a) => {
      if (doctorFilter !== "all" && a.doctor_name !== doctorFilter) return false;
      if (q) {
        const hay = [a.patient_name, a.doctor_name, a.file_no, a._resolved_file_no, a.phone]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Chronological sort by time-slot; fallback by status priority
    return filtered.sort((a, b) => {
      const ta = timeToMinutes(a.time_slot);
      const tb = timeToMinutes(b.time_slot);
      if (ta !== tb) return ta - tb;
      return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    });
  }, [appointments, apptSearch, doctorFilter]);

  // Default tab is appointments on first mount
  useEffect(() => {
    if (homeTab) return;
    setHomeTab("appointments");
  }, [homeTab, setHomeTab]);

  const tab = homeTab || "appointments";

  // Debounce search → server
  const handleSearch = (val) => {
    setLocalSearch(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchText(val), 400);
  };

  // Infinite scroll (only active when viewing patients)
  const onIntersect = useCallback(
    (entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingPatients) {
        loadMore();
      }
    },
    [hasMore, loadingPatients, loadMore],
  );

  useEffect(() => {
    if (tab !== "patients") return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(onIntersect, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [onIntersect, tab]);

  const handlePatientClick = (p) => {
    setSelectedPatient(p);
    setActiveAppointmentId(null);
    navigate(`/companion/record/${p.id}`);
  };

  // Keep cache fresh for the selected date after uploads
  const handleApptUpload = (a) => {
    if (!a.patient_id) return;
    setSelectedPatient({
      id: a.patient_id,
      name: a.patient_name,
      age: a.age,
      sex: a.sex,
      file_no: a.file_no || a._resolved_file_no,
      phone: a.phone,
    });
    setActiveAppointmentId(a.id);
    navigate(`/companion/multi-capture/${a.patient_id}`);
  };

  const handleApptView = (a) => {
    if (!a.patient_id) return;
    setSelectedPatient({
      id: a.patient_id,
      name: a.patient_name,
      age: a.age,
      sex: a.sex,
      file_no: a.file_no || a._resolved_file_no,
      phone: a.phone,
    });
    setActiveAppointmentId(a.id);
    navigate(`/companion/record/${a.patient_id}`);
  };

  return (
    <div>
      <div className="home__header">
        <div className="home__header-row">
          <div>
            <div className="home__title">Gini Companion</div>
            <div className="home__subtitle">
              {new Date().toLocaleDateString("en-IN", {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}{" "}
              • Gini Advanced Care
            </div>
          </div>
          <CompanionBell />
          {/* <div className="home__badge">
            {tab === "appointments" ? `${appointments.length} appts` : `${totalPatients} patients`}
          </div> */}
        </div>
      </div>

      <div className="home__body">
        <HomeToggle
          value={tab}
          onChange={setHomeTab}
          apptCount={appointments.length}
          patientCount={totalPatients}
        />

        {tab === "appointments" && (
          <>
            <div className="home__appt-filters">
              <div className="home__appt-date-row">
                <button
                  type="button"
                  onClick={() => setApptDate(shiftDate(apptDate, -1))}
                  className="home__appt-date-nav"
                  aria-label="Previous day"
                >
                  ‹
                </button>
                <DatePicker value={apptDate} onChange={setApptDate}>
                  <span className="home__appt-date-text">
                    📅 {formatDateLabel(apptDate)}
                    <span className="home__appt-date-caret">▾</span>
                  </span>
                </DatePicker>
                <button
                  type="button"
                  onClick={() => setApptDate(shiftDate(apptDate, 1))}
                  className="home__appt-date-nav"
                  aria-label="Next day"
                >
                  ›
                </button>
              </div>
              <div className="home__appt-search-row">
                <input
                  value={apptSearch}
                  onChange={(e) => setApptSearch(e.target.value)}
                  placeholder="Search patient, doctor, file no..."
                  className="home__search home__search--compact"
                />
                <button
                  type="button"
                  onClick={() => setApptDate(todayStr())}
                  disabled={apptDate === todayStr()}
                  className="home__appt-today-btn"
                  title="Jump to today"
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => refetchAppts()}
                  disabled={apptFetching}
                  className="home__appt-refresh"
                  title="Refresh appointments"
                  aria-label="Refresh"
                >
                  <span
                    className={`home__appt-refresh-icon ${apptFetching ? "home__appt-refresh-icon--spinning" : ""}`}
                  >
                    ↻
                  </span>
                </button>
              </div>
              <div className="home__appt-chips">
                <DoctorSelect value={doctorFilter} onChange={setDoctorFilter} doctors={doctors} />
                {(apptSearch || doctorFilter !== "all") && (
                  <button
                    type="button"
                    onClick={() => {
                      setApptSearch("");
                      setDoctorFilter("all");
                    }}
                    className="home__appt-chip home__appt-chip--clear"
                  >
                    ✕ Clear
                  </button>
                )}
              </div>
              {filteredAppts.length !== appointments.length && (
                <div className="home__appt-filter-count">
                  Showing {filteredAppts.length} of {appointments.length}
                </div>
              )}
            </div>
            <AppointmentsList
              appointments={filteredAppts}
              loading={apptLoading}
              onUpload={handleApptUpload}
              onView={handleApptView}
              date={apptDate}
            />
          </>
        )}

        {tab === "patients" && (
          <>
            <input
              value={localSearch}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search name, file no, phone..."
              className="home__search"
            />
            <div className="home__list">
              {patients.map((p) => (
                <div key={p.id} onClick={() => handlePatientClick(p)} className="home__patient">
                  <div className="home__avatar">{(p.name || "?")[0].toUpperCase()}</div>
                  <div className="home__info">
                    <div className="home__name">{p.name}</div>
                    <div className="home__details">
                      {p.age}Y/{p.sex?.[0]} • {p.file_no}
                    </div>
                  </div>
                  <div className="home__stats">
                    <div className="home__visits">{p.visit_count || 0} visits</div>
                    <div className="home__phone">{p.phone}</div>
                  </div>
                </div>
              ))}
              {hasMore && (
                <div ref={sentinelRef} className="home__loading-more">
                  {loadingPatients ? "Loading..." : "Scroll for more"}
                </div>
              )}
              {!hasMore && patients.length > 0 && (
                <div className="home__end">
                  Showing all {patients.length} of {totalPatients}
                </div>
              )}
              {!loadingPatients && patients.length === 0 && (
                <div className="home__empty">No patients found</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
