import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "../../config/storage.js";

// Publishing Gini Flow's live envelopes over Supabase Realtime Broadcast.
//
// docs/gini-flow/21-SUPABASE-REALTIME-PLAN.md §4.2, §4.4
//
// Broadcast, not Postgres Changes: authorisation is RLS on `realtime.messages`
// per topic (migration 2026-09-02_giniflow_realtime_rls.sql) rather than RLS
// over live patient rows, and the server stays the only author.
//
// The payload is byte-for-byte what the SSE stream already sends — the client's
// INVALIDATES map keys off `kind` and nothing else — so during Phase 1 a screen
// can hold both transports and de-duplicate. That is also what makes the Phase 2
// comparison exact rather than a judgement call.
//
// NO PATIENT DATA. Not a style rule: a topic leak must reveal that something
// changed, never what or whose. eventHub established this and it survives the
// change of transport.
//
// UNCONFIGURED IS A NO-OP, deliberately. Realtime is additive in Phase 1 — SSE
// is still carrying every event — so a missing key must degrade to "the old
// path only", never to an error on a clinical write. Same shape as msg91's dev
// fallback and storage's `if (SUPABASE_URL && SUPABASE_SERVICE_KEY)`.

let client = null;
let warned = false;
let dormantLogged = false;

// Can the server publish at all?
const enabled = () => !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// Can any browser actually JOIN the topic? A different question, and the one
// that decides whether publishing is worth doing.
//
// RT-04. The two halves are gated on different secrets, so Phase 1 spent a
// fortnight broadcasting every envelope to topics no browser was authorised to
// subscribe to: messages billed against a subscriber count of zero, and any
// delivery fault invisible because nothing was listening to notice it. Until
// the browser half is configured there is no room to broadcast into, so the
// automatic fan-out stays off and the two halves switch on together.
const browserEnabled = () =>
  !!(process.env.SUPABASE_JWT_SECRET && process.env.SUPABASE_ANON_KEY && SUPABASE_URL);

function bus() {
  if (!enabled()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 40 } },
    });
  }
  return client;
}

export const dayTopic = (date) => `giniflow:day:${date}`;
export const stationTopic = (station) => `giniflow:station:${station}`;

// One channel per topic, kept open. Subscribing per publish would spend a round
// trip on every status change and leak a channel each time.
const channels = new Map();

async function channelFor(topic) {
  const supabase = bus();
  if (!supabase) return null;
  const existing = channels.get(topic);
  if (existing) return existing;

  // `private: true` on BOTH sides or nothing arrives.
  //
  // A private channel is the one Realtime Authorization guards with the RLS
  // policy; a public channel of the same name is a different room. The publisher
  // was opening the public one, so every send returned `{ published: true }` and
  // no subscriber ever heard it — publish success is not delivery, and only an
  // end-to-end test with a real subscriber catches the difference.
  const channel = supabase.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  });
  const ready = new Promise((resolve) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve(channel);
      // A channel that errored is dropped rather than retried in place, so the
      // next publish builds a fresh one instead of pushing into a dead socket.
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        channels.delete(topic);
        resolve(null);
      }
    });
  });
  channels.set(topic, ready);
  return ready;
}

// Fire-and-forget by contract. Every caller is past its COMMIT, and a transport
// that cannot announce a change must never be able to fail the change.
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

// The same envelopes the tailer hands to eventHub, on their day's topic.
//
// Silent while the browser half is unconfigured (RT-04): SSE is still carrying
// every one of these, so the only thing publishing would achieve is billing.
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

// A message no table implies — the coordinator telling a station it is the
// bottleneck (§3). This is the capability the tailer architecture cannot have,
// and the reason the migration is worth doing at all.
//
// Unlike the event fan-out this publishes even while the browser half is off —
// but it says so. A coordinator has to know the difference between "sent" and
// "sent where somebody could hear it"; a green tick over an unreachable desk is
// worse than an honest failure, because they would stop walking over to say it.
export async function publishNotice(station, notice) {
  const r = await publish(stationTopic(station), { kind: "notice", station, ...notice });
  return { ...r, reachable: browserEnabled() };
}

export function realtimeStatus() {
  return { enabled: enabled(), browserEnabled: browserEnabled(), channels: channels.size };
}
