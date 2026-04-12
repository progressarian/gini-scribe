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
        if (location.pathname === "/") {
          // On home page: try to restore active visit from DB and navigate to it
          const av = await restoreVisit();
          if (av && av.patient_id) {
            await loadPatientDB({
              id: av.patient_id,
              name: av.patient_name || "",
              phone: av.phone || "",
              file_no: av.file_no || "",
              age: av.age || "",
              sex: av.sex || "",
            });
            if (av.route) navigate(av.route, { replace: true });
            return;
          }
        }
        // For any other page (or no active visit): restore patient from session
        if (!dbPatientId) restorePatient();
      })();
    }
  }, [authReady, currentDoctor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!authReady) return null;
  if (!currentDoctor) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}
