import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import { toast } from "../stores/uiStore";
import { PAGE_CAPABILITIES } from "../config/routes";
import { hasCapability } from "../../shared/permissions";

// Route guard: blocks direct-URL access to pages the current role can't open.
// Looks up the required capability for the current path in PAGE_CAPABILITIES;
// paths with no entry (e.g. "/" and "/find") are always allowed. When the role
// lacks the capability, redirects to Home with a toast. While the master switch
// in shared/permissions.js is on, hasCapability() is true for everyone, so this
// never blocks — it activates once you tune the matrix.
export default function RequireCapability() {
  const location = useLocation();
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const requiredCap = PAGE_CAPABILITIES[location.pathname];
  const allowed = !requiredCap || hasCapability(role, requiredCap);

  useEffect(() => {
    if (!allowed) toast("You don't have access to this page", "warn");
  }, [allowed, location.pathname]);

  if (!allowed) return <Navigate to="/" replace />;
  return <Outlet />;
}
