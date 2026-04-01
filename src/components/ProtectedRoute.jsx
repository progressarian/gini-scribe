import { useEffect, useRef } from "react";
import { Navigate, Outlet, useNavigate, useLocation } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useVisitStore from "../stores/visitStore";

export default function ProtectedRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const authReady = useAuthStore((s) => s.authReady);
  const initAuth = useAuthStore((s) => s.initAuth);
  const restorePatient = usePatientStore((s) => s.restorePatient);
  const loadPatientDB = usePatientStore((s) => s.loadPatientDB);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const restoreVisit = useVisitStore((s) => s.restoreVisit);
  const restored = useRef(false);

  useEffect(() => {
    if (!authReady) initAuth();
  }, [authReady, initAuth]);

  // Restore active patient + visit once after auth is ready
  useEffect(() => {
    if (authReady && currentDoctor && !restored.current) {
      restored.current = true;
      (async () => {
        // First try to restore an active visit from DB
        const av = await restoreVisit();
        if (av && av.patient_id) {
          // Load the patient that was in the active visit
          await loadPatientDB({
            id: av.patient_id,
            name: av.patient_name || "",
            phone: av.phone || "",
            file_no: av.file_no || "",
            age: av.age || "",
            sex: av.sex || "",
          });
          // Navigate to the route they were on, unless user is already on a specific page
          if (av.route && location.pathname === "/") navigate(av.route, { replace: true });
        } else if (!dbPatientId) {
          // No active visit — just restore patient from session
          restorePatient();
        }
      })();
    }
  }, [authReady, currentDoctor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!authReady) return null;
  if (!currentDoctor) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}
