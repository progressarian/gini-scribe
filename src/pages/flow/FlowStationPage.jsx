import { useParams, useNavigate } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import { useFlowQueue } from "../../queries/hooks/useFlow";
import StationQueue, { ROLES } from "../../components/flow/StationQueue";
import "../../styles/flow.css";

// Standalone station page. Chrome (header + admin switcher) lives here; the
// live queue body is the shared <StationQueue> (also used by /lab-requests).
export default function FlowStationPage() {
  const { role: slug } = useParams();
  const navigate = useNavigate();
  const isAdmin = useAuthStore((s) => s.currentDoctor?.role === "admin");
  const cfg = ROLES[slug] || ROLES.vitals;
  const { data } = useFlowQueue(cfg.role); // header counts (shares cache with StationQueue)
  const inQueue = (data?.ready?.length || 0) + (data?.active?.length ? 1 : 0);

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
        {isAdmin && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="flow-muted" style={{ alignSelf: "center" }}>
              Switch station:
            </span>
            {Object.entries(ROLES).map(([s, c]) => (
              <button
                key={s}
                className={`flow-btn ${s === slug ? "flow-btn-primary" : "flow-btn-ghost"}`}
                onClick={() => navigate(`/flow/station/${s}`)}
              >
                {c.title.replace(/^[^ ]+ /, "")}
              </button>
            ))}
          </div>
        )}

        <StationQueue role={cfg.role} form={cfg.form} />
      </div>
    </div>
  );
}
