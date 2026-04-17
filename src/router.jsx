import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";

// Route-level code-splitting. Each page becomes its own async chunk so a user
// who only visits /opd doesn't download /lab-portal, /fu-gen, etc. Kept the
// shell (AppLayout, ProtectedRoute, LoginPage) eager because they render on
// every route and gate navigation.
const Companion = lazy(() => import("./Companion"));
const HomeScreen = lazy(() => import("./companion/HomeScreen"));
const PatientScreen = lazy(() => import("./companion/PatientScreen"));
const CaptureScreen = lazy(() => import("./companion/CaptureScreen"));
const MultiCaptureScreen = lazy(() => import("./companion/MultiCaptureScreen"));
const HomePage = lazy(() => import("./pages/HomePage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const QuickPage = lazy(() => import("./pages/QuickPage"));
const PatientPage = lazy(() => import("./pages/PatientPage"));
const IntakePage = lazy(() => import("./pages/IntakePage"));
const FULoadPage = lazy(() => import("./pages/FULoadPage"));
const FUReviewPage = lazy(() => import("./pages/FUReviewPage"));
const FUEditPage = lazy(() => import("./pages/FUEditPage"));
const FUSymptomsPage = lazy(() => import("./pages/FUSymptomsPage"));
const FUGenPage = lazy(() => import("./pages/FUGenPage"));
const HistoryClinicalPage = lazy(() => import("./pages/HistoryClinicalPage"));
const ExamPage = lazy(() => import("./pages/ExamPage"));
const AssessPage = lazy(() => import("./pages/AssessPage"));
const VitalsPage = lazy(() => import("./pages/VitalsPage"));
const MOPage = lazy(() => import("./pages/MOPage"));
const ConsultantPage = lazy(() => import("./pages/ConsultantPage"));
const PlanPage = lazy(() => import("./pages/PlanPage"));
const DocsPage = lazy(() => import("./pages/DocsPage"));
const MessagesPage = lazy(() => import("./pages/MessagesPage"));
const LabPortalPage = lazy(() => import("./pages/LabPortalPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const OutcomesPage = lazy(() => import("./pages/OutcomesPage"));
const AIPage = lazy(() => import("./pages/AIPage"));
const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const CIPage = lazy(() => import("./pages/CIPage"));
const FindPage = lazy(() => import("./pages/FindPage"));
const OPD = lazy(() => import("./OPD"));
const VisitPage = lazy(() => import("./pages/VisitPage"));

// Minimal fallback — matches the visual tone of the app without pulling in
// extra CSS. Each page typically fetches data on mount anyway, so this only
// shows for the few hundred ms of chunk download on first visit.
const RouteFallback = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "60vh",
      color: "#6b7d90",
      fontSize: 14,
    }}
  >
    Loading…
  </div>
);

const lazyEl = (Component) => (
  <Suspense fallback={<RouteFallback />}>
    <Component />
  </Suspense>
);

const router = createBrowserRouter([
  // Public routes
  { path: "/login", element: <LoginPage /> },

  // Protected routes (require login)
  {
    element: <ProtectedRoute />,
    children: [
      // Companion — own layout, no AppLayout
      {
        path: "/companion",
        element: lazyEl(Companion),
        children: [
          { index: true, element: lazyEl(HomeScreen) },
          { path: "record/:id", element: lazyEl(PatientScreen) },
          { path: "capture/:id", element: lazyEl(CaptureScreen) },
          { path: "multi-capture/:id", element: lazyEl(MultiCaptureScreen) },
        ],
      },
      {
        element: <AppLayout />,
        children: [
          { path: "/", element: lazyEl(HomePage) },
          { path: "/find", element: lazyEl(FindPage) },
          { path: "/dashboard", element: lazyEl(DashboardPage) },
          { path: "/quick", element: lazyEl(QuickPage) },
          { path: "/patient", element: lazyEl(PatientPage) },
          // Visit workflow - Follow-up
          { path: "/fu-load", element: lazyEl(FULoadPage) },
          { path: "/fu-review", element: lazyEl(FUReviewPage) },
          { path: "/fu-edit", element: lazyEl(FUEditPage) },
          { path: "/fu-symptoms", element: lazyEl(FUSymptomsPage) },
          { path: "/fu-gen", element: lazyEl(FUGenPage) },
          // Visit workflow - New patient
          { path: "/intake", element: lazyEl(IntakePage) },
          { path: "/history-clinical", element: lazyEl(HistoryClinicalPage) },
          { path: "/exam", element: lazyEl(ExamPage) },
          { path: "/assess", element: lazyEl(AssessPage) },
          // Clinical
          { path: "/vitals", element: lazyEl(VitalsPage) },
          { path: "/mo", element: lazyEl(MOPage) },
          { path: "/consultant", element: lazyEl(ConsultantPage) },
          { path: "/plan", element: lazyEl(PlanPage) },
          // Tools
          { path: "/docs", element: lazyEl(DocsPage) },
          { path: "/messages", element: lazyEl(MessagesPage) },
          { path: "/lab-portal", element: lazyEl(LabPortalPage) },
          // Analysis
          { path: "/history", element: lazyEl(HistoryPage) },
          { path: "/outcomes", element: lazyEl(OutcomesPage) },
          { path: "/ai", element: lazyEl(AIPage) },
          { path: "/reports", element: lazyEl(ReportsPage) },
          { path: "/ci", element: lazyEl(CIPage) },
          // OPD Manager
          { path: "/opd", element: lazyEl(OPD) },
          // Visit view
          { path: "/visit", element: lazyEl(VisitPage) },
        ],
      },
    ],
  },
]);

export default router;
