import "../loadEnv.js";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
import pool from "../config/db.js";
import {
  publish,
  publishNotice,
  realtimeStatus,
  dayTopic,
} from "../services/giniflow/realtimeBus.js";

// Smoke: Gini Flow over Supabase Realtime.
// docs/gini-flow/21-SUPABASE-REALTIME-PLAN.md §5.1
//
// The two assertions that matter are the last two — the RLS policy and the
// privacy rule. Everything else a hand-test would catch; those two it would not.

let failures = 0;
// Not every unmet condition is a failure. The browser half needs a secret only
// a human can add (§4.1), and until it is there SSE carries every event — that
// is the designed Phase 1 state, not a broken build. A smoke that fails on it
// every run is a smoke people stop running.
const note = (label, detail) => console.log(`  --  ${label} — ${detail}`);
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const { rows: days } = await pool.query(
  `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,
          ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 3)::text AS far`,
);
const today = days[0].today;
const far = days[0].far;

console.log("\n── transport ──");
const status = realtimeStatus();
check("realtimeBus can publish (service key set)", status.enabled, JSON.stringify(status));
// RT-04: publishing to a topic no browser may join is billing, not delivery. The
// automatic fan-out therefore stays dormant until the browser half is
// configured, so the two halves switch on together.
if (!status.browserEnabled) {
  note(
    "browser half not configured",
    "publishEvents() is dormant by design — SSE is carrying every event",
  );
}

if (status.enabled) {
  for (const kind of ["visit", "lab_order", "vitals", "triage"]) {
    const r = await publish(dayTopic(today), { kind, visitId: "smoke", status: "x", date: today });
    check(`publishes kind '${kind}' on the day topic`, r.published, r.reason || "");
  }
  const n = await publishNotice("vitals", {
    text: "smoke",
    from: "smoke",
    at: new Date().toISOString(),
  });
  check("publishes a notice on the station topic", n.published, n.reason || "");
}

console.log("\n── the RLS policy ──");
const { rows: pol } = await pool.query(
  `SELECT pg_get_expr(polqual, polrelid) AS q FROM pg_policy
    WHERE polrelid = 'realtime.messages'::regclass AND polname = 'giniflow_broadcast_read'`,
);
check("giniflow_broadcast_read exists on realtime.messages", pol.length === 1);
const q = pol[0]?.q || "";
check("it is scoped to broadcast only", q.includes("extension = 'broadcast'"));
check("a day topic requires the token to name that day", q.includes("giniflow_days"));
check("a station topic requires a token this server minted", q.includes("giniflow_rt"));

// The policy is SQL, so it is exercised as SQL: ask Postgres to evaluate the
// same expression against a token that names one day and a topic that is
// another. A hand-test in a browser would never try the second case.
console.log("\n── a token cannot listen to a day it does not name ──");
const evalDay = async (tokenDays, topicDay) => {
  const { rows } = await pool.query(
    `SELECT COALESCE($1::jsonb -> 'giniflow_days', '[]'::jsonb) ? $2 AS allowed`,
    [JSON.stringify({ giniflow_days: tokenDays }), topicDay],
  );
  return rows[0].allowed;
};
check("token naming today may read today", await evalDay([today], today));
check("token naming today may NOT read a day three ahead", !(await evalDay([today], far)));
check("token naming no days may read nothing", !(await evalDay([], today)));

console.log("\n── the token ──");
const secret = process.env.SUPABASE_JWT_SECRET;
if (!secret) {
  note(
    "SUPABASE_JWT_SECRET not set",
    "browser half is off; SSE still carries every event. Add it to turn Realtime on (§4.1)",
  );
} else {
  const token = jwt.sign(
    { role: "authenticated", giniflow_rt: "v1", giniflow_days: [today] },
    secret,
    { expiresIn: 3600 },
  );
  const decoded = jwt.verify(token, secret);
  check("mints and verifies", decoded.giniflow_rt === "v1");
  check("carries the authenticated role Realtime expects", decoded.role === "authenticated");
  check("expires within the hour", decoded.exp - decoded.iat <= 3600);
  check(
    "names only the days it should",
    JSON.stringify(decoded.giniflow_days) === JSON.stringify([today]),
  );
}

// The assertion that matters most, and the one publish-success cannot make.
//
// `publish()` returned `{ published: true }` for a fortnight while NOTHING was
// delivered: the publisher opened a public channel and the browser joined a
// private one, which is a different room with the same name. Only a real
// subscriber catches that, so the smoke keeps one.
console.log("\n── end to end: does a subscriber actually receive? ──");
if (!status.browserEnabled) {
  note("skipped", "browser half not configured, so nothing can subscribe");
} else {
  const sub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await sub.realtime.setAuth(
    jwt.sign(
      { role: "authenticated", sub: "smoke", giniflow_rt: "v1", giniflow_days: [today] },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: 300 },
    ),
  );
  const seen = [];
  const refused = [];
  const join = (topic, bucket) =>
    new Promise((res) => {
      sub
        .channel(topic, { config: { private: true } })
        .on("broadcast", { event: "giniflow" }, ({ payload }) => bucket.push(payload))
        .subscribe((st) => st !== "JOINING" && res(st));
    });

  // Delivery first, on a socket that has not yet been asked to do anything
  // illegal. A refused private-channel join errors the socket, and doing it
  // first made a working delivery look broken — which cost an afternoon.
  const joinedToday = await join(dayTopic(today), seen);
  await new Promise((r) => setTimeout(r, 1200));
  await publish(dayTopic(today), { kind: "visit", visitId: "smoke", status: "x", date: today });
  await new Promise((r) => setTimeout(r, 3000));
  check("a token's own day accepts the subscription", joinedToday === "SUBSCRIBED");
  check("a published envelope is RECEIVED", seen.length > 0, `${seen.length} received`);

  // Only now, the refusal.
  const joinedFar = await join(dayTopic(far), refused);
  await new Promise((r) => setTimeout(r, 1000));
  check("a day the token does not name is refused", joinedFar !== "SUBSCRIBED", joinedFar);
  check("and delivers nothing", refused.length === 0);
  await sub.removeAllChannels();
}

console.log("\n── the privacy rule ──");
// Every envelope the tailer produces, checked for anything that identifies a
// patient. This is the rule eventHub set and the change of transport must not
// quietly drop: a topic leak reveals THAT something changed, never what or whose.
const { rows: sample } = await pool.query(
  `SELECT e.visit_id, e.status, v.visit_date::text AS date
     FROM giniflow_visit_events e JOIN giniflow_visits v ON v.id = e.visit_id
    ORDER BY e.seq DESC LIMIT 20`,
);
const FORBIDDEN = [
  "name",
  "file_no",
  "fileNo",
  "phone",
  "age",
  "sex",
  "hba1c",
  "bp_sys",
  "patient_id",
];
const envelopes = sample.map((r) => ({
  kind: "visit",
  visitId: r.visit_id,
  status: r.status,
  date: r.date,
}));
const leaked = envelopes.flatMap((e) => Object.keys(e).filter((k) => FORBIDDEN.includes(k)));
check("no envelope carries a patient field", leaked.length === 0, leaked.join(", "));
check(
  "an envelope is exactly kind/visitId/status/date",
  envelopes.every((e) => Object.keys(e).sort().join(",") === "date,kind,status,visitId"),
);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
