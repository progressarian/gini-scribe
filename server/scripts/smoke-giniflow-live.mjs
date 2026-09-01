// Live updates: the tailer, the hub, and the one property that distinguishes
// this design from a naive socket — a screen that reconnects is told what it
// missed rather than silently carrying a stale queue.
//
//   npm run smoke:giniflow-live   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";
import { addClient, removeClient, publish, hubStatus } from "../services/giniflow/eventHub.js";
import { createLiveConnection } from "../../src/queries/hooks/giniflowLiveConnection.js";
import { pollInterval, setLiveConnected } from "../../src/queries/hooks/giniflowPolling.js";
import {
  startEventTailer,
  stopEventTailer,
  tailerTick,
  tailerWatermarks,
} from "../services/giniflow/eventTailer.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the HTTP response, so the hub can be driven without a server.
const fakeRes = () => {
  const frames = [];
  return {
    frames,
    write: (text) => frames.push(text),
    flush: () => {},
    end: () => {},
    parsed: () =>
      frames
        .filter((f) => f.startsWith("id:"))
        .map((f) => {
          const id = f.match(/^id: (.+)$/m)?.[1];
          const event = f.match(/^event: (.+)$/m)?.[1];
          const data = JSON.parse(f.match(/^data: (.+)$/m)?.[1] || "{}");
          return { id, event, data };
        }),
  };
};

const TEST_DAY = "2019-01-07";
const before = await one(`SELECT count(*)::int AS c FROM flow_visits`);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

// ── The tailer reads what the floor already writes ──────────────────────────
await startEventTailer();
const primed = tailerWatermarks();
check(
  "the tailer starts from where the tables are, not the beginning of time",
  Object.values(primed).every((v) => v > 0),
  JSON.stringify(primed),
);

const screen = fakeRes();
const client = addClient(screen, { date: TEST_DAY });
check("a screen can connect", !!client && hubStatus().clients >= 1);
check(
  "and is greeted, so it knows the connection is open",
  screen.parsed().some((f) => f.event === "hello"),
);

// A real status move, through the same code path every station uses.
const target = await one(
  `SELECT id, current_status FROM giniflow_visits
    WHERE visit_date = $1::date AND current_status = 'checked_in' LIMIT 1`,
  [TEST_DAY],
);
const client2 = await pool.connect();
try {
  await client2.query("BEGIN");
  await advanceStatus(client2, {
    visitId: target.id,
    toStatus: "vitals_pending",
    actorRole: "system",
  });
  await client2.query("COMMIT");
} finally {
  client2.release();
}

await tailerTick(pool);
const seen = screen.parsed().filter((f) => f.event === "flow");
check(
  "a status move reaches the screen",
  seen.some((f) => f.data.visitId === target.id && f.data.status === "vitals_pending"),
  `${seen.length} frames`,
);

// ── The payload is a signal, not a patient ─────────────────────────────────
const frame = seen.find((f) => f.data.visitId === target.id);
check(
  "the frame carries no name, file number or category",
  ["name", "fileNo", "file_no", "category", "age", "sex"].every((k) => !(k in frame.data)),
  Object.keys(frame.data).join(", "),
);

// ── Scoping: today's floor is not told about another day ───────────────────
const otherDay = fakeRes();
const otherClient = addClient(otherDay, { date: "2019-01-08" });
publish({ kind: "visit", visitId: target.id, status: "with_vitals", date: TEST_DAY });
check(
  "a screen open on another day is not told",
  !otherDay.parsed().some((f) => f.event === "flow"),
);
removeClient(otherClient);

// ── Replay: the property a naive socket does not have ──────────────────────
// A screen drops, the floor keeps moving, the screen comes back. Without this
// it would carry a stale queue with nothing to indicate it.
const lastSeen = screen
  .parsed()
  .filter((f) => f.event === "flow")
  .at(-1).id;
removeClient(client);
publish({ kind: "visit", visitId: target.id, status: "vitals_done", date: TEST_DAY });
publish({ kind: "lab_order", visitId: target.id, orderId: "x", status: "paid", date: TEST_DAY });

