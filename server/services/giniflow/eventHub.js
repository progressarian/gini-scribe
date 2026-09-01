import { randomUUID } from "node:crypto";

// The set of open station screens, and the last few things that happened.
//
// Replay is why this exists rather than a bare write-to-every-socket: a tunnel
// drop or a closed laptop lid must not silently cost a screen an event and
// leave it showing a stale queue with nothing to indicate it. The browser
// resends Last-Event-ID on reconnect and gets whatever it missed.
//
// Ids are `<origin>:<n>`. The origin is unique per process, so an id minted by
// another API instance — or by this one before a restart — is recognised as
// unreplayable and answered with `resync` instead of a wrong replay.

const ORIGIN = randomUUID().slice(0, 8);
const BUFFER = 500;
const MAX_CLIENTS = 100;
const HEARTBEAT_MS = 25_000;

// Railway closes any HTTP response at 15 minutes — a platform maximum that
// cannot be raised (docs/gini-flow/12-REALTIME-PLAN.md section 7). Reaching it
// would end the stream as an error the client has to interpret, so the stream
// is recycled a minute early instead, deliberately and announced. The client
// treats a `bye` as a handover: it stays live, keeps its watermark, and comes
// straight back with a freshly-read token.
const recycleMs = () => Number(process.env.GINIFLOW_SSE_RECYCLE_MS || 14 * 60 * 1000);

let counter = 0;
const recent = [];
const clients = new Set();

const frame = (id, event, data) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const write = (client, text) => {
  // A screen that closed mid-write must never take the tailer down with it.
  try {
    client.res.write(text);
    client.res.flush?.();
  } catch {
    drop(client);
  }
};

function drop(client) {
  clients.delete(client);
  clearInterval(client.heartbeat);
  clearTimeout(client.recycle);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

// A station open on today's floor is not told about a backfill of last week.
const wants = (client, event) => !client.date || !event.date || client.date === event.date;

export function publish({ kind, visitId, status = null, date = null, orderId = null }) {
  const event = {
    id: `${ORIGIN}:${++counter}`,
    kind,
    visitId,
    status,
    orderId,
    date,
  };
  recent.push(event);
  if (recent.length > BUFFER) recent.shift();

  for (const client of clients) {
    if (wants(client, event)) write(client, frame(event.id, "flow", payload(event)));
  }
  return event;
}

// Deliberately thin: no name, no file number, no category. The screen refetches
// through the API it is already authenticated against, so this socket never
// becomes a second, less-guarded way to read patient data.
const payload = (e) => ({
  kind: e.kind,
  visitId: e.visitId,
  status: e.status,
  orderId: e.orderId,
  date: e.date,
});

export function addClient(res, { date = null, lastEventId = null } = {}) {
  if (clients.size >= MAX_CLIENTS) return null;

  const client = { res, date, heartbeat: null, recycle: null };
  clients.add(client);

  // Proxies close a connection that has said nothing for 30-60s, and the
  // browser reports that as a clean disconnect rather than an error.
  client.heartbeat = setInterval(() => write(client, `: ping\n\n`), HEARTBEAT_MS);

  // The planned recycle. Announced first, so the reconnect is a handover rather
  // than something the client has to tell apart from a dropped connection — and
  // so a stream can never carry an authentication that was checked more than
  // RECYCLE_MS ago.
  client.recycle = setTimeout(() => {
    write(client, frame(`${ORIGIN}:${counter}`, "bye", { reason: "recycle", reconnect: true }));
    drop(client);
  }, recycleMs());

  res.write(frame(`${ORIGIN}:${counter}`, "hello", { origin: ORIGIN, date }));

  // Replay, or say plainly that we cannot. `resync` tells the screen to refetch
  // everything, which is the honest answer when the gap is unknowable.
  const missed = replayFrom(lastEventId);
  if (missed === null) {
    if (lastEventId) res.write(frame(`${ORIGIN}:${counter}`, "resync", { reason: "gap" }));
  } else {
    for (const event of missed) {
      if (wants(client, event)) write(client, frame(event.id, "flow", payload(event)));
    }
  }
  res.flush?.();
  return client;
}

function replayFrom(lastEventId) {
  if (!lastEventId) return [];
  const [origin, n] = String(lastEventId).split(":");
  if (origin !== ORIGIN) return null;
  const from = Number(n);
  if (!Number.isFinite(from)) return null;
  // Older than the buffer holds: the gap cannot be described, so say so.
  if (recent.length && Number(recent[0].id.split(":")[1]) > from + 1) return null;
  return recent.filter((e) => Number(e.id.split(":")[1]) > from);
}

export const removeClient = (client) => client && drop(client);

export const hubStatus = () => ({
  origin: ORIGIN,
  clients: clients.size,
  buffered: recent.length,
  recycleMs: recycleMs(),
});
