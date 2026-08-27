import BlockedPatientsView from "../components/ghm/BlockedPatientsView.jsx";
import "./GHMPage.css";

// Standalone route for the blocklist. Same component as the "Blocked Patients"
// tab on /ghm — one implementation, two ways in.
export default function PatientBlocklistPage() {
  return (
    <div className="ghm">
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Blocked patients</h1>
      <BlockedPatientsView />
    </div>
  );
}
