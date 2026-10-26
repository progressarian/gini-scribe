import { Navigate } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import { homeForRole } from "../config/routes";

export default function RoleHome({ children }) {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const hasRxMos = useAuthStore((s) => s.currentDoctor?.has_rx_mos === true);
  const home = hasRxMos ? "/giniflow/stations" : homeForRole(role);
  if (home) return <Navigate to={home} replace />;
  return children;
}

export function ConsultantStationGate({ children }) {
  const hasRxMos = useAuthStore((s) => s.currentDoctor?.has_rx_mos === true);
  if (hasRxMos) return <Navigate to="/giniflow/stations" replace />;
  return children;
}
