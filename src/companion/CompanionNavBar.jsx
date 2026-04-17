import "./CompanionNavBar.css";
import { useNavigate, useLocation } from "react-router-dom";
import useCompanionStore from "../stores/companionStore";
import { toast } from "../stores/uiStore";

export default function CompanionNavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedPatient = useCompanionStore((s) => s.selectedPatient);

  // Extract patient ID from path like /companion/record/123, /companion/capture/123, or /companion/multi-capture/123
  const pathMatch = location.pathname.match(/\/companion\/(?:record|capture|multi-capture)\/(\d+)/);
  const patientId = pathMatch?.[1] || selectedPatient?.id;
  const path = location.pathname;

  const isHome = path === "/companion";
  const isCapture = path.includes("/capture/") || path.includes("/multi-capture/");
  const isRecord = path.includes("/record/");

  const goHome = () => navigate("/companion");

  const goCapture = () => {
    if (!patientId) {
      toast("Select a patient first", "warn");
      return;
    }
    navigate(`/companion/capture/${patientId}`);
  };

  const goRecord = () => {
    if (!patientId) {
      toast("Select a patient first", "warn");
      return;
    }
    navigate(`/companion/record/${patientId}`);
  };

  return (
    <div className="cnav">
      <button onClick={goHome} className={`cnav__btn ${isHome ? "cnav__btn--active" : ""}`}>
        <span className="cnav__icon">🏠</span>
        <span className={`cnav__label ${isHome ? "cnav__label--active" : ""}`}>Patients</span>
      </button>
      <button onClick={goCapture} className={`cnav__btn ${isCapture ? "cnav__btn--active" : ""}`}>
        <span className="cnav__icon">📸</span>
        <span className={`cnav__label ${isCapture ? "cnav__label--active" : ""}`}>Capture</span>
      </button>
      <button onClick={goRecord} className={`cnav__btn ${isRecord ? "cnav__btn--active" : ""}`}>
        <span className="cnav__icon">📋</span>
        <span className={`cnav__label ${isRecord ? "cnav__label--active" : ""}`}>Record</span>
      </button>
    </div>
  );
}
