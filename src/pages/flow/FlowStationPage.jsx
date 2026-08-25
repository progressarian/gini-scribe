import { Navigate, useParams } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import { useFlowQueue } from "../../queries/hooks/useFlow";
import StationQueue, { ROLES } from "../../components/flow/StationQueue";
import StationSwitcher from "../../components/flow/StationSwitcher";
import { STATION_CAPABILITY, hasCapability, hasOwnConsultQueue } from "../../../shared/permissions";
import "../../styles/flow.css";

// Standalone station page. Chrome (header + desk switcher) lives here; the
// live queue body is the shared <StationQueue> (also used by /lab-requests).
export default function FlowStationPage() {
  const { role: slug } = useParams();
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const myStations = Object.keys(ROLES).filter((k) => hasCapability(role, STATION_CAPABILITY[k]));
  const cfg = ROLES[slug];
  const { data } = useFlowQueue(cfg?.role); // header counts (shares cache with StationQueue)
  const inQueue =
    (data?.ready?.length || 0) + (data?.pending?.length || 0) + (data?.active?.length ? 1 : 0);

  // Bare /flow/station (the nav tab) or an unknown slug → the first desk this
  // role can work. A role with no desk at all shouldn't be here.
  if (!cfg) {
    if (myStations.length) return <Navigate to={`/flow/station/${myStations[0]}`} replace />;
    // No station desk, but consultants still have their own worklist.
    if (hasOwnConsultQueue(role)) return <Navigate to="/flow/my-patients" replace />;
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div
          className="flow-header"
          style={{ background: "var(--fskl)", borderColor: "var(--fsk)" }}
        >
          <div>
            <div className="flow-title" style={{ color: "var(--fsk)" }}>
              {cfg.title}
            </div>
            <div className="flow-sub">
              Complete your step → patient auto-advances to the next station
            </div>
          </div>
          <div className="flow-header-right">
            <div className="flow-stat" style={{ padding: "6px 12px", minWidth: 0 }}>
              <div className="flow-stat-val" style={{ fontSize: 20, color: "var(--fsk)" }}>
                {inQueue}
              </div>
              <div className="flow-stat-lbl">In my queue</div>
            </div>
            <div
              className="flow-stat"
              style={{ padding: "6px 12px", minWidth: 0, borderColor: "var(--fgn)" }}
            >
              <div className="flow-stat-val f-grn" style={{ fontSize: 20 }}>
                {data?.done_today ?? 0}
              </div>
              <div className="flow-stat-lbl">Done today</div>
            </div>
          </div>
        </div>

        {/* Admin-only station switcher for shared devices */}
        <StationSwitcher />

        {/* Vitals is a quick, parallel station — let staff move/skip anyone at
            any time instead of the one-at-a-time call-in queue. */}
        <StationQueue role={cfg.role} form={cfg.form} freeMove={slug === "vitals"} />
      </div>
    </div>
  );
}
