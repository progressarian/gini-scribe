import { randomUUID } from "node:crypto";

const BUFFER = 500;
const MAX_CLIENTS = 100;
const HEARTBEAT_MS = 25_000;
const recycleMs = () => Number(process.env.GINIFLOW_SSE_RECYCLE_MS || 14 * 60 * 1000);

const frame = (id, event, data) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createHub({
  eventName = "flow",
  shape = (fields) => fields,
  wants = () => true,
  maxClients = MAX_CLIENTS,
} = {}) {
  const origin = randomUUID().slice(0, 8);
  let counter = 0;
  const recent = [];
  const clients = new Set();

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

  function publish(fields) {
    const event = { id: `${origin}:${++counter}`, ...shape(fields) };
    recent.push(event);
    if (recent.length > BUFFER) recent.shift();
    for (const client of clients) {
      if (wants(client, event)) write(client, frame(event.id, eventName, payloadOf(event)));
    }
    return event;
  }

  const payloadOf = ({ id, ...rest }) => rest;

  function replayFrom(lastEventId) {
    if (!lastEventId) return [];
    const [fromOrigin, n] = String(lastEventId).split(":");
    if (fromOrigin !== origin) return null;
    const from = Number(n);
    if (!Number.isFinite(from)) return null;
    // Older than the buffer holds: the gap cannot be described, so say so.
    if (recent.length && Number(recent[0].id.split(":")[1]) > from + 1) return null;
    return recent.filter((e) => Number(e.id.split(":")[1]) > from);
  }

  function addClient(res, { date = null, lastEventId = null } = {}) {
    if (clients.size >= maxClients) return null;

    const client = { res, date, heartbeat: null, recycle: null };
    clients.add(client);

    client.heartbeat = setInterval(() => write(client, `: ping\n\n`), HEARTBEAT_MS);

    client.recycle = setTimeout(() => {
      write(client, frame(`${origin}:${counter}`, "bye", { reason: "recycle", reconnect: true }));
      drop(client);
    }, recycleMs());

    res.write(frame(`${origin}:${counter}`, "hello", { origin, date }));

    const missed = replayFrom(lastEventId);
    if (missed === null) {
      if (lastEventId) res.write(frame(`${origin}:${counter}`, "resync", { reason: "gap" }));
    } else {
      for (const event of missed) {
        if (wants(client, event)) write(client, frame(event.id, eventName, payloadOf(event)));
      }
    }
    res.flush?.();
    return client;
  }

  return {
    publish,
    addClient,
    removeClient: (client) => client && drop(client),
    hubStatus: () => ({
      origin,
      clients: clients.size,
      buffered: recent.length,
      recycleMs: recycleMs(),
    }),
  };
}

const flowHub = createHub({
  eventName: "flow",
  shape: ({ kind, visitId, status = null, date = null, orderId = null }) => ({
    kind,
    visitId,
    status,
    orderId,
    date,
  }),
  wants: (client, event) => !client.date || !event.date || client.date === event.date,
});

export const publish = flowHub.publish;
export const addClient = flowHub.addClient;
export const removeClient = flowHub.removeClient;
export const hubStatus = flowHub.hubStatus;
