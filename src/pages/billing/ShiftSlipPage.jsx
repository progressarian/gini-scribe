import { Link, useParams } from "react-router-dom";
import { Printer } from "lucide-react";
import { useShiftHandover } from "../../queries/hooks/useStaffDashboard";
import { errorOf } from "../../components/billing/format";
import HandoverSlip from "../../components/billing/staff/HandoverSlip";
import "./shiftSlip.css";

export default function ShiftSlipPage() {
  const { id } = useParams();
  const { data, isLoading, isError, error } = useShiftHandover(id);
  if (isLoading) return <main className="slip slip--status">Loading the handover…</main>;
  if (isError) {
    return (
      <main className="slip slip--status" role="alert">
        {errorOf(error, "Could not load this shift's handover")}{" "}
        <Link to="/giniflow/station/reception?tab=shift">Back to the counter</Link>
      </main>
    );
  }
  return (
    <main className="slip">
      <div className="slip-actions">
        <button type="button" className="slip-print" onClick={() => window.print()}>
          <Printer size={14} aria-hidden="true" /> Print
        </button>
      </div>
      <HandoverSlip data={data} />
    </main>
  );
}
