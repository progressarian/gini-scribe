import { useEffect, useRef } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useVisitStore from "../stores/visitStore";
import useUiStore, { toast } from "../stores/uiStore";
import useMessagingStore from "../stores/messagingStore";
import PageErrorBoundary from "./PageErrorBoundary";
import "../styles/App.css";

const NAV_ITEMS = [
  { path: "/", label: "🏠 Home", show: () => true },
  { path: "/find", label: "🔍 Find", show: () => true },
  { path: "/opd", label: "🏥 OPD", show: () => true },
  { path: "/dashboard", label: "📋 Patient", show: (s) => s.hasPatient },
  { path: "/visit", label: "👁 Visit", show: (s) => s.hasPatient },
  { path: "/quick", label: "⚡ Quick", show: (s) => !s.isLabRole && !s.visitActive },
  { path: "/patient", label: "👤", show: (s) => !s.visitActive },
  // Follow-up visit workflow
  {
    path: "/fu-load",
    label: "📤 Load",
    show: (s) => !s.isLabRole && s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-review",
    label: "📊 Review",
    show: (s) => !s.isLabRole && s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-edit",
    label: "📋 Edit Plan",
    show: (s) => !s.isLabRole && s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-symptoms",
    label: "🗣️ Symptoms",
    show: (s) => !s.isLabRole && s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-gen",
    label: "🤖 Create Plan",
    show: (s) => !s.isLabRole && s.visitActive && s.isFollowUp,
  },
  // New patient visit workflow
  {
    path: "/intake",
    label: "📝 Intake",
    show: (s) => !s.isLabRole && s.visitActive && !s.isFollowUp,
  },
  {
    path: "/history-clinical",
    label: "📜 History",
    show: (s) => !s.isLabRole && s.visitActive && !s.isFollowUp,
  },
  { path: "/exam", label: "🔍 Exam", show: (s) => !s.isLabRole && s.visitActive && !s.isFollowUp },
  {
    path: "/assess",
    label: "🧪 Assess",
    show: (s) => !s.isLabRole && s.visitActive && !s.isFollowUp,
  },
  // Documentation
  { path: "/mo", label: "🎤 MO", show: (s) => !s.isLabRole && !s.visitActive },
  { path: "/consultant", label: "👨‍⚕️ Con", show: (s) => !s.isLabRole && !s.isFollowUp },
  { path: "/plan", label: "📄 Plan", show: (s) => !s.isLabRole },
  { path: "/docs", label: "📎 Docs", show: (s) => s.hasPatient },
  { path: "/lab-portal", label: "🔬 Upload", show: (s) => s.isLabRole },
  { path: "/refills", label: "💊 Refills", show: () => true },
  { path: "/dose-change-requests", label: "⚕️ Dose Reviews", show: () => true },
  { path: "/side-effects", label: "💊 Side FX", show: (s) => !s.isLabRole },
  // { path: "/messages", label: "💬 Messages", show: () => true, badge: (s) => s.unreadCount > 0 },
  { path: "/reception-inbox", label: "🏥 Reception", show: (s) => !s.isLabRole },
  { path: "/lab-inbox", label: "🔬 Lab Chat", show: () => true },
  { path: "/history", label: "📜 Hx", show: (s) => !s.isLabRole && s.hasPatient },
  { path: "/outcomes", label: "📊", show: (s) => !s.isLabRole && !!s.dbPatientId },
  { path: "/ai", label: "🤖 AI", show: (s) => !s.isLabRole },
  { path: "/reports", label: "📊 Reports", show: (s) => s.isAdminOrConsultant },
  { path: "/ci", label: "🧠 CI", show: (s) => s.isAdminOrConsultant },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const location = useLocation();
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const handleLogout = useAuthStore((s) => s.handleLogout);
  const { patient, dbPatientId, duplicateWarning, setDuplicateWarning, loadPatientDB, newPatient } =
    usePatientStore();
  const { visitActive, endVisit, updateVisitRoute, saveDraft } = useVisitStore();
  const { saveStatus, draftSaved, saveConsultation } = useUiStore();
  const { unreadCount } = useMessagingStore();

  // Track route changes during active visit so refresh lands on the right page
  const prevPath = useRef(location.pathname);
  useEffect(() => {
    if (visitActive && location.pathname !== prevPath.current) {
      prevPath.current = location.pathname;
      updateVisitRoute(location.pathname);
    }
  }, [visitActive, location.pathname, updateVisitRoute]);

  const isFollowUp = usePatientStore((s) => s.getIsFollowUp());
  const isLabRole =
    currentDoctor?.role === "lab" ||
    currentDoctor?.role === "nurse" ||
    currentDoctor?.role === "tech";
  const isAdminOrConsultant =
    currentDoctor?.role === "admin" || currentDoctor?.role === "consultant";
  const hasPatient = !!dbPatientId || !!patient.name;

  const navState = {
    isLabRole,
    isAdminOrConsultant,
    hasPatient,
    visitActive,
    isFollowUp,
    dbPatientId,
    unreadCount,
  };

  const onLogout = () => {
    handleLogout();
    navigate("/login", { replace: true });
  };

  const STORAGE_KEY = "gini_scribe_session";

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header__brand">
          <div className="header__logo">G</div>
          <div>
            <div className="header__title">Gini Scribe</div>
            {currentDoctor && (
              <div className="header__doctor">
                {currentDoctor.name}
                {currentDoctor.specialty ? ` · ${currentDoctor.specialty}` : ""}
              </div>
            )}
          </div>
        </div>
        <div className="header__spacer" />
        {draftSaved && <span className="header__draft">{draftSaved}</span>}
        {saveStatus && (
          <span
            className={`header__save-status ${saveStatus.includes("✅") ? "header__save-status--success" : "header__save-status--pending"}`}
          >
            {saveStatus}
          </span>
        )}
        {duplicateWarning && (
          <div className="dup-banner">
            <span className="dup-banner__icon">⚠️</span>
            <div className="dup-banner__content">
              <div className="dup-banner__title">Patient Already Exists!</div>
              <div className="dup-banner__details">
                <b>{duplicateWarning.name}</b>
                {duplicateWarning.file_no ? ` · ${duplicateWarning.file_no}` : ""}
                {duplicateWarning.phone ? ` · ${duplicateWarning.phone}` : ""}
                {duplicateWarning.age
                  ? ` · ${duplicateWarning.age}Y/${(duplicateWarning.sex || "?").charAt(0)}`
                  : ""}
              </div>
              <div className="dup-banner__hint">
                Please look up this patient from Find Patient, or use a different file number.
              </div>
            </div>
            <button
              onClick={() => {
                loadPatientDB({
                  id: duplicateWarning.id,
                  name: duplicateWarning.name,
                  phone: duplicateWarning.phone,
                  file_no: duplicateWarning.file_no,
                  age: duplicateWarning.age,
                  sex: duplicateWarning.sex,
                });
                setDuplicateWarning(null);
              }}
              className="dup-banner__load-btn"
            >
              Load This Patient
            </button>
            <button onClick={() => setDuplicateWarning(null)} className="dup-banner__dismiss-btn">
              ✕ Dismiss
            </button>
          </div>
        )}
        <div className="header__actions">
          <button
            onClick={navClick("/find")}
            className={`header__find-btn ${location.pathname === "/find" ? "header__find-btn--active" : "header__find-btn--inactive"}`}
          >
            🔍 Find
          </button>
          {patient.name && (
            <button
              onClick={() => {
                saveDraft();
                toast("Draft saved", "success", 2000);
              }}
              className="header__save-btn"
            >
              💾 Draft
            </button>
          )}
          {patient.name && (
            <button
              onClick={async (e) => {
                await saveConsultation();
                newPatient();
                if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
                  window.open("/patient", "_blank", "noopener,noreferrer");
                } else {
                  navigate("/patient");
                }
              }}
              className="header__new-btn"
            >
              💾 Save & New
            </button>
          )}
          <button onClick={onLogout} className="header__logout-btn">
            Logout
          </button>
        </div>
      </div>

      {/* Active Patient Bar */}
      {patient.name && (
        <div className="patient-bar">
          <div className="patient-bar__avatar">{patient.name.charAt(0).toUpperCase()}</div>
          <div className="patient-bar__info">
            <span className="patient-bar__name">{patient.name}</span>
            <span className="patient-bar__age">
              {patient.age}Y/{patient.sex?.charAt(0)}
            </span>
            {patient.fileNo && <span className="patient-bar__fileno">{patient.fileNo}</span>}
            {patient.phone && <span className="patient-bar__phone">📱 {patient.phone}</span>}
          </div>
          {dbPatientId && <span className="patient-bar__db-id">DB #{dbPatientId}</span>}
        </div>
      )}

      {/* Navigation */}
      {!(duplicateWarning && !dbPatientId) && (
        <div className="tabs">
          {NAV_ITEMS.filter((t) => t.show(navState)).map((t) => (
            <NavLink
              key={t.path}
              to={t.path}
              end={t.path === "/"}
              className={({ isActive }) =>
                `tab-btn ${isActive ? (t.path === "/quick" ? "tab-btn--active-quick" : "tab-btn--active") : "tab-btn--inactive"}`
              }
            >
              {t.label}
              {t.badge && t.badge(navState) && !location.pathname.startsWith(t.path) && (
                <span className="tab-badge" />
              )}
            </NavLink>
          ))}
        </div>
      )}

      {/* Duplicate Patient Blocker */}
      {duplicateWarning && !dbPatientId && (
        <div className="dup-blocker">
          <div className="dup-blocker__icon">🚫</div>
          <div className="dup-blocker__title">Patient File Already Exists</div>
          <div className="dup-blocker__text">
            A patient with this {duplicateWarning.file_no ? "file number" : "phone number"} is
            already in the system:
          </div>
          <div className="dup-blocker__card">
            <div className="dup-blocker__card-name">{duplicateWarning.name}</div>
            <div className="dup-blocker__card-details">
              {duplicateWarning.file_no ? `File: ${duplicateWarning.file_no}` : ""}
              {duplicateWarning.file_no && duplicateWarning.phone ? " · " : ""}
              {duplicateWarning.phone ? `Phone: ${duplicateWarning.phone}` : ""}
            </div>
          </div>
          <div className="dup-blocker__actions">
            <button
              onClick={() => {
                loadPatientDB({
                  id: duplicateWarning.id,
                  name: duplicateWarning.name,
                  phone: duplicateWarning.phone,
                  file_no: duplicateWarning.file_no,
                });
                setDuplicateWarning(null);
              }}
              className="dup-blocker__load-btn"
            >
              Load Existing Patient
            </button>
            <button onClick={() => newPatient()} className="dup-blocker__fresh-btn">
              + Start Fresh
            </button>
          </div>
        </div>
      )}

      {/* Visit Active Banner */}
      {!(duplicateWarning && !dbPatientId) && visitActive && (
        <div className="visit-banner">
          <div className="visit-banner__pulse" />
          <span className="visit-banner__text">
            🩺 VISIT IN PROGRESS — {patient.name || "Patient"}
          </span>
          <button
            onClick={() => {
              saveDraft();
              toast("Draft saved", "success", 2000);
            }}
            className="visit-banner__btn"
          >
            💾 Draft
          </button>
          <button
            onClick={async () => {
              await saveConsultation();
              endVisit(true);
              localStorage.removeItem(STORAGE_KEY);
              navigate("/");
            }}
            className="visit-banner__btn visit-banner__btn--save-end"
          >
            💾 Save & End
          </button>
          <button
            onClick={async () => {
              await saveConsultation();
              endVisit(true);
              localStorage.removeItem(STORAGE_KEY);
              navigate("/");
            }}
            className="visit-banner__btn visit-banner__btn--end"
          >
            ✕ End
          </button>
        </div>
      )}

      {/* Page Content */}
      <PageErrorBoundary name="Page">
        <Outlet />
      </PageErrorBoundary>
    </div>
  );
}
