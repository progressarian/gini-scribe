import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";

// After a deploy, the user's already-loaded index-*.js still references the
// PREVIOUS hashed chunk filenames (e.g. OPD-oBuNrVUz.js). Those files no
// longer exist on the server, so `import()` rejects with "Failed to fetch
// dynamically imported module". Recover by forcing one hard reload so the
// browser pulls the fresh index.html with new chunk hashes. The
// sessionStorage guard prevents an infinite reload loop if the failure is a
// genuine network/server problem rather than a stale-chunk mismatch.
const lazyWithRetry = (importer) =>
  lazy(async () => {
    try {
      return await importer();
    } catch (err) {
      const msg = String(err?.message || err);
      const isChunkError =
        /Failed to fetch dynamically imported module/i.test(msg) ||
        /Importing a module script failed/i.test(msg) ||
        /error loading dynamically imported module/i.test(msg);
      if (isChunkError && typeof window !== "undefined") {
        const KEY = "__chunk_reload_at__";
        const last = Number(sessionStorage.getItem(KEY) || 0);
        if (Date.now() - last > 10000) {
          sessionStorage.setItem(KEY, String(Date.now()));
          window.location.reload();
          // Return a never-resolving promise so React doesn't surface the
          // error UI in the split-second before reload kicks in.
          return new Promise(() => {});
        }
      }
      throw err;
    }
  });

// Route-level code-splitting. Each page becomes its own async chunk so a user
// who only visits /opd doesn't download /lab-portal, /fu-gen, etc. Kept the
// shell (AppLayout, ProtectedRoute, LoginPage) eager because they render on
// every route and gate navigation.
const Companion = lazyWithRetry(() => import("./Companion"));
const HomeScreen = lazyWithRetry(() => import("./companion/HomeScreen"));
const PatientScreen = lazyWithRetry(() => import("./companion/PatientScreen"));
const CaptureScreen = lazyWithRetry(() => import("./companion/CaptureScreen"));
const MultiCaptureScreen = lazyWithRetry(() => import("./companion/MultiCaptureScreen"));
const HomePage = lazyWithRetry(() => import("./pages/HomePage"));
const DashboardPage = lazyWithRetry(() => import("./pages/DashboardPage"));
const QuickPage = lazyWithRetry(() => import("./pages/QuickPage"));
const PatientPage = lazyWithRetry(() => import("./pages/PatientPage"));
const IntakePage = lazyWithRetry(() => import("./pages/IntakePage"));
const FULoadPage = lazyWithRetry(() => import("./pages/FULoadPage"));
const FUReviewPage = lazyWithRetry(() => import("./pages/FUReviewPage"));
const FUEditPage = lazyWithRetry(() => import("./pages/FUEditPage"));
const FUSymptomsPage = lazyWithRetry(() => import("./pages/FUSymptomsPage"));
const FUGenPage = lazyWithRetry(() => import("./pages/FUGenPage"));
const HistoryClinicalPage = lazyWithRetry(() => import("./pages/HistoryClinicalPage"));
const ExamPage = lazyWithRetry(() => import("./pages/ExamPage"));
const AssessPage = lazyWithRetry(() => import("./pages/AssessPage"));
const VitalsPage = lazyWithRetry(() => import("./pages/VitalsPage"));
const MOPage = lazyWithRetry(() => import("./pages/MOPage"));
const ConsultantPage = lazyWithRetry(() => import("./pages/ConsultantPage"));
const PlanPage = lazyWithRetry(() => import("./pages/PlanPage"));
const DocsPage = lazyWithRetry(() => import("./pages/DocsPage"));
const MessagesPage = lazyWithRetry(() => import("./pages/MessagesPage"));
const LabInboxPage = lazyWithRetry(() => import("./pages/LabInboxPage"));
const ReceptionInboxPage = lazyWithRetry(() => import("./pages/ReceptionInboxPage"));
const LabPortalPage = lazyWithRetry(() => import("./pages/LabPortalPage"));
const HistoryPage = lazyWithRetry(() => import("./pages/HistoryPage"));
const OutcomesPage = lazyWithRetry(() => import("./pages/OutcomesPage"));
const AIPage = lazyWithRetry(() => import("./pages/AIPage"));
const ReportsPage = lazyWithRetry(() => import("./pages/ReportsPage"));
const CIPage = lazyWithRetry(() => import("./pages/CIPage"));
const FindPage = lazyWithRetry(() => import("./pages/FindPage"));
const OPD = lazyWithRetry(() => import("./OPD"));
const VisitPage = lazyWithRetry(() => import("./pages/VisitPage"));

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
          { path: "/lab-inbox", element: lazyEl(LabInboxPage) },
          { path: "/reception-inbox", element: lazyEl(ReceptionInboxPage) },
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
