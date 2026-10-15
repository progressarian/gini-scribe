import { useCancelRequests } from "../../queries/hooks/useTestCancelRequests";

export default function TestCancellationsBadge() {
  const { data } = useCancelRequests({ status: "pending", limit: 1 });
  const waiting = data?.waiting ?? 0;
  if (!waiting) return null;
  return (
    <span className="set__tab-badge" aria-label={`${waiting} waiting`}>
      {waiting}
    </span>
  );
}
