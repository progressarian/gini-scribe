// The offline visit queue.
//
// A rep logs a visit standing in a clinic corridor. The brief's rule is that a
// visit note is never lost to a dropped connection, so the save path never
// touches the network first: the visit is written to localStorage, the screen
// says "saved", and the queue drains whenever there is signal.
//
// Correctness rests on one decision made in the schema: the visit id is a UUID
// minted on the CLIENT. Because the server's insert is ON CONFLICT DO NOTHING
// on that id, sending the same visit twice is not a problem to be avoided but a
// no-op — which is what makes "retry until it sticks" a safe strategy rather
// than a duplicate generator.
//
// localStorage rather than IndexedDB: a queued visit is a few hundred bytes,
// the queue is a handful of items deep, and localStorage is synchronous — so a
// visit is durable before the save handler returns, with no await between the
// rep tapping Save and the data being on disk. An async write is a window in
// which the browser can be killed.

const KEY = "crm.visitQueue.v1";
const MAX_ATTEMPT_DELAY = 5 * 60 * 1000;

const now = () => Date.now();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt queue must not brick the screen. Losing an unsent visit is bad;
    // a rep who cannot open the app at all is worse.
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export function queued() {
  return read();
}

export function pendingCount() {
  return read().filter((i) => i.status !== "sent").length;
}

/**
 * Put a visit on the queue. Synchronous and durable before it returns.
 * Re-queuing an id already present replaces it — the rep corrected the visit
 * before it ever left the phone.
 */
export function enqueue(visit) {
  const items = read().filter((i) => i.visit.id !== visit.id);
  items.push({
    visit,
    status: "pending",
    attempts: 0,
    queued_at: now(),
    last_error: null,
    next_attempt_at: 0,
  });
  return write(items);
}

export function remove(id) {
  write(read().filter((i) => i.visit.id !== id));
}

/** Drop everything already confirmed by the server. */
export function prune() {
  write(read().filter((i) => i.status !== "sent"));
}

/**
 * Try to send everything due.
 *
 * `send` is injected rather than imported so the queue can be driven by a
 * mocked transport in tests — including one that fails, times out, or succeeds
 * twice for the same id.
 *
 * Returns counts rather than throwing: a drain that partly fails is normal on a
 * corridor connection and is not an error the UI should shout about.
 */
export async function drain(send, { online = true } = {}) {
  if (!online) return { sent: 0, failed: 0, skipped: pendingCount() };

  const items = read();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.status === "sent") continue;
    if (item.next_attempt_at > now()) {
      skipped++;
      continue;
    }
    try {
      await send(item.visit);
      item.status = "sent";
      item.last_error = null;
      sent++;
    } catch (err) {
      item.attempts += 1;
      item.last_error = err?.message || String(err);
      // Back off, but never so far that a visit sits unsent for a whole shift.
      item.next_attempt_at = now() + Math.min(2 ** item.attempts * 1000, MAX_ATTEMPT_DELAY);
      failed++;
    }
  }

  write(items.filter((i) => i.status !== "sent"));
  return { sent, failed, skipped };
}

/**
 * Drain now, and again whenever the browser regains connectivity.
 * Returns an unsubscribe function.
 */
export function startAutoDrain(send, onChange = () => {}) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await drain(send, { online: navigator.onLine !== false });
      if (result.sent > 0 || result.failed > 0) onChange(pendingCount(), result);
    } finally {
      running = false;
    }
  };

  window.addEventListener("online", run);
  // A phone that was asleep in a pocket fires no `online` event when it wakes
  // with signal back, so visibility is the second trigger.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") run();
  });
  const timer = setInterval(run, 60_000);
  run();

  return () => {
    window.removeEventListener("online", run);
    clearInterval(timer);
  };
}
