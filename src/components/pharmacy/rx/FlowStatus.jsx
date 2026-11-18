const RX_STAGE = ["doctor_done", "rx_pending", "with_rx"];
const FINISHED = ["dispensed", "exited"];
const STOPPED = ["no_show", "cancelled"];

export function flowTone(status) {
  if (!status) return "none";
  if (status === "pharmacy_pending") return "ready";
  if (RX_STAGE.includes(status)) return "rx";
  if (FINISHED.includes(status)) return "done";
  if (STOPPED.includes(status)) return "none";
  return "early";
}

export default function FlowStatus({ status, label }) {
  return (
    <span className={`prx-status prx-status--${flowTone(status)}`}>
      <span className="prx-status__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
