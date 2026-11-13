const STATUS = {
  stale: {
    label: "Reconnecting…",
    hint: "Connection lost — trying again. What you see may be a little out of date.",
  },
  live: {
    label: "Up to date",
    hint: "Changes appear on this screen straight away.",
  },
  connecting: {
    label: "Connecting…",
    hint: "Getting the latest information.",
  },
  polling: {
    label: "Refreshes every 15 sec",
    hint: "This screen updates itself every 15 seconds. No need to reload.",
  },
};

export default function LiveBadge({ live, stale = false, className = "rail-live" }) {
  const status = stale
    ? STATUS.stale
    : live
      ? STATUS.live
      : live === null
        ? STATUS.connecting
        : STATUS.polling;
  return (
    <span className={`${className}${stale ? " is-stale" : ""}`} title={status.hint}>
      <span className={`live-dot${live && !stale ? "" : " dead"}`} aria-hidden="true" />{" "}
      {status.label}
    </span>
  );
}