const reconnected = fakeRes();
const back = addClient(reconnected, { date: TEST_DAY, lastEventId: lastSeen });
const replayed = reconnected.parsed().filter((f) => f.event === "flow");
check(
  "reconnecting replays exactly what was missed",
  replayed.length === 2 && replayed[0].data.status === "vitals_done",
  `${replayed.length} frames`,
);
removeClient(back);

// An id this process never minted cannot be replayed, and says so rather than
// pretending nothing was missed.
const stranger = fakeRes();
const strangerClient = addClient(stranger, { date: TEST_DAY, lastEventId: "deadbeef:9" });
check(
  "an id from another process asks the screen to refetch everything",
  stranger.parsed().some((f) => f.event === "resync"),
);
removeClient(strangerClient);

check("closing a screen releases it", hubStatus().clients === 0, `${hubStatus().clients} open`);

// ── The lab track and vitals have their own streams ────────────────────────
const watcher = fakeRes();
const watching = addClient(watcher, { date: TEST_DAY });
const order = await one(
  `SELECT o.id FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id
    WHERE v.visit_date = $1::date LIMIT 1`,
  [TEST_DAY],
);
if (order) {
  await pool.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role)
     VALUES ($1, 'payment', 'paid', 'reception')`,
    [order.id],
  );
  await tailerTick(pool);
  check(
    "a lab order move reaches the screen too",
    watcher.parsed().some((f) => f.event === "flow" && f.data.kind === "lab_order"),
  );
}
removeClient(watching);
stopEventTailer();

// ── The planned recycle: Railway closes any response at 15 minutes ─────────
// Reaching that ceiling would end the stream as an error the client has to
// interpret. It is recycled a minute early instead, announced, so the reconnect
// is a handover — and so no stream carries an authentication checked longer ago
// than the recycle interval.
process.env.GINIFLOW_SSE_RECYCLE_MS = "300";
const recycled = fakeRes();
const recycling = addClient(recycled, { date: TEST_DAY });
publish({ kind: "visit", visitId: target.id, status: "with_sd", date: TEST_DAY });
const beforeBye = recycled
  .parsed()
  .filter((f) => f.event === "flow")
  .at(-1).id;
await sleep(500);
const bye = recycled.parsed().find((f) => f.event === "bye");
check("the stream is recycled deliberately, before Railway's 15-minute ceiling", !!bye);
check("and says it is a handover, not a failure", bye?.data.reconnect === true, bye?.data.reason);
check(
  "the closing frame carries the watermark, so nothing is missed across it",
  bye?.id === beforeBye,
  `${bye?.id} vs ${beforeBye}`,
);
check("the recycled screen is released", hubStatus().clients === 0);
removeClient(recycling);

// An event published while the screen was away, then a reconnect carrying the
// id the `bye` frame left it with.
publish({ kind: "vitals", visitId: target.id, date: TEST_DAY });
const afterRecycle = fakeRes();
const resumed = addClient(afterRecycle, { date: TEST_DAY, lastEventId: bye.id });
const missedByRecycle = afterRecycle.parsed().filter((f) => f.event === "flow");
check(
  "Last-Event-ID from the recycle replays what happened during the handover",
  missedByRecycle.length === 1 && missedByRecycle[0].data.kind === "vitals",
  `${missedByRecycle.length} replayed`,
);
removeClient(resumed);
delete process.env.GINIFLOW_SSE_RECYCLE_MS;

// ── The client's reconnect policy ──────────────────────────────────────────
// A station tablet is open all day. A deploy, a proxy blip or a tablet waking
// from sleep must come back on its own — there is no give-up, and never two
// connections at once.
class FakeEventSource {
  static open = [];
  static urls = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.open.push(this);
    FakeEventSource.urls.push(url);
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  emit(name, data, lastEventId) {
    this.listeners[name]?.({ data: JSON.stringify(data), lastEventId });
  }
  fail() {
    this.onerror?.();
  }
  close() {
    this.closed = true;
    FakeEventSource.open = FakeEventSource.open.filter((s) => s !== this);
  }
  static live() {
    return FakeEventSource.open.filter((s) => !s.closed);
  }
  static reset() {
    FakeEventSource.open = [];
    FakeEventSource.urls = [];
  }
}

const statuses = [];
const signals = [];
let token = "token-1";
FakeEventSource.reset();
const conn = createLiveConnection({
  url: ({ lastEventId }) =>
    `/api/giniflow/events?token=${token}${lastEventId ? `&lastEventId=${lastEventId}` : ""}`,
  EventSourceImpl: FakeEventSource,
  onSignal: (d) => signals.push(d),
  onStatus: (v) => statuses.push(v),
  // Short and jitter-free so the suite is deterministic; the shape is the same.
  backoff: { baseMs: 10, maxMs: 80, factor: 2, jitter: 0 },
  random: () => 0.5,
});

conn.start();
check("one connection is opened on start", FakeEventSource.live().length === 1);
FakeEventSource.live()[0].emit("hello", { origin: "x" });
check("a greeting marks the screen live", statuses.at(-1) === true);

// Three consecutive failures — the case that used to disable live updates for
// the rest of the day.
for (let i = 0; i < 3; i++) {
  FakeEventSource.live()[0]?.fail();
  await sleep(40);
}
check(
  "three consecutive failures do not disable live updates",
  conn.state().connected || conn.state().pendingReconnect,
  `failures=${conn.state().failures}`,
);
check("and the screen was handed back to polling meanwhile", statuses.includes(false));
check(
  "backoff grows with each failure",
  conn.state().nextDelayMs > 10,
  `${conn.state().nextDelayMs}ms`,
);
check(
  "a reconnect never opens a second connection",
  FakeEventSource.live().length <= 1,
  `${FakeEventSource.live().length} open`,
);

// A successful reconnect must forget the failures, or the next blip would start
// from a long delay.
await sleep(120);
FakeEventSource.live()[0]?.emit("hello", { origin: "x" });
check("a successful reconnect resets the failure state", conn.state().failures === 0);
check(
  "and the next delay is back to the base",
  conn.state().nextDelayMs === 10,
  `${conn.state().nextDelayMs}ms`,
);
check("the screen reads live again", statuses.at(-1) === true);

// The planned recycle, from the client's side.
const liveEventsBefore = statuses.length;
FakeEventSource.live()[0].emit("flow", { kind: "visit", visitId: "v1" }, "origin:7");
check("a signal is delivered", signals.at(-1)?.visitId === "v1");
token = "token-2";
FakeEventSource.live()[0].emit("bye", { reason: "recycle", reconnect: true }, "origin:7");
check(
  "a planned recycle does not report the screen as offline",
  statuses.length === liveEventsBefore,
  "no flicker between Live and Polling",
);
check("and does not count as a failure", conn.state().failures === 0);
await sleep(400);
check("the screen reconnects itself after the recycle", FakeEventSource.live().length === 1);
const reconnectUrl = FakeEventSource.urls.at(-1);
check(
  "the reconnect carries Last-Event-ID, so nothing is missed",
  reconnectUrl.includes("lastEventId=origin%3A7") || reconnectUrl.includes("lastEventId=origin:7"),
  reconnectUrl,
);
check(
  "and authenticates with the token the app holds now",
  reconnectUrl.includes("token=token-2"),
  "not the one held when the screen opened",
);

conn.stop();
check("stopping closes the connection", FakeEventSource.live().length === 0);
check("and hands the screen back to polling", statuses.at(-1) === false);

// ── The fallback the whole design leans on ─────────────────────────────────
setLiveConnected(false);
check(
  "with no live connection the queues poll fast",
  pollInterval() === 15_000,
  `${pollInterval()}ms`,
);
setLiveConnected(true);
check("with one, the poll drops to a safety net", pollInterval() === 60_000, `${pollInterval()}ms`);
setLiveConnected(false);

await cleanDemoDay();
const after = await one(`SELECT count(*)::int AS c FROM flow_visits`);
check("old flow_* module untouched", after.c === before.c, `${before.c}→${after.c}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
