import useAuthStore from "../../stores/authStore";
import { useFlowVisits } from "../../queries/hooks/useFlow";
import StationSwitcher from "../../components/flow/StationSwitcher";
import ConsultantLoadBoard from "../../components/flow/ConsultantLoadBoard";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions";
import "../../styles/flow.css";

export default function FlowConsultantsPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canManage = hasCapability(role, CAP.FLOW_COORDINATOR);
  const { data: visits = [] } = useFlowVisits();

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div
          className="flow-header"
          style={{ background: "var(--fskl)", borderColor: "var(--fsk)" }}
        >
          <div>
            <div className="flow-title" style={{ color: "var(--fsk)" }}>
              👨‍⚕️ Consultant Station
            </div>
            <div className="flow-sub">
              Who is carrying what, and hand a patient to a freer colleague
            </div>
          </div>
          <div className="flow-header-right">
            <div className="flow-stat" style={{ padding: "6px 12px", minWidth: 0 }}>
              <div className="flow-stat-val" style={{ fontSize: 20, color: "var(--fsk)" }}>
                {visits.length}
              </div>
              <div className="flow-stat-lbl">Checked in today</div>
            </div>
          </div>
        </div>

        <StationSwitcher />

        {canManage ? (
          <div className="flow-card" style={{ marginBottom: 12 }}>
            <div className="flow-sec-title">Consultants — load &amp; hand-over</div>
            <ConsultantLoadBoard visits={visits} />
          </div>
        ) : (
          <div className="flow-card flow-empty">
            Hand-overs are managed by reception, the coordinator, or an admin.
          </div>
        )}
      </div>
    </div>
  );
}
