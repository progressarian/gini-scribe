// How often a Gini Flow queue re-asks when nothing has told it to.
//
// With live updates connected the screen is told within a second, so the poll
// drops to a slow safety net — it exists only to repair a connection that is
// open but silently delivering nothing, which does happen behind corporate
// proxies. Without them it is the only thing keeping the floor current, so it
// stays at the interval it has always been.
//
// A module-level flag rather than context: every Gini Flow screen has exactly
// one live connection, and threading a prop through five hooks to say the same
// thing would be worse.

const FAST_MS = 15_000;
const SLOW_MS = 60_000;

let connected = false;

export const setLiveConnected = (value) => {
  connected = !!value;
};

export const pollInterval = () => (connected ? SLOW_MS : FAST_MS);
