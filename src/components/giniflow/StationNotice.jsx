import { useStationNotice } from "../../queries/hooks/useStationNotice";

// The coordinator's message, on the station's own screen.
//
// Deliberately a banner and not a toast: a toast is for something you did, and
// this is something somebody else did to you. It stays until dismissed, because
// the whole point is that a desk which is not being watched gets told.
export default function StationNotice({ station }) {
  const { notice, dismiss } = useStationNotice(station);
  if (!notice) return null;

  const at = notice.at
    ? new Date(notice.at).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : null;

  return (
    <div className="st-notice" role="status">
      <span className="stn-ico" aria-hidden="true">
        📣
      </span>
      <span className="stn-body">
        <strong>{notice.text}</strong>
        <span className="stn-from">
          {notice.from || "Coordinator"}
          {at ? ` · ${at}` : ""}
        </span>
      </span>
      <button type="button" className="stn-x" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
