import { useEffect, useRef, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useVisitStore from "../stores/visitStore.js";
import useUiStore from "../stores/uiStore.js";
import Shimmer from "../components/Shimmer.jsx";
import api from "../services/api.js";
import "./FindPage.css";

export default function FindPage() {
  const navigate = useNavigate();
  const sentinelRef = useRef(null);
  const { doctorsList, fetchDoctorsList } = useAuthStore();
  const { loadPatientDB } = usePatientStore();
  const {
    todayAppointments,
    todayApptLoading,
    todayApptPage,
    todayApptTotalPages,
    todayApptTotal,
    todayApptLoadingMore,
    todayApptDoctor,
    setTodayApptDoctor,
    fetchTodayAppointments,
    loadMoreAppointments,
    showQuickBook,
    setShowQuickBook,
    quickBookPatient,
    setQuickBookPatient,
    bookForm,
    setBookForm,
    setEditApptId,
  } = useVisitStore();
  const {
    searchQuery,
    searchPeriod,
    searchDoctor,
    searchDoctorsList,
    searchStats,
    dbPatients,
    searchLoading,
    searchPage,
    searchTotalPages,
    searchTotal,
    searchLoadingMore,
    debouncedSearch,
    searchPatientsDB,
    loadMorePatients,
    setSearchPeriod,
    setSearchDoctor,
    initFind,
  } = useUiStore();

  const [bookErrors, setBookErrors] = useState({});

  // Fetch data on mount
  useEffect(() => {
    initFind();
    fetchTodayAppointments();
    if (!doctorsList.length) fetchDoctorsList();
  }, [initFind, fetchTodayAppointments, doctorsList.length, fetchDoctorsList]);

  // Infinite scroll via IntersectionObserver
  const handleObserver = useCallback(
    (entries) => {
      const entry = entries[0];
      if (entry.isIntersecting && !searchLoadingMore && searchPage < searchTotalPages) {
        loadMorePatients();
      }
    },
    [searchLoadingMore, searchPage, searchTotalPages, loadMorePatients],
  );

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(handleObserver, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleObserver]);

  const onFilterPeriod = (val) => {
    setSearchPeriod(val);
    searchPatientsDB(searchQuery, val, searchDoctor);
  };

  const onFilterDoctor = (val) => {
    setSearchDoctor(val);
    searchPatientsDB(searchQuery, searchPeriod, val);
    setTodayApptDoctor(val);
    fetchTodayAppointments();
  };

  const fmtTime = (slot) => {
    if (!slot) return "—";
    try {
      return new Date(`2000-01-01T${slot}`).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      return slot;
    }
  };

  return (
    <div className="find">
      {/* Header */}
      <div className="find__header">
        <div className="find__title">Find Patient</div>
        <button
          className="find__book-btn"
          onClick={() => {
            setEditApptId(null);
            setBookForm({
              dt: new Date().toISOString().split("T")[0],
              tm: "",
              ty: "OPD",
              sp: "",
              doc: "",
              notes: "",
            });
            setShowQuickBook(!showQuickBook);
          }}
        >
          + Book
        </button>
        <div className="find__stats">
          {searchStats
            ? [
                { label: "Total", val: searchStats.total_patients, color: "#475569" },
                { label: "Today", val: searchStats.today, color: "#2563eb" },
                { label: "This Week", val: searchStats.this_week, color: "#059669" },
              ].map((s) => (
                <div key={s.label} className="find__stat">
                  <div className="find__stat-val" style={{ color: s.color }}>
                    {s.val}
                  </div>
                  <div className="find__stat-label">{s.label}</div>
                </div>
              ))
            : [1, 2, 3].map((i) => (
                <div key={i} className="find__stat">
                  <div className="shimmer" style={{ width: 32, height: 18, borderRadius: 4 }} />
                  <div
                    className="shimmer"
                    style={{ width: 44, height: 9, borderRadius: 3, marginTop: 4 }}
                  />
                </div>
              ))}
        </div>
      </div>

      {/* Search input */}
      <div className="find__search-box">
        <span className="find__search-icon">🔍</span>
        <input
          value={searchQuery}
          onChange={(e) => debouncedSearch(e.target.value, searchPeriod, searchDoctor)}
          placeholder="Search by name, phone, or file number..."
          className="find__search-input"
          autoFocus
        />
      </div>

      {/* Filters */}
      <div className="find__filters">
        {[
          { label: "All", val: "" },
          { label: "Today", val: "today" },
          { label: "This Week", val: "week" },
          { label: "This Month", val: "month" },
        ].map((f) => (
          <button
            key={f.val}
            onClick={() => onFilterPeriod(f.val)}
            className={`find__filter-btn ${searchPeriod === f.val ? "find__filter-btn--active" : ""}`}
          >
            {f.label}
          </button>
        ))}
        <select
          value={searchDoctor}
          onChange={(e) => onFilterDoctor(e.target.value)}
          className="find__doctor-select"
        >
          <option value="">All Doctors</option>
          {doctorsList.map((d) => (
            <option key={d.id} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {/* Quick Book Form */}
      {showQuickBook && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700 }}>Book Appointment</span>
            <button
              onClick={() => setShowQuickBook(false)}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14 }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <input
              value={quickBookPatient.name}
              onChange={(e) => {
                setQuickBookPatient({ ...quickBookPatient, name: e.target.value });
                if (e.target.value.trim()) setBookErrors((p) => ({ ...p, name: false }));
              }}
              placeholder="Patient name *"
              style={{
                padding: "6px 8px",
                border: `1px solid ${bookErrors.name ? "#ef4444" : "#e2e8f0"}`,
                borderRadius: 6,
                fontSize: 11,
              }}
            />
            <input
              value={quickBookPatient.file_no}
              onChange={(e) =>
                setQuickBookPatient({ ...quickBookPatient, file_no: e.target.value })
              }
              placeholder="File No"
              style={{
                padding: "6px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                fontSize: 11,
              }}
            />
            <input
              value={quickBookPatient.phone}
              onChange={(e) => setQuickBookPatient({ ...quickBookPatient, phone: e.target.value })}
              placeholder="Phone"
              style={{
                padding: "6px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                fontSize: 11,
              }}
            />
            <input
              type="date"
              value={bookForm.dt}
              min={new Date().toISOString().split("T")[0]}
              onChange={(e) => {
                setBookForm({ ...bookForm, dt: e.target.value });
                if (e.target.value) setBookErrors((p) => ({ ...p, dt: false }));
              }}
              style={{
                padding: "6px 8px",
                border: `1px solid ${bookErrors.dt ? "#ef4444" : "#e2e8f0"}`,
                borderRadius: 6,
                fontSize: 11,
              }}
            />
            <input
              type="time"
              value={bookForm.tm}
              onChange={(e) => setBookForm({ ...bookForm, tm: e.target.value })}
              style={{
                padding: "6px 8px",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                fontSize: 11,
              }}
            />
            <select
              value={bookForm.doc}
              onChange={(e) => {
                setBookForm({ ...bookForm, doc: e.target.value });
                if (e.target.value) setBookErrors((p) => ({ ...p, doc: false }));
              }}
              style={{
                padding: "6px 8px",
                border: `1px solid ${bookErrors.doc ? "#ef4444" : "#e2e8f0"}`,
                borderRadius: 6,
                fontSize: 11,
                color: bookForm.doc ? "#1e293b" : "#94a3b8",
              }}
            >
              <option value="" disabled>Select Doctor *</option>
              {doctorsList.map((d) => (
                <option key={d.id} value={d.short_name || d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          {bookErrors.msg && (
            <div style={{ color: "#ef4444", fontSize: 11, fontWeight: 600, marginTop: 6 }}>
              {bookErrors.msg}
            </div>
          )}
          <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
            {["OPD", "Follow-up", "Lab"].map((t) => (
              <button
                key={t}
                onClick={() => setBookForm({ ...bookForm, ty: t })}
                style={{
                  padding: "3px 10px",
                  borderRadius: 12,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: bookForm.ty === t ? "2px solid #2563eb" : "1px solid #e2e8f0",
                  background: bookForm.ty === t ? "#eff6ff" : "white",
                  color: bookForm.ty === t ? "#2563eb" : "#64748b",
                }}
              >
                {t}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button
              onClick={async () => {
                const errs = {};
                const todayStr = new Date().toISOString().split("T")[0];
                if (!quickBookPatient.name.trim()) errs.name = true;
                if (!bookForm.dt) errs.dt = true;
                else if (bookForm.dt < todayStr) errs.dt = "past";
                if (!bookForm.doc) errs.doc = true;
                if (Object.keys(errs).length) {
                  const missing = [];
                  if (errs.name) missing.push("Patient Name");
                  if (errs.dt === "past") missing.push("Date cannot be in the past");
                  else if (errs.dt) missing.push("Date");
                  if (errs.doc) missing.push("Doctor");
                  errs.msg = errs.dt === "past"
                    ? "Date cannot be in the past"
                    : `Please fill: ${missing.join(", ")}`;
                  setBookErrors(errs);
                  return;
                }
                setBookErrors({});
                try {
                  await api.post("/api/appointments", {
                    patient_name: quickBookPatient.name,
                    file_no: quickBookPatient.file_no,
                    phone: quickBookPatient.phone,
                    doctor_name: bookForm.doc,
                    appointment_date: bookForm.dt,
                    time_slot: bookForm.tm || null,
                    visit_type: bookForm.ty || "OPD",
                  });
                  fetchTodayAppointments();
                  setShowQuickBook(false);
                  setQuickBookPatient({ name: "", file_no: "", phone: "" });
                } catch (e) {
                  setBookErrors({ msg: e.response?.data?.error || "Failed to book appointment" });
                }
              }}
              style={{
                background: "#059669",
                color: "white",
                border: "none",
                padding: "5px 16px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Book
            </button>
          </div>
        </div>
      )}

      {/* Today's Appointments */}
      {!searchQuery && (
        <div style={{ marginBottom: 12 }}>
          <div className="find__appts-header">
            <div className="find__appts-title">
              Today's Appointments ({todayApptTotal})
            </div>
            <button onClick={fetchTodayAppointments} className="find__appts-refresh">
              ↻
            </button>
          </div>
          {todayApptLoading ? (
            <div style={{ padding: 12, background: "white", borderRadius: "0 0 8px 8px" }}>
              <Shimmer type="list" count={4} />
            </div>
          ) : todayAppointments.length === 0 ? (
            <div
              style={{
                padding: 20,
                textAlign: "center",
                color: "#94a3b8",
                fontSize: 12,
                background: "white",
                borderRadius: "0 0 8px 8px",
              }}
            >
              No appointments booked for today
            </div>
          ) : (
            <div
              style={{
                background: "white",
                border: "1px solid #f1f5f9",
                borderRadius: "0 0 8px 8px",
              }}
            >
              {todayAppointments.map((a) => {
                const done = a.status === "completed" || a.status === "in-progress";
                const cancelled = a.status === "cancelled";
                return (
                  <div
                    key={a.id}
                    className={`find__appt ${done ? "find__appt--done" : ""}`}
                    onClick={() => {
                      if (a.patient_id) {
                        loadPatientDB({
                          id: a.patient_id,
                          name: a.patient_name,
                          phone: a.phone,
                          file_no: a.file_no,
                          age: a.age,
                          sex: a.sex,
                        });
                        navigate("/dashboard");
                      }
                    }}
                  >
                    <div>
                      <div className="find__appt-time">{fmtTime(a.time_slot)}</div>
                      <div className="find__appt-type">{a.visit_type || "OPD"}</div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="find__appt-name">
                        {a.patient_name || "Unknown"}
                        {a.age ? ` (${a.age}Y/${(a.sex || "?").charAt(0)})` : ""}
                      </div>
                      <div className="find__appt-detail">
                        {a.file_no ? `#${a.file_no}` : ""}
                        {a.file_no && a.doctor_name ? " · " : ""}
                        {a.doctor_name || ""}
                      </div>
                    </div>
                    {done ? (
                      <span
                        className="find__appt-status"
                        style={{ background: "#f0fdf4", color: "#059669" }}
                      >
                        Done
                      </span>
                    ) : cancelled ? (
                      <span
                        className="find__appt-status"
                        style={{ background: "#fef2f2", color: "#dc2626" }}
                      >
                        Cancelled
                      </span>
                    ) : (
                      <div className="find__appt-action-btns">
                        <button
                          className="find__appt-check"
                          onClick={(e) => {
                            e.stopPropagation();
                            api
                              .put(`/api/appointments/${a.id}`, { status: "completed" })
                              .then(() => fetchTodayAppointments());
                          }}
                        >
                          ✓
                        </button>
                        <button
                          className="find__appt-cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            api
                              .put(`/api/appointments/${a.id}`, { status: "cancelled" })
                              .then(() => fetchTodayAppointments());
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {todayApptPage < todayApptTotalPages && (
                <div style={{ textAlign: "center", padding: 8, borderTop: "1px solid #f1f5f9" }}>
                  <button
                    onClick={loadMoreAppointments}
                    disabled={todayApptLoadingMore}
                    className="find__load-more-btn"
                    style={{ width: "100%", fontSize: 11 }}
                  >
                    {todayApptLoadingMore
                      ? "Loading..."
                      : `Load More (${todayAppointments.length} of ${todayApptTotal})`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Patient List */}
      <div className="find__list-header">
        <div className="find__list-count">
          {searchLoading
            ? "Searching..."
            : `${searchTotal} patient${searchTotal !== 1 ? "s" : ""} found`}
        </div>
      </div>

      {searchLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="find__patient" style={{ cursor: "default" }}>
              <div className="shimmer" style={{ width: 38, height: 38, borderRadius: "50%", flexShrink: 0 }} />
              <div className="find__patient-info">
                <div className="find__patient-name-row">
                  <div className="shimmer" style={{ width: 90, height: 13, borderRadius: 4 }} />
                  <div className="shimmer" style={{ width: 36, height: 14, borderRadius: 4 }} />
                  <div className="shimmer" style={{ width: 54, height: 10, borderRadius: 3 }} />
                </div>
              </div>
              <div className="find__patient-stats">
                <div className="shimmer" style={{ width: 48, height: 11, borderRadius: 3, marginLeft: "auto" }} />
                <div className="shimmer" style={{ width: 58, height: 9, borderRadius: 3, marginTop: 3, marginLeft: "auto" }} />
                <div className="shimmer" style={{ width: 64, height: 9, borderRadius: 3, marginTop: 3, marginLeft: "auto" }} />
              </div>
            </div>
          ))}
        </div>
      ) : dbPatients.length === 0 ? (
        <div className="find__empty">
          <div className="find__empty-icon">🔍</div>
          <div className="find__empty-text">
            {searchQuery ? "No patients found" : "Search or use filters above"}
          </div>
          <div className="find__empty-hint">Try name, phone number, or file number</div>
        </div>
      ) : (
        <>
          {dbPatients.map((r) => (
            <div
              key={`p-${r.id}`}
              className="find__patient"
              onClick={() => {
                loadPatientDB(r);
                navigate("/dashboard");
              }}
            >
              <div className="find__patient-avatar">
                {(r.name || "?").charAt(0).toUpperCase()}
              </div>
              <div className="find__patient-info">
                <div className="find__patient-name-row">
                  <span className="find__patient-name">{r.name}</span>
                  <span className="find__patient-age">
                    {r.age}Y/{r.sex?.charAt(0)}
                  </span>
                  {r.file_no && <span className="find__patient-fileno">{r.file_no}</span>}
                </div>
                {r.diagnosis_labels && (
                  <div className="find__patient-dx">{r.diagnosis_labels}</div>
                )}
                {r.phone && <div className="find__patient-phone">{r.phone}</div>}
              </div>
              <div className="find__patient-stats">
                <div className="find__patient-visits">{r.visit_count || 0} visits</div>
                {r.last_visit && (
                  <div className="find__patient-last">
                    {(() => {
                      const d = new Date(String(r.last_visit).slice(0, 10) + "T12:00:00");
                      return d.toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "2-digit",
                      });
                    })()}
                  </div>
                )}
                {r.last_doctor && <div className="find__patient-doctor">{r.last_doctor}</div>}
              </div>
            </div>
          ))}

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} style={{ minHeight: 1 }}>
            {searchLoadingMore ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 6 }}>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="find__patient" style={{ cursor: "default" }}>
                    <div className="shimmer" style={{ width: 38, height: 38, borderRadius: "50%", flexShrink: 0 }} />
                    <div className="find__patient-info">
                      <div className="find__patient-name-row">
                        <div className="shimmer" style={{ width: 90, height: 13, borderRadius: 4 }} />
                        <div className="shimmer" style={{ width: 36, height: 14, borderRadius: 4 }} />
                        <div className="shimmer" style={{ width: 54, height: 10, borderRadius: 3 }} />
                      </div>
                    </div>
                    <div className="find__patient-stats">
                      <div className="shimmer" style={{ width: 48, height: 11, borderRadius: 3, marginLeft: "auto" }} />
                      <div className="shimmer" style={{ width: 58, height: 9, borderRadius: 3, marginTop: 3, marginLeft: "auto" }} />
                      <div className="shimmer" style={{ width: 64, height: 9, borderRadius: 3, marginTop: 3, marginLeft: "auto" }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : searchPage >= searchTotalPages ? (
              dbPatients.length > 0 && (
                <div style={{ fontSize: 11, color: "#cbd5e1", padding: 8, textAlign: "center" }}>
                  Showing all {searchTotal} patients
                </div>
              )
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
