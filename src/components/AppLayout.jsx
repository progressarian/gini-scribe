import { useEffect, useRef } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import api from "../services/api";
import { makeNavClick } from "../lib/navClick";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useVisitStore from "../stores/visitStore";
import useUiStore, { toast } from "../stores/uiStore";
import useMessagingStore from "../stores/messagingStore";
import PageErrorBoundary from "./PageErrorBoundary";
import { PAGE_CAPABILITIES } from "../config/routes";
import { hasCapability } from "../../shared/permissions";
import "../styles/App.css";

// Each item's `cap` is the capability required to see it (from the shared
// PAGE_CAPABILITIES map; paths without one are always visible). The `show`
// predicates carry only CONTEXTUAL gating (active visit, loaded patient,
// follow-up vs new). Role gating now flows entirely through `cap` + the matrix
// in shared/permissions.js — while its master switch is on, every role sees
// every item (subject to context).
const C = PAGE_CAPABILITIES;

const NAV_ITEMS = [
  { path: "/", label: "🏠 Home", show: () => true },
  { path: "/find", label: "🔍 Find", show: () => true },
  { path: "/opd", label: "🏥 OPD", cap: C["/opd"], show: () => true },
  { path: "/dashboard", label: "📋 Patient", cap: C["/dashboard"], show: (s) => s.hasPatient },
  { path: "/visit", label: "👁 Visit", cap: C["/visit"], show: (s) => s.hasPatient },
  { path: "/quick", label: "⚡ Quick", cap: C["/quick"], show: (s) => !s.visitActive },
  { path: "/patient", label: "👤", cap: C["/patient"], show: (s) => !s.visitActive },
  // Follow-up visit workflow
  {
    path: "/fu-load",
    label: "📤 Load",
    cap: C["/fu-load"],
    show: (s) => s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-review",
    label: "📊 Review",
    cap: C["/fu-review"],
    show: (s) => s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-edit",
    label: "📋 Edit Plan",
    cap: C["/fu-edit"],
    show: (s) => s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-symptoms",
    label: "🗣️ Symptoms",
    cap: C["/fu-symptoms"],
    show: (s) => s.visitActive && s.isFollowUp,
  },
  {
    path: "/fu-gen",
    label: "🤖 Create Plan",
    cap: C["/fu-gen"],
    show: (s) => s.visitActive && s.isFollowUp,
  },
  // New patient visit workflow
  {
    path: "/intake",
    label: "📝 Intake",
    cap: C["/intake"],
    show: (s) => s.visitActive && !s.isFollowUp,
  },
  {
    path: "/history-clinical",
    label: "📜 History",
    cap: C["/history-clinical"],
    show: (s) => s.visitActive && !s.isFollowUp,
  },
  { path: "/exam", label: "🔍 Exam", cap: C["/exam"], show: (s) => s.visitActive && !s.isFollowUp },
  {
    path: "/assess",
    label: "🧪 Assess",
    cap: C["/assess"],
    show: (s) => s.visitActive && !s.isFollowUp,
  },
  // Documentation
  { path: "/mo", label: "🎤 MO", cap: C["/mo"], show: (s) => !s.visitActive },
  { path: "/consultant", label: "👨‍⚕️ Con", cap: C["/consultant"], show: (s) => !s.isFollowUp },
  { path: "/plan", label: "📄 Plan", cap: C["/plan"], show: () => true },
  { path: "/docs", label: "📎 Docs", cap: C["/docs"], show: (s) => s.hasPatient },
  { path: "/lab-portal", label: "🔬 Upload", cap: C["/lab-portal"], show: () => true },
  { path: "/refills", label: "💊 Refills", cap: C["/refills"], show: () => true },
  {
    path: "/dose-change-requests",
    label: "⚕️ Dose Reviews",
    cap: C["/dose-change-requests"],
    show: () => true,
  },
  {
    path: "/lab-requests",
    label: "🧪 Lab Requests",
    cap: C["/lab-requests"],
    show: () => true,
    count: (s) => s.labRequestCount,
  },
  { path: "/side-effects", label: "💊 Side FX", cap: C["/side-effects"], show: () => true },
  // { path: "/messages", label: "💬 Messages", show: () => true, badge: (s) => s.unreadCount > 0 },
  {
    path: "/reception-inbox",
    label: "🏥 Reception",
    cap: C["/reception-inbox"],
    show: () => true,
    count: (s) => s.receptionCount,
  },
  { path: "/lab-inbox", label: "🔬 Lab Chat", cap: C["/lab-inbox"], show: () => false },
  { path: "/history", label: "📜 Hx", cap: C["/history"], show: (s) => s.hasPatient },
  { path: "/outcomes", label: "📊", cap: C["/outcomes"], show: (s) => !!s.dbPatientId },
  { path: "/ai", label: "🤖 AI", cap: C["/ai"], show: () => true },
  { path: "/genie-chats", label: "🧞 Genie Chats", cap: C["/genie-chats"], show: () => true },
  { path: "/app-patients", label: "📱 App Patients", cap: C["/genie-chats"], show: () => true },
  { path: "/reports", label: "📊 Reports", cap: C["/reports"], show: () => true },
  { path: "/ci", label: "🧠 CI", cap: C["/ci"], show: () => true },
  // GHM Operations — single page
  { path: "/ghm", label: "🏥 GHM Ops", cap: C["/ghm"], show: () => true },
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

  // Pending lab-request count for the nav badge. Polls modestly so the badge
  // reflects new patient bookings without a manual refresh.
  const labRequestCountQuery = useQuery({
    queryKey: ["labRequests", "navCount"],
    queryFn: async () => {
      const { data } = await api.get("/api/lab-requests?status=pending");
      return Array.isArray(data) ? data.length : 0;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const labRequestCount = labRequestCountQuery.data || 0;

  // Unread reception-chat count for the nav badge — sum of team_unread_count
  // across the shared reception conversations.
  const receptionCountQuery = useQuery({
    queryKey: ["conversations", "reception", "navCount"],
    queryFn: async () => {
      const { data } = await api.get("/api/conversations", { params: { kind: "reception" } });
      const list = data?.data ?? [];
      return list.reduce((n, c) => n + (c.team_unread_count || 0), 0);
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const receptionCount = receptionCountQuery.data || 0;

  // Track route changes during active visit so refresh lands on the right page
  const prevPath = useRef(location.pathname);
  useEffect(() => {
    if (visitActive && location.pathname !== prevPath.current) {
      prevPath.current = location.pathname;
      updateVisitRoute(location.pathname);
    }
  }, [visitActive, location.pathname, updateVisitRoute]);

  const isFollowUp = usePatientStore((s) => s.getIsFollowUp());
  const role = currentDoctor?.role;
  const hasPatient = !!dbPatientId || !!patient.name;

  const navState = {
    role,
    hasPatient,
    visitActive,
    isFollowUp,
    dbPatientId,
    unreadCount,
    labRequestCount,
    receptionCount,
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
      {patient.name && location.pathname !== "/dashboard" && (
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
          {(() => {
            const visible = NAV_ITEMS.filter(
              (t) => (!t.cap || hasCapability(navState.role, t.cap)) && t.show(navState),
            );
            const rendered = [];
            let lastSection = null;
            for (const t of visible) {
              const sec = t.section || null;
              if (sec && sec !== lastSection) {
                rendered.push(
                  <span key={`sep-${sec}`} className="tab-section-sep">
                    {sec}
                  </span>,
                );
                lastSection = sec;
              } else if (!sec && lastSection) {
                lastSection = null;
              }
              rendered.push(
                <NavLink
                  key={t.path}
                  to={t.path}
                  end={t.path === "/"}
                  className={({ isActive }) =>
                    `tab-btn ${isActive ? (t.path === "/quick" ? "tab-btn--active-quick" : "tab-btn--active") : "tab-btn--inactive"}`
                  }
                >
                  {t.label}
                  {t.count && t.count(navState) > 0 && (
                    <span className="tab-count">{t.count(navState)}</span>
                  )}
                  {t.badge && t.badge(navState) && !location.pathname.startsWith(t.path) && (
                    <span className="tab-badge" />
                  )}
                </NavLink>,
              );
            }
            return rendered;
          })()}
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
