import { useEffect, useState } from "react";

// Recomputed from the timestamp on every tick rather than incremented, so a
// screen left open at a station all day self-corrects instead of drifting. Same
// rule as the board (GF-09): a queue timer that only moves when the 15s poll
// lands reads as frozen.
export const useTick = (intervalMs = 1000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

export const minutesSince = (iso, now = Date.now()) =>
  iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000)) : null;

// The same three-way rule the server applies, so a card the board has turned red
// is red at every station too. Returns the one-letter tone the `si-tmr-*`
// classes are keyed on.
export const budgetColour = (minutes, budget) => {
  if (!budget) return "neutral";
  const pct = (minutes / budget) * 100;
  if (pct > 100) return "r";
  if (pct >= 80) return "a";
  return "g";
};
