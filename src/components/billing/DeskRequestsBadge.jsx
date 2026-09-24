import { usePendingDeskRequests } from "../../queries/hooks/useBillingRequests";

export default function DeskRequestsBadge() {
  const { data = [] } = usePendingDeskRequests();
  if (!data.length) return null;
  return (
    <span className="set__tab-badge" aria-label={`${data.length} waiting`}>
      {data.length}
    </span>
  );
}
