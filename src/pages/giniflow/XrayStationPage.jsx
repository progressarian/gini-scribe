import MachineStationPage from "./MachineStationPage";

// X-Ray Station (docs/gini-flow/46-XRAY-STATION-PLAN.md) — split out of the
// Machine Room into its own screen for its own person, same as Echo. Same
// engine as MachineStationPage, scoped to the "xray" station on its own
// capability-gated route (server/routes/giniflowStations.js).
export default function XrayStationPage() {
  return <MachineStationPage station="xray" label="X-Ray Station" />;
}
