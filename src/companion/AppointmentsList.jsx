import "./AppointmentsList.css";

const STATUS_LABELS = {
  scheduled: "Scheduled",
  checkedin: "Checked-In",
  in_visit: "In Visit",
  seen: "Seen",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
};

function formatTime(slot) {
  if (!slot) return "";
  if (typeof slot !== "string") return String(slot);
  const m = slot.match(/(\d{1,2}):(\d{2})/);
  if (!m) return slot;
  const h = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ampm}`;
}

function AppointmentCard({ appointment, onUpload, onView }) {
  const a = appointment;
  const status = a.status || "scheduled";
  const fileNo = a.file_no || a._resolved_file_no || "";
  const uploadedCount = (a.uploaded_lab_canonicals || 0) + (a.uploaded_lab_docs || 0);
  const initials = (a.patient_name || "?")[0]?.toUpperCase() || "?";
  const hasPatient = !!a.patient_id;

  return (
    <div className="appt-card">
      <div className="appt-card__top">
        <div className="appt-card__time">{formatTime(a.time_slot) || "—"}</div>
        <div className={`appt-card__status appt-card__status--${status}`}>
          {STATUS_LABELS[status] || status}
        </div>
      </div>
      <div className="appt-card__row">
        <div className="appt-card__avatar">{initials}</div>
        <div className="appt-card__info">
          <div className="appt-card__name">{a.patient_name || "Unnamed"}</div>
          <div className="appt-card__details">
            {a.age ? `${a.age}Y` : ""}
            {a.sex ? `/${a.sex[0]}` : ""}
            {fileNo ? ` · ${fileNo}` : ""}
          </div>
          <div className="appt-card__doctor">
            {a.doctor_name ? `🩺 ${a.doctor_name}` : "No doctor assigned"}
            {a.visit_type ? ` · ${a.visit_type}` : ""}
          </div>
        </div>
      </div>
      {uploadedCount > 0 && (
        <div className="appt-card__badges">
          <span className="appt-card__badge appt-card__badge--lab">
            🔬 {uploadedCount} recent lab{uploadedCount === 1 ? "" : "s"}
          </span>
        </div>
      )}
      <div className="appt-card__actions">
        <button
          type="button"
          onClick={() => hasPatient && onUpload(a)}
          disabled={!hasPatient}
          className="appt-card__btn appt-card__btn--upload"
        >
          📤 Upload Reports
        </button>
        <button
          type="button"
          onClick={() => hasPatient && onView(a)}
          disabled={!hasPatient}
          className="appt-card__btn appt-card__btn--view"
        >
          👤 View
        </button>
      </div>
    </div>
  );
}

function AppointmentSkeleton() {
  return (
    <div className="appt-card appt-skel">
      <div className="appt-card__top">
        <div className="appt-skel__block appt-skel__block--time" />
        <div className="appt-skel__block appt-skel__block--status" />
      </div>
      <div className="appt-card__row">
        <div className="appt-skel__avatar" />
        <div className="appt-card__info">
          <div className="appt-skel__block appt-skel__block--name" />
          <div className="appt-skel__block appt-skel__block--meta" />
          <div className="appt-skel__block appt-skel__block--doctor" />
        </div>
      </div>
      <div className="appt-card__actions">
        <div className="appt-skel__block appt-skel__block--btn" />
        <div className="appt-skel__block appt-skel__block--btn" />
      </div>
    </div>
  );
}

function formatEmptyDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(`${dateStr}T12:00:00`);
    const today = new Date().toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "short",
    });
    return dateStr === today ? `today (${label})` : `on ${label}`;
  } catch {
    return "";
  }
}

export default function AppointmentsList({ appointments, loading, onUpload, onView, date }) {
  if (loading && !appointments?.length) {
    return (
      <div className="appt-list">
        {Array.from({ length: 4 }).map((_, i) => (
          <AppointmentSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (!appointments?.length) {
    return (
      <div className="appt-list__empty">
        <div className="appt-list__empty-icon" aria-hidden="true">
          🩺
        </div>
        <div className="appt-list__empty-text">No appointments {formatEmptyDate(date)}</div>
        <div className="appt-list__empty-sub">
          Use the date picker above to try a different day, or switch to "Patients" to search all
          patients.
        </div>
      </div>
    );
  }
  return (
    <div className="appt-list">
      {appointments.map((a) => (
        <AppointmentCard key={a.id} appointment={a} onUpload={onUpload} onView={onView} />
      ))}
    </div>
  );
}
