import { useNavigate, useLocation } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import { ROLES } from "./StationQueue";
import {
  CAPABILITIES as CAP,
  STATION_CAPABILITY,
  hasCapability,
  hasOwnConsultQueue,
} from "../../../shared/permissions";

const MY_PATIENTS_PATH = "/flow/my-patients";
const CONSULTANTS_PATH = "/flow/consultants";

// Desk switcher shared by the station pages and the consultant worklist. My
// Patients rides here rather than in the top nav because it is the consultant's
// desk — even though the SD step is deliberately not a station queue (one
// in_progress step per role would block every consultant at once).
export default function StationSwitcher() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.currentDoctor?.role);

  const desks = Object.keys(ROLES)
    .filter((slug) => hasCapability(role, STATION_CAPABILITY[slug]))
    .map((slug) => ({
      key: slug,
      path: `/flow/station/${slug}`,
      label: ROLES[slug].title.replace(/^[^ ]+ /, ""),
    }));
  if (hasOwnConsultQueue(role))
    desks.push({ key: "my-patients", path: MY_PATIENTS_PATH, label: "My Patients" });
  if (hasCapability(role, CAP.FLOW_CONSULTANTS))
    desks.push({ key: "consultants", path: CONSULTANTS_PATH, label: "Consultant Station" });

  if (desks.length < 2) return null;

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
      <span className="flow-muted" style={{ alignSelf: "center" }}>
        Switch station:
      </span>
      {desks.map((d) => (
        <button
          key={d.key}
          className={`flow-btn ${pathname === d.path ? "flow-btn-primary" : "flow-btn-ghost"}`}
          onClick={() => navigate(d.path)}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}
