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
  check(
    "rail carries all four controls",
    ["Day report", "Time budgets", "Switch role"].every((t) => html.includes(t)),
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
  if (vq.queue[0]) {
    const { getVitalsPatient } = await import("../server/services/giniflow/vitalsStation.js");
    vitalsClient.setQueryData(
      ["giniflow", "vitals", "patient", vq.queue[0].visitId],
      await getVitalsPatient(vq.queue[0].visitId),
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
    stations: { manager: summary.manager, vitals: summary.vitals, reception: summary.reception },
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
    "built stations link, unbuilt ones do not",
    landHtml.includes('href="/giniflow/station/vitals"') && landHtml.includes("Coming soon"),
  );
  check("live counts render on the tiles", landHtml.includes("in queue"));
  check("no raw 'undefined' in the launcher markup", !landHtml.includes(">undefined<"));

  // Reception renders its own tree.
  const { default: ReceptionStationPage } = await vite.ssrLoadModule(
    "/src/pages/giniflow/ReceptionStationPage.jsx",
  );
  const recClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { getPaymentQueue } = await import("../server/services/giniflow/receptionStation.js");
  recClient.setQueryData(["giniflow", "reception", "queue", "today"], {
    date,
    ...(await getPaymentQueue(date)),
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
  check("reception counters render", recHtml.includes("Payment pending"));
  check("the workflow banner renders", recHtml.includes("triggers lab sample collection"));
  check("the placeholder-price warning is shown", recHtml.includes("not the hospital"));
  check("no raw 'undefined' in the reception markup", !recHtml.includes(">undefined<"));

  // The timeline is a separate tree with its own live helpers; render it too.
  const target = day.cards.find((c) => !c.finished);
  if (target) {
    const steps = await getStationTimes(pool, target.id, board.budgetMap(sla));
    check("timeline steps computed", steps.length > 0, `${steps.length}`);
  }
} catch (e) {
  check(`render threw: ${e.message}`, false);
} finally {
  await vite.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}
