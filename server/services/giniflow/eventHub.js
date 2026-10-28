import { randomUUID } from "node:crypto";

const ORIGIN = randomUUID().slice(0, 8);
const BUFFER = 500;
const MAX_CLIENTS = 100;
const HEARTBEAT_MS = 25_000;
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

  client.heartbeat = setInterval(() => write(client, `: ping\n\n`), HEARTBEAT_MS);

  client.recycle = setTimeout(() => {
    write(client, frame(`${ORIGIN}:${counter}`, "bye", { reason: "recycle", reconnect: true }));
    drop(client);
  }, recycleMs());

  res.write(frame(`${ORIGIN}:${counter}`, "hello", { origin: ORIGIN, date }));

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
