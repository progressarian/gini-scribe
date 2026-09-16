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
  { role: "lab_admin", label: "Lab Admin", showSpecialty: false },
  { role: "machine_tech", label: "Machine Test Station", showSpecialty: false },
  { role: "echo_tech", label: "Echo Station", showSpecialty: false },
  { role: "xray_tech", label: "X-Ray Station", showSpecialty: false },
  { role: "tech", label: "Technicians", showSpecialty: false },
  { role: "pharmacy", label: "Pharmacy", showSpecialty: false },
  { role: "rx", label: "Prescription Explainer", showSpecialty: false },
  { role: "reception", label: "Reception", showSpecialty: false },
  { role: "obt", label: "OBT Team", showSpecialty: false },
  // One heading for the physician-relations team. A group may cover several
  // roles so the three growth tiers do not produce three identical headings.
  {
    roles: ["head_of_growth", "growth_manager", "growth_executive"],
    label: "Growth",
    showSpecialty: false,
  },
];

const rolesOf = (g) => g.roles ?? [g.role];
const GROUPED_ROLES = new Set(ROLE_GROUPS.flatMap(rolesOf));

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  const {
    currentDoctor,
    authReady,
    initAuth,
    doctorsList,
    doctorsLoading,
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

  // Land each role on a page it can actually open under the capability matrix.
  // ("/" and "/find" need no capability, so home is always a safe fallback —
  // notably nurse no longer goes to /lab-portal, which it can't access.)
  const ROLE_LANDING = {
    lab: "/lab-portal",
    tech: "/lab-portal",
    reception: "/opd",
    coordinator: "/opd",
    pharmacy: "/refills",
    rx: "/giniflow/station/rx",
  };
  const getDefaultRoute = (role) => ROLE_LANDING[role] || "/";

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
            disabled={doctorsLoading}
          >
            <option value="">
              {doctorsLoading ? "Loading doctors..." : "Choose your name..."}
            </option>
            {!doctorsLoading &&
              ROLE_GROUPS.map((g) => {
                const roles = rolesOf(g);
                const docs = doctorsList.filter((d) => roles.includes(d.role));
                if (!docs.length) return null;
                return (
                  <optgroup key={g.label} label={g.label}>
                    {docs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {g.showSpecialty && d.specialty ? ` — ${d.specialty}` : ""}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            {!doctorsLoading &&
              (() => {
                // Anything this list does not know about, rather than a second
                // hardcoded allowlist. The growth roles existed, were active,
                // and were returned by the API — but no group matched them, so
                // they rendered as nothing and the person simply could not log
                // in. A role that is new should be merely ungrouped here, never
                // invisible.
                const others = doctorsList.filter((d) => !GROUPED_ROLES.has(d.role));
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
