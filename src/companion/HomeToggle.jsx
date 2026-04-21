import "./HomeToggle.css";

export default function HomeToggle({ value, onChange, apptCount, patientCount }) {
  return (
    <div className="home-toggle">
      <button
        type="button"
        onClick={() => onChange("appointments")}
        className={`home-toggle__btn ${value === "appointments" ? "home-toggle__btn--active" : ""}`}
      >
        <span className="home-toggle__icon">📅</span>
        <span className="home-toggle__label">Today</span>
        {/* <span className="home-toggle__count">{apptCount}</span> */}
      </button>
      <button
        type="button"
        onClick={() => onChange("patients")}
        className={`home-toggle__btn ${value === "patients" ? "home-toggle__btn--active" : ""}`}
      >
        <span className="home-toggle__icon">👥</span>
        <span className="home-toggle__label">Patients</span>
        {/* <span className="home-toggle__count">{patientCount}</span> */}
      </button>
    </div>
  );
}
