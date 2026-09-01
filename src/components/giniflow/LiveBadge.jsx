// Whether this screen is being told about changes, or is still asking.
//
// A coordinator watching a board that has quietly stopped updating is worse off
// than one who knows it is on a fifteen-second delay, so the state is never
// implied — it is named, in words, next to the dot.
export default function LiveBadge({ live, stale = false, className = "rail-live" }) {
  const label = stale ? "Reconnecting…" : live ? "Live" : "Polling · 15s";
  return (
    <span
      className={`${className}${stale ? " is-stale" : ""}`}
      title={
        live
          ? "Changes on the floor reach this screen within a second"
          : "Live updates are not connected — this screen re-asks every 15 seconds"
      }
    >
      <span className={`live-dot${live && !stale ? "" : " dead"}`} /> {label}
    </span>
  );
}
