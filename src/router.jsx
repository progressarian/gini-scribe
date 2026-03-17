import { createBrowserRouter } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";
import Companion from "./Companion";
import HomeScreen from "./companion/HomeScreen";
import PatientScreen from "./companion/PatientScreen";
import CaptureScreen from "./companion/CaptureScreen";
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import QuickPage from "./pages/QuickPage";
import PatientPage from "./pages/PatientPage";
import IntakePage from "./pages/IntakePage";
import FULoadPage from "./pages/FULoadPage";
import FUReviewPage from "./pages/FUReviewPage";
import FUEditPage from "./pages/FUEditPage";
import FUSymptomsPage from "./pages/FUSymptomsPage";
import FUGenPage from "./pages/FUGenPage";
import HistoryClinicalPage from "./pages/HistoryClinicalPage";
import ExamPage from "./pages/ExamPage";
import AssessPage from "./pages/AssessPage";
import VitalsPage from "./pages/VitalsPage";
import MOPage from "./pages/MOPage";
import ConsultantPage from "./pages/ConsultantPage";
import PlanPage from "./pages/PlanPage";
import DocsPage from "./pages/DocsPage";
import MessagesPage from "./pages/MessagesPage";
import LabPortalPage from "./pages/LabPortalPage";
import HistoryPage from "./pages/HistoryPage";
import OutcomesPage from "./pages/OutcomesPage";
import AIPage from "./pages/AIPage";
import ReportsPage from "./pages/ReportsPage";
import CIPage from "./pages/CIPage";
import FindPage from "./pages/FindPage";

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
        element: <Companion />,
        children: [
          { index: true, element: <HomeScreen /> },
          { path: "record/:id", element: <PatientScreen /> },
          { path: "capture/:id", element: <CaptureScreen /> },
        ],
      },
      {
        element: <AppLayout />,
        children: [
          { path: "/", element: <HomePage /> },
          { path: "/find", element: <FindPage /> },
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/quick", element: <QuickPage /> },
          { path: "/patient", element: <PatientPage /> },
          // Visit workflow - Follow-up
          { path: "/fu-load", element: <FULoadPage /> },
          { path: "/fu-review", element: <FUReviewPage /> },
          { path: "/fu-edit", element: <FUEditPage /> },
          { path: "/fu-symptoms", element: <FUSymptomsPage /> },
          { path: "/fu-gen", element: <FUGenPage /> },
          // Visit workflow - New patient
          { path: "/intake", element: <IntakePage /> },
          { path: "/history-clinical", element: <HistoryClinicalPage /> },
          { path: "/exam", element: <ExamPage /> },
          { path: "/assess", element: <AssessPage /> },
          // Clinical
          { path: "/vitals", element: <VitalsPage /> },
          { path: "/mo", element: <MOPage /> },
          { path: "/consultant", element: <ConsultantPage /> },
          { path: "/plan", element: <PlanPage /> },
          // Tools
          { path: "/docs", element: <DocsPage /> },
          { path: "/messages", element: <MessagesPage /> },
          { path: "/lab-portal", element: <LabPortalPage /> },
          // Analysis
          { path: "/history", element: <HistoryPage /> },
          { path: "/outcomes", element: <OutcomesPage /> },
          { path: "/ai", element: <AIPage /> },
          { path: "/reports", element: <ReportsPage /> },
          { path: "/ci", element: <CIPage /> },
        ],
      },
    ],
  },
]);

export default router;
