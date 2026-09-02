import "../loadEnv.js";
import { publishNotice, realtimeStatus } from "../services/giniflow/realtimeBus.js";

// Send a notice to a station screen, by hand.
//
//   node scripts/giniflow-send-notice.mjs vitals "12 waiting, 40 min over budget"
//
// For testing the banner without waiting for the floor to produce a real
// bottleneck. The board's own button (FlowManagerPage → "Notify stations") is
// the path staff use; this is the same publish underneath it.

const [station, ...rest] = process.argv.slice(2);
const text = rest.join(" ").trim();

if (!station || !text) {
  console.error(
    'Usage: node scripts/giniflow-send-notice.mjs <station> "<message>"\n' +
      "  station: vitals | mo | doctor | lab | reception | pharmacy",
  );
  process.exit(2);
}

const status = realtimeStatus();
console.log("realtime:", JSON.stringify(status));

const r = await publishNotice(station, { text, from: "script", at: new Date().toISOString() });
console.log("result:", JSON.stringify(r));

if (r.published && !r.reachable) {
  // The distinction the notify endpoint now reports, said the same way here:
  // published is not delivered while no browser may join the topic.
  console.log(
    "\n⚠ Published, but no browser can subscribe yet — SUPABASE_JWT_SECRET / SUPABASE_ANON_KEY are unset.\n" +
      "  The station screen will NOT show this. Add both secrets and re-run.",
  );
} else if (r.published) {
  console.log(`\n✓ Sent. A ${station} station screen that is open should show the banner now.`);
} else {
  console.log(`\n✗ Not published: ${r.reason}`);
}

process.exit(0);
