import { Navigate } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES as C, hasCapability } from "../../../shared/permissions.js";

// The lab is two rooms and nothing opens both at once
// (35-LAB-TWO-ROOM-SPLIT-PLAN.md §3.5). This path is kept only so links and
// bookmarks made before the split still land somewhere sensible: the bench the
// person actually works at, which for anyone holding both is collection —
// the start of the ladder.
export default function LabStationPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const to = hasCapability(role, C.GINIFLOW_STATION_LAB_COLLECT)
    ? "/giniflow/station/lab/collection"
    : "/giniflow/station/lab/processing";
  return <Navigate to={to} replace />;
}
