import { createClient } from "@supabase/supabase-js";

let client = null;
let warned = false;
let dormantLogged = false;
let billingDormantLogged = false;

// Can the server publish at all?
const supabaseUrl = () => process.env.SUPABASE_URL || "";
const serviceKey = () => process.env.SUPABASE_SERVICE_KEY || "";

const enabled = () => !!(supabaseUrl() && serviceKey());

const browserEnabled = () =>
  !!(process.env.SUPABASE_JWT_SECRET && process.env.SUPABASE_ANON_KEY && supabaseUrl());

function bus() {
  if (!enabled()) return null;
  if (!client) {
    client = createClient(supabaseUrl(), serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 40 } },
    });
  }
  return client;
}

export const dayTopic = (date) => `giniflow:day:${date}`;
export const stationTopic = (station) => `giniflow:station:${station}`;

const channels = new Map();

async function channelFor(topic) {
  const supabase = bus();
  if (!supabase) return null;
  const existing = channels.get(topic);
  if (existing) return existing;

  const channel = supabase.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  });
  const ready = new Promise((resolve) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve(channel);
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        channels.delete(topic);
        resolve(null);
      }
    });
  });
  channels.set(topic, ready);
  return ready;
}
export async function publish(topic, payload) {
  if (!enabled()) {
    if (!warned) {
      warned = true;
      console.log("[giniflow realtime] SUPABASE_URL/SERVICE_KEY unset — SSE only");
    }
    return { published: false, reason: "unconfigured" };
  }
  try {
    const channel = await channelFor(topic);
    if (!channel) return { published: false, reason: "channel_unavailable" };
    await channel.send({ type: "broadcast", event: "giniflow", payload });
    return { published: true };
  } catch (e) {
    console.warn("[giniflow realtime] publish failed:", topic, e?.message);
    return { published: false, reason: e?.message };
  }
}
export function publishEvents(events) {
  if (!browserEnabled()) {
    if (!dormantLogged) {
      dormantLogged = true;
      console.log(
        "[giniflow realtime] dormant — SUPABASE_JWT_SECRET/ANON_KEY unset, so no browser can subscribe. SSE is carrying events.",
      );
    }
    return;
  }
  for (const ev of events || []) {
    if (!ev?.date) continue;
    publish(dayTopic(ev.date), ev).catch(() => {});
  }
}

export const BILLING_REQUESTS_STATION = "billing-requests";

export const billingRequestsTopic = () => stationTopic(BILLING_REQUESTS_STATION);

export async function publishBillingRequest(event) {
  const topics = [billingRequestsTopic(), event?.date ? dayTopic(event.date) : null].filter(
    Boolean,
  );
  if (!browserEnabled()) {
    if (!billingDormantLogged) {
      billingDormantLogged = true;
      console.log(
        "[giniflow realtime] billing requests dormant — SUPABASE_JWT_SECRET/ANON_KEY unset, so the desk and the inbox refresh on their poll.",
      );
    }
    return { published: false, reason: "dormant", topics };
  }
  const results = await Promise.all(topics.map((topic) => publish(topic, event)));
  return { published: results.every((r) => r.published), topics, results };
}

export async function publishNotice(station, notice) {
  const r = await publish(stationTopic(station), { kind: "notice", station, ...notice });
  return { ...r, reachable: browserEnabled() };
}

export function realtimeStatus() {
  return { enabled: enabled(), browserEnabled: browserEnabled(), channels: channels.size };
}
