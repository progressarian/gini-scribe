import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import "./LoginPage.css";

const ROLE_GROUPS = [
  { role: "admin", label: "Admin", showSpecialty: true },
  { role: "consultant", label: "Consultants", showSpecialty: true },
  { role: "mo", label: "Medical Officers", showSpecialty: false },
  { role: "nurse", label: "Nursing", showSpecialty: false },
  { role: "coordinator", label: "Coordinators", showSpecialty: false },
  { role: "lab", label: "Laboratory", showSpecialty: false },
  { role: "tech", label: "Technicians", showSpecialty: false },
  { role: "pharmacy", label: "Pharmacy", showSpecialty: false },
  { role: "reception", label: "Reception", showSpecialty: false },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  const {
    currentDoctor,
    authReady,
    initAuth,
    doctorsList,
    loginPin,
    loginDoctorId,
    loginError,
    loginLoading,
    handleLogin,
    setLoginPin,
    setLoginDoctorId,
    fetchDoctorsList,
  } = useAuthStore();

  // Init auth + fetch doctors list on mount
  useEffect(() => {
    if (!authReady) initAuth();
    fetchDoctorsList();
  }, [authReady, initAuth, fetchDoctorsList]);

  const getDefaultRoute = (role) =>
    role === "lab" || role === "nurse" || role === "tech" ? "/lab-portal" : "/";

  // If already logged in, redirect to intended page or home
  useEffect(() => {
    if (authReady && currentDoctor) {
      navigate(from || getDefaultRoute(currentDoctor.role), { replace: true });
    }
  }, [authReady, currentDoctor, navigate, from]);

  const onLogin = async () => {
    const doctor = await handleLogin();
    if (doctor) {
      navigate(from || getDefaultRoute(doctor.role), { replace: true });
    }
  };

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">G</div>
          <div className="login-title">Gini Scribe</div>
          <div className="login-subtitle">Gini Advanced Care Hospital</div>
        </div>
        <div className="login-field">
          <label className="login-label">Select Doctor</label>
          <select
            value={loginDoctorId}
            onChange={(e) => setLoginDoctorId(e.target.value)}
            className="login-select"
          >
            <option value="">Choose your name...</option>
            {ROLE_GROUPS.map((g) => {
              const docs = doctorsList.filter((d) => d.role === g.role);
              if (!docs.length) return null;
              return (
                <optgroup key={g.role} label={g.label}>
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {g.showSpecialty && d.specialty ? ` — ${d.specialty}` : ""}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {(() => {
              const others = doctorsList.filter((d) => ["guest", "longevity"].includes(d.role));
              if (!others.length) return null;
              return (
                <optgroup label="Other">
                  {others.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.specialty ? ` — ${d.specialty}` : ""}
                    </option>
                  ))}
                </optgroup>
              );
            })()}
          </select>
        </div>
        <div className="login-field--pin">
          <label className="login-label">PIN</label>
          <input
            type="password"
            value={loginPin}
            onChange={(e) => setLoginPin(e.target.value)}
            placeholder="Enter 4-digit PIN"
            maxLength={4}
            onKeyDown={(e) => e.key === "Enter" && onLogin()}
            className="login-pin"
          />
        </div>
        {loginError && <div className="login-error">{loginError}</div>}
        <button
          onClick={onLogin}
          disabled={loginLoading}
          className={`login-btn ${loginLoading ? "login-btn--loading" : "login-btn--ready"}`}
        >
          {loginLoading ? "Logging in..." : "Login"}
        </button>
        <div className="login-footer">Default PIN: see admin</div>
      </div>
    </div>
  );
}
