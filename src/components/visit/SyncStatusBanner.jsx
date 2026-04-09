import { memo } from "react";
import { fmtDate } from "./helpers";

const SyncStatusBanner = memo(function SyncStatusBanner({ syncStatus }) {
  if (!syncStatus) return null;

  const { healthray, labs } = syncStatus;
  const hasHealthraySync = !!healthray;
  const hasLabSync = labs && labs.length > 0;

  // Only show if at least one sync exists
  if (!hasHealthraySync && !hasLabSync) return null;

  return (
    <div className="sync-banner">
      {hasHealthraySync && (
        <div className="sync-item">
          <span className="sync-icon">✅</span>
          <span className="sync-label">HealthRay synced</span>
          <span className="sync-date">{fmtDate(healthray.appointment_date)}</span>
        </div>
      )}
      {hasLabSync && (
        <div className="sync-item">
          <span className="sync-icon">🔬</span>
          <span className="sync-label">Lab reports synced</span>
          <span className="sync-date">
            {labs.length} case{labs.length !== 1 ? "s" : ""}
            {labs[0]?.case_date && ` · ${fmtDate(labs[0].case_date)}`}
          </span>
        </div>
      )}
    </div>
  );
});

export default SyncStatusBanner;
