import MachineStationPage from "./MachineStationPage";

// Echo Station (docs/gini-flow/45-ECHO-STATION-PLAN.md) — 2D Echo, split out of
// the Machine Room into its own screen for its own person. Same engine as
// MachineStationPage, scoped to the "echo" station on its own capability-gated
// route (server/routes/giniflowStations.js).
export default function EchoStationPage() {
  return <MachineStationPage station="echo" label="Echo Station" />;
}
