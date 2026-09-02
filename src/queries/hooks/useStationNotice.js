import { useEffect, useState } from "react";
import { createRealtimeConnection } from "../../lib/giniflowRealtime";

// A message the coordinator sends to this station.
//
// docs/gini-flow/21-SUPABASE-REALTIME-PLAN.md §3
//
// The one thing the event tailer could never carry: "the vitals queue is 40
// minutes over budget, look at it now" is not a row in any table, it is a person
// speaking. So it arrives on its own topic rather than as a table change.
//
// NOT PERSISTED, and the banner says so. A station screen opened after the
// notice was sent will never see it — that was open question 3 in the plan and
// this is the answer it ships with: a bottleneck is true for the next ten
// minutes, so a notice that outlived its moment would be worse than none. If it
// ever has to survive a reload it needs a table, and stops being a broadcast.

export function useStationNotice(station) {
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!station || typeof window === "undefined") return undefined;
    if (!localStorage.getItem("gini_auth_token")) return undefined;

    const conn = createRealtimeConnection({
      station,
      onNotice: (payload) => setNotice({ ...payload, id: `${payload.at}-${Math.random()}` }),
    });
    conn.start();
    return () => conn.stop();
  }, [station]);

  return { notice, dismiss: () => setNotice(null) };
}
