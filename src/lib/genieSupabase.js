// Browser-side Supabase client for Genie Realtime subscriptions (Lab /
// Reception inboxes). Uses the public anon key — never import the service
// key into browser code.
//
// If the env vars aren't set, we export `null` so callers can fall back to
// polling via the existing /api/messages endpoints.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_GENIE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_GENIE_SUPABASE_ANON_KEY;

export const genieSupabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 5 } },
      })
    : null;

export const hasGenieRealtime = !!genieSupabase;
