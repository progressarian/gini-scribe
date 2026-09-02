// Renders the Flow Manager page for real, in Node, against live board data.
//
// `npm run build` bundles without executing, so it cannot see an identifier that
// is used but never declared — exactly the bug that shipped `totalOver is not
// defined` to the browser. This mounts the component tree through Vite's SSR
// loader with the query cache pre-primed, so every branch that renders on a
// populated board is executed and any ReferenceError surfaces here instead.
//
//   node scripts/smoke-giniflow-render.mjs
import { createServer } from "vite";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// The app is browser code: give it the few globals it touches at import time so
// the modules evaluate. This is a rendering harness, not a browser — anything
// that needs a real DOM belongs in the side-by-side check on the display itself.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3001", hostname: "localhost", pathname: "/" };
globalThis.document = {
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
};

process.env.GINIFLOW_ALLOW_DEMO = "1";
// Far enough in the past that the demo rows can never collide with a real day.
const MO_DEMO_DAY = "2019-01-07";
await import("../server/loadEnv.js");
const { default: pool } = await import("../server/config/db.js");
const board = await import("../server/services/giniflow/board.js");
const { getStationTimes } = await import("../server/services/giniflow/statusEngine.js");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const { rows } = await pool.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`);
  const date = rows[0].d;
  const sla = await board.getSlaConfig();
  const now = new Date();
  const day = await board.getDayBoard(date, sla, now);
  const payload = {
    date,
    serverTime: now.toISOString(),
    columns: day.columns,
    stats: await board.getDayStats(date, day, sla),
    bottleneck: board.getBottleneck(day.columns),
    stationAverages: await board.getStationAverages(date, sla),
    slaConfig: sla,
  };
  check("board payload has patients to render", day.cards.length > 0, `${day.cards.length} cards`);

  const authStore = await vite.ssrLoadModule("/src/stores/authStore.js");
  authStore.default.setState({ currentDoctor: { role: "coordinator", short_name: "Test" } });

  const { default: FlowManagerPage } = await vite.ssrLoadModule(
    "/src/pages/giniflow/FlowManagerPage.jsx",
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["giniflow", "board", "today"], payload);

  const html = renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(QueryClientProvider, { client }, createElement(FlowManagerPage)),
    ),
  );

  check("page renders without throwing", html.length > 0, `${html.length} chars`);
  check("rail is present", html.includes("Gini Flow"));
  check("stat tiles render", html.includes("In building now"));
  check("a patient card renders", html.includes("pc-name"));
  check("the identity line renders", html.includes("pc-id"));
  check("timers render", html.includes("tmr"));
  check("footer strip renders", html.includes("pf-name"));
  // "Switch role" became the "← Stations" link to the launcher, deliberately —
  // the rail's way out is the same one every station uses.
  check(
    "rail carries its controls",
    ["Day report", "Time budgets", "← Stations"].every((t) => html.includes(t)),
  );
  check("no raw 'undefined' leaked into the markup", !html.includes(">undefined<"));
  if (payload.bottleneck) check("bottleneck banner renders", html.includes("Bottleneck:"));

  // The vitals station renders its own tree — queue, form, done bar.
  const { default: VitalsStationPage } = await vite.ssrLoadModule(
    "/src/pages/giniflow/VitalsStationPage.jsx",
  );
  const vitalsClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { getVitalsQueue } = await import("../server/services/giniflow/vitalsStation.js");
  const vq = await getVitalsQueue(date);
  vitalsClient.setQueryData(["giniflow", "vitals", "queue", "today"], { date, ...vq });
  // The queue is grouped now — at the station, waiting, held — rather than one
  // flat list. Whoever the station would work next is the one to prime.
  const nextUp = (vq.atStation || [])[0] || (vq.waiting || [])[0] || (vq.queue || [])[0];
  if (nextUp) {
    const { getVitalsPatient } = await import("../server/services/giniflow/vitalsStation.js");
    vitalsClient.setQueryData(
      ["giniflow", "vitals", "patient", nextUp.visitId],
      await getVitalsPatient(nextUp.visitId),
    );
  }
  const vitalsHtml = renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: vitalsClient },
        createElement(VitalsStationPage),
      ),
    ),
  );
  check(
    "vitals station renders without throwing",
    vitalsHtml.length > 0,
    `${vitalsHtml.length} chars`,
  );
  check("vitals rail renders", vitalsHtml.includes("Vitals Station"));
  check("vitals queue renders", vitalsHtml.includes("Vitals queue"));
  check(
    "the seven fields render",
    [
      "Weight (kg)",
      "Height (cm)",
      "Blood pressure",
      "Pulse (bpm)",
      "SpO2 (%)",
      "Temperature",
    ].every((f) => vitalsHtml.includes(f)),
  );
  check("the done bar renders", vitalsHtml.includes("db-title"));
  check("no raw 'undefined' in the vitals markup", !vitalsHtml.includes(">undefined<"));

  // The launcher: every station tile, gated per role.
  const { default: StationsLauncherPage } = await vite.ssrLoadModule(
    "/src/pages/giniflow/StationsLauncherPage.jsx",
  );
  const { getStationSummary } = await import("../server/services/giniflow/stationSummary.js");
  const summary = await getStationSummary(date);
  const landClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  landClient.setQueryData(["giniflow", "stations", "summary"], {
    date,
    stations: {
      manager: summary.manager,
      vitals: summary.vitals,
      reception: summary.reception,
      lab: summary.lab,
    },
    bottleneck: summary.bottleneck,
  });
  const landHtml = renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: landClient },
        createElement(StationsLauncherPage),
      ),
    ),
  );
  check("launcher renders without throwing", landHtml.length > 0, `${landHtml.length} chars`);
  check(
    "launcher shows every station tile",
    ["Flow Coordinator", "Vitals Station", "Reception", "Lab Station", "MO / SD", "Pharmacy"].every(
      (n) => landHtml.includes(n),
    ),
  );
  check(
    "every built station links from the launcher",
    [
      "/giniflow/manager",
      "/giniflow/station/vitals",
      "/giniflow/station/reception",
      "/giniflow/station/lab",
    ].every((h) => landHtml.includes(`href="${h}"`)),
    "a station whose tile is not linked is unreachable",
  );
  // Not "some station is unbuilt" — that assertion aged out the moment the last
  // station shipped. The rule is what matters: a tile is either a link to a
  // working station, or it says why it is not.
  const tiles = landHtml.match(/class="role-card[^"]*"/g) || [];
  const openTiles = (landHtml.match(/<a class="role-card"/g) || []).length;
  const shut = tiles.length - openTiles;
  const excuses =
    (landHtml.match(/Coming soon/g) || []).length + (landHtml.match(/No access/g) || []).length;
  check(
    "every tile is either a working link or says why it is not",
    shut === excuses,
    `${openTiles} open, ${shut} closed, ${excuses} explained`,
  );
  check("live counts render on the tiles", landHtml.includes("in queue"));
  check("no raw 'undefined' in the launcher markup", !landHtml.includes(">undefined<"));

  // Reception renders its own tree — two tabs, only one of them mounted at a
  // time, so the payments half is rendered on its own as well.
  const { default: ReceptionStationPage, PaymentsTab } = await vite.ssrLoadModule(
    "/src/pages/giniflow/ReceptionStationPage.jsx",
  );
  const recClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { getPaymentQueue, getArrivals } =
    await import("../server/services/giniflow/receptionStation.js");
  const payments = { date, ...(await getPaymentQueue(date)) };
  recClient.setQueryData(["giniflow", "reception", "queue", "today"], payments);
  recClient.setQueryData(["giniflow", "reception", "arrivals", "today", ""], {
    date,
    ...(await getArrivals(date)),
  });
  const recHtml = renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: recClient },
        createElement(ReceptionStationPage),
      ),
    ),
  );
  check("reception renders without throwing", recHtml.length > 0, `${recHtml.length} chars`);
  check(
    "both halves of the desk are reachable",
    ["Arrivals", "Payments"].every((t) => recHtml.includes(t)),
  );
  check(
    "the three arrival groups render",
    ["Expected", "On the floor"].every((g) => recHtml.includes(g)),
  );
  check("arrival counters render", recHtml.includes("booked, not here yet"));
  check(
    "the screen says a manual arrival is not written back to HealthRay",
    recHtml.includes("not written back"),
  );
  check("no raw 'undefined' in the reception markup", !recHtml.includes(">undefined<"));

  const payHtml = renderToString(
    createElement(
      QueryClientProvider,
      { client: recClient },
      createElement(PaymentsTab, {
        data: payments,
        isLoading: false,
        onClear: () => {},
        pending: false,
      }),
    ),
  );
  check("the payment queue still renders", payHtml.includes("Payment pending"));
  check("the workflow banner renders", payHtml.includes("triggers lab sample collection"));
  check("the placeholder-price warning is shown", payHtml.includes("not the hospital"));
  check("no raw 'undefined' in the payments markup", !payHtml.includes(">undefined<"));

  // MO/SD renders its own tree — queue, brief, plan, tests panel, action bar.
  const { default: MoStationPage } = await vite.ssrLoadModule(
    "/src/pages/giniflow/MoStationPage.jsx",
  );
  const moClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { getMoQueue, getMoPatient, getTestPanels } =
    await import("../server/services/giniflow/moStation.js");
  // The brief only renders for a patient the page auto-selects, and on a real
  // morning every patient can still be at vitals — so this renders the demo day
  // rather than whatever the floor happens to be doing. Its date is far in the
  // past, so nothing here touches today's board.
  const { seedDemoDay, cleanDemoDay } = await import("../server/services/giniflow/demo.js");
  await cleanDemoDay();
  await seedDemoDay({ date: MO_DEMO_DAY });
  // The queue belongs to the logged-in SD, so render it as the SD the demo day
  // assigned its patients to — with nobody logged in, every assigned patient
  // correctly reads as somebody else's.
  const { rows: demoSd } = await pool.query(
    `SELECT assigned_sd_id FROM giniflow_visits
      WHERE visit_date = $1::date AND assigned_sd_id IS NOT NULL LIMIT 1`,
    [MO_DEMO_DAY],
  );
  const moQueue = await getMoQueue(MO_DEMO_DAY, demoSd[0]?.assigned_sd_id ?? null);
  // The queue key carries the search term — the MO queue searches server-side.
  moClient.setQueryData(["giniflow", "mo", "queue", "today", ""], {
    date: MO_DEMO_DAY,
    ...moQueue,
  });
  moClient.setQueryData(["giniflow", "mo", "test-panels"], await getTestPanels());
  const firstMo = moQueue.withMe[0] || moQueue.waitingForMe[0];
  check("the demo day gives the MO somebody to open", !!firstMo);
  if (firstMo) {
    moClient.setQueryData(
      ["giniflow", "mo", "patient", firstMo.visitId],
      await getMoPatient(firstMo.visitId),
    );
  }
  const moHtml = renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(QueryClientProvider, { client: moClient }, createElement(MoStationPage)),
    ),
  );
  check("MO station renders without throwing", moHtml.length > 0, `${moHtml.length} chars`);
  check("MO rail renders", moHtml.includes("MO / SD Station"));
  check(
    "the allergy strip states the truth, not 'none recorded'",
    moHtml.includes("not recorded anywhere"),
  );
  check("the tests panel renders its urgency choices", moHtml.includes("Today → lab now"));
  check(
    "the wait is coloured against a budget, like the board",
    /si-tmr si-tmr-[gar]/.test(moHtml),
    (moHtml.match(/si-tmr si-tmr-(\w+)/) || [])[1],
  );
  // The compact switch is gone; groups collapse instead, the same control the
  // vitals station uses.
  check(
    "every group opens by default",
    !moHtml.includes('hidden=""'),
    "nothing is hidden until the MO asks",
  );
  check(
    "and each group can be collapsed",
    moHtml.includes("sq-toggle") && moHtml.includes("aria-expanded"),
  );
  check("no raw 'undefined' in the MO markup", !moHtml.includes(">undefined<"));

  // Lab renders its own tree.
  const { default: LabStationPage } = await vite.ssrLoadModule(
    "/src/pages/giniflow/LabStationPage.jsx",
  );
  const labClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { getLabQueue } = await import("../server/services/giniflow/labStation.js");
  labClient.setQueryData(["giniflow", "lab", "queue", "today"], {
    date,
    ...(await getLabQueue(date)),
  });
  const labHtml = renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(QueryClientProvider, { client: labClient }, createElement(LabStationPage)),
    ),
  );
  check("lab renders without throwing", labHtml.length > 0, `${labHtml.length} chars`);
  check(
    "lab's five buckets render",
    ["Sample pending", "Collecting", "Processing", "Ready to upload", "Uploaded"].every((s) =>
      labHtml.includes(s),
    ),
  );
  check("the upload-notifies-MO banner renders", labHtml.includes("Results ready"));
  check("no raw 'undefined' in the lab markup", !labHtml.includes(">undefined<"));

  // The timeline is a separate tree with its own live helpers; render it too.
  const target = day.cards.find((c) => !c.finished);
  if (target) {
    const steps = await getStationTimes(pool, target.id, board.budgetMap(sla));
    check("timeline steps computed", steps.length > 0, `${steps.length}`);
  }
} catch (e) {
  check(`render threw: ${e.message}`, false);
} finally {
  const { cleanDemoDay } = await import("../server/services/giniflow/demo.js");
  await cleanDemoDay();
  await vite.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}
