// The reconnect policy behind the live-updates hook, kept free of React and of
// any browser import so it can be driven directly by the smoke suite.
//
// Two kinds of disconnect, treated differently:
//
//   Planned — the server recycles the stream at ~14 minutes, deliberately, to
//   stay inside Railway's 15-minute HTTP ceiling. It announces this with a
//   `bye` frame first. The screen is still live through the handover, so the
//   badge must not flicker and the backoff must not grow.
//
//   Unexpected — a deploy, a proxy blip, a tablet waking from sleep. The screen
//   is genuinely not live, polling takes back over, and we retry with backoff
//   until it works. There is no give-up: a station left open all day has to
//   come back on its own, without anybody reloading the page.
//
// Exactly one EventSource exists at a time. `open()` refuses to build a second,
// and a reconnect is never scheduled while one is already pending.

const DEFAULT_BACKOFF = { baseMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.25 };

// Long enough that the closing frame has been delivered, short enough that the
// gap is invisible on the floor.
const PLANNED_GAP_MS = 250;

export function createLiveConnection({
  url,
  EventSourceImpl,
  onSignal = () => {},
  onResync = () => {},
  onStatus = () => {},
  backoff = {},
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const cfg = { ...DEFAULT_BACKOFF, ...backoff };

  let source = null;
  let timer = null;
  let failures = 0;
  let opens = 0;
  let lastEventId = null;
  let stopped = true;

  const delayFor = (attempt) => {
    const flat = Math.min(cfg.maxMs, cfg.baseMs * cfg.factor ** Math.max(0, attempt - 1));
    // Jitter keeps a fleet of tablets from reconnecting in lockstep after a
    // deploy, which would arrive as one burst.
    const spread = flat * cfg.jitter;
    return Math.round(flat - spread + random() * spread * 2);
  };

  const closeSource = () => {
    if (!source) return;
    try {
      source.close();
    } catch {
      /* already gone */
    }
    source = null;
  };

  const schedule = (delay) => {
    if (stopped || timer) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      open();
    }, delay);
  };

  function open() {
    if (stopped || source) return;
    opens += 1;
    // Built fresh every time, so a reconnect carries the token the app holds
    // now — not the one it held when the screen was first opened.
    source = new EventSourceImpl(url({ lastEventId }));

    source.addEventListener("hello", () => {
      failures = 0;
      onStatus(true);
    });

    source.addEventListener("flow", (e) => {
      if (e.lastEventId) lastEventId = e.lastEventId;
      try {
        onSignal(JSON.parse(e.data));
      } catch {
        onResync();
      }
    });

    source.addEventListener("resync", (e) => {
      if (e.lastEventId) lastEventId = e.lastEventId;
      onResync();
    });

    // The planned recycle. The stream is about to end on purpose, so this is a
    // handover, not an outage: stay live, keep the watermark, come straight
    // back. Failures are untouched, so a recycle cannot push us into backoff.
    source.addEventListener("bye", (e) => {
      if (e.lastEventId) lastEventId = e.lastEventId;
      closeSource();
      schedule(PLANNED_GAP_MS);
    });

    // The server is at capacity. Not a failure of this screen, but it is not
    // live either — wait a while rather than hammering.
    source.addEventListener("full", () => {
      closeSource();
      onStatus(false);
      schedule(cfg.maxMs);
    });

    source.onerror = () => {
      // Our own retry owns reconnection, so the EventSource's built-in one is
      // stopped here — two retry loops would open two connections.
      closeSource();
      onStatus(false);
      schedule(delayFor(++failures));
    };
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      open();
    },
    stop() {
      stopped = true;
      clearTimeoutImpl(timer);
      timer = null;
      closeSource();
      onStatus(false);
    },
    // A tablet waking from sleep should not sit out the rest of its backoff.
    reconnectNow() {
      if (stopped || source) return;
      clearTimeoutImpl(timer);
      timer = null;
      failures = 0;
      open();
    },
    state: () => ({
      connected: !!source,
      failures,
      opens,
      lastEventId,
      pendingReconnect: !!timer,
      nextDelayMs: delayFor(failures + 1),
    }),
  };
}
