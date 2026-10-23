import { Navigate } from "react-router-dom";
import DeskRequestsInbox from "../../components/billing/DeskRequestsInbox";
import { useApprovalAccess } from "../../queries/hooks/useApprovals";

export default function DeskRequestsHome() {
  const access = useApprovalAccess();
  if (!access.any) return <Navigate to="/" replace />;
  return (
    <main className="dri-home">
      <header className="dri-home__head">
        <h1 className="dri-home__title">Desk requests</h1>
        <p className="dri-home__sub">
          Refunds, items to add, repeat billing, test cancellations and bookings over a slot's
          patient limit, waiting for an admin.
        </p>
      </header>
      <DeskRequestsInbox />
    </main>
  );
}
