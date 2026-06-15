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
// Exact match first; else the longest registered prefix (so dynamic segments
// like /flow/station/:role inherit the gate on /flow/station). Existing static
// routes always hit the exact branch, so their behavior is unchanged.
function capForPath(pathname) {
  if (pathname in PAGE_CAPABILITIES) return PAGE_CAPABILITIES[pathname];
  let best = null;
  let bestLen = -1;
  for (const key in PAGE_CAPABILITIES) {
    if (pathname.startsWith(key + "/") && key.length > bestLen) {
      best = PAGE_CAPABILITIES[key];
      bestLen = key.length;
    }
  }
  return best;
}

export default function RequireCapability() {
  const location = useLocation();
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const requiredCap = capForPath(location.pathname);
  const allowed = !requiredCap || hasCapability(role, requiredCap);

  useEffect(() => {
    if (!allowed) toast("You don't have access to this page", "warn");
  }, [allowed, location.pathname]);

  if (!allowed) return <Navigate to="/" replace />;
  return <Outlet />;
}
