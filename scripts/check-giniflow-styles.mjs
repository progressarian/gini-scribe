// Every class a Gini Flow page uses must be defined in a stylesheet that page
// actually imports.
//
// This exists because it happened twice: `.app:has(.gf)` sat in the board's
// sheet, so the vitals queue would not scroll; then the whole rail and stats row
// did the same, so reception rendered unstyled. A rule stranded in a sheet a
// page does not import is invisible to the build, to Prettier and to the render
// smoke — it shows up only as "why does this look wrong".
//
//   node scripts/check-giniflow-styles.mjs
import fs from "fs";

const read = (p) => fs.readFileSync(p, "utf8");
const THEME = "src/styles/giniflow-theme.css";
const BOARD = "src/styles/giniflow.css";
const STATION = "src/styles/giniflow-station.css";

// What each page imports, in load order.
const PAGES = {
  "src/pages/giniflow/FlowManagerPage.jsx": [THEME, BOARD],
  "src/pages/giniflow/VitalsStationPage.jsx": [THEME, STATION],
  "src/pages/giniflow/ReceptionStationPage.jsx": [THEME, STATION],
  "src/pages/giniflow/StationsLauncherPage.jsx": [THEME, STATION],
};

// Class names that come from the app shell or are set by React, not by us.
const IGNORE = new Set(["gf", "show", "active", "open", "listening", "live", "pending", "hot"]);

let failures = 0;

for (const [page, sheets] of Object.entries(PAGES)) {
  const src = read(page);
  const used = new Set();

  for (const m of src.matchAll(/className="([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((c) => c && used.add(c));
  }
  // Template literals: keep the static leading class and any quoted fragments.
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) {
    for (const part of m[1].split(/\$\{[^}]*\}/)) {
      part.split(/\s+/).forEach((c) => c && used.add(c));
    }
  }
  for (const m of src.matchAll(/["'`]([a-z][a-z0-9-]{2,})["'`]/g)) {
    // Quoted class fragments inside ternaries, e.g. ? "tsd-r" : "tsd-g"
    if (/^(tsd|sbio|tmr|sp|b|st-btn|vf|bc)-/.test(m[1])) used.add(m[1]);
  }

  const bundle = sheets.map(read).join("\n");
  const missing = [...used]
    // A trailing dash is the stub left by a ${...} interpolation, not a class.
    .filter((c) => !IGNORE.has(c) && !c.includes(".") && !c.endsWith("-"))
    .filter(
      (c) => !new RegExp(`\\.${c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}[\\s,{:.]`).test(bundle),
    );

  const label = page.split("/").pop().padEnd(26);
  if (missing.length) {
    console.log(
      `FAIL  ${label} ${missing.length} class(es) not in its stylesheets: ${missing.join(", ")}`,
    );
    failures++;
  } else {
    console.log(`  ok  ${label} every class it uses is styled`);
  }
}

console.log(failures ? `\n${failures} page(s) with stranded styles\n` : "\nall pages styled\n");
process.exit(failures ? 1 : 0);
