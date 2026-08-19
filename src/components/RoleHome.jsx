import { Navigate } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import { homeForRole } from "../config/routes";

export default function RoleHome({ children }) {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const home = homeForRole(role);
  if (home) return <Navigate to={home} replace />;
  return children;
}
