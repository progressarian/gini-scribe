// Finds identifiers a Gini Flow page uses but never defines.
//
// This exists because the same bug shipped three times — `totalOver`,
// `budgetColour`, `FILLED_LABEL` — each time from an edit that renamed or moved
// a helper and left a caller behind. None was caught by anything:
//
//   • `npm run build` bundles without executing, so an undeclared name is fine.
//   • The render smoke executes the page, but only the branches that render
//     server-side. A name used inside `{voice.result && …}` never runs there.
//
// So this walks the syntax tree instead: every identifier that is read, minus
// everything declared, imported, or provided by the runtime. It runs in about a
// second and needs no database.
//
//   node scripts/check-giniflow-undefined.mjs
import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default || _traverse;

// Every Gini Flow page and hook, plus the files that wire them in. `router.jsx`
// belongs here: a page can be perfectly valid and still crash the app because
// its lazy import was never declared — which is exactly what shipped.
const listFiles = (dir) =>
  fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((f) => /\.(jsx?|tsx?)$/.test(f) && fs.statSync(f).isFile());

const FILES = [
  ...listFiles("src/pages/giniflow"),
  ...listFiles("src/queries/hooks").filter((f) => /giniflow/i.test(f)),
  "src/hooks/useVoiceVitals.js",
  "src/router.jsx",
].filter((f) => fs.existsSync(f));

// Browser and standard-library globals a page may legitimately reach for.
const GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "console",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "fetch",
  "Date",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "Promise",
  "Set",
  "Map",
  "Error",
  "RegExp",
  "Intl",
  "localStorage",
  "sessionStorage",
  "MediaRecorder",
  "EventSource",
  "URLSearchParams",
  "encodeURIComponent",
  "decodeURIComponent",
  "Blob",
  "FileReader",
  "SpeechRecognition",
  "webkitSpeechRecognition",
  "ResizeObserver",
  "HTMLElement",
  "Element",
  "AbortController",
  "URL",
  "structuredClone",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "alert",
  "isNaN",
  "parseInt",
  "parseFloat",
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
  "process",
  "arguments",
]);

let failures = 0;

for (const file of FILES) {
  const code = fs.readFileSync(file, "utf8");
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["jsx", "optionalChaining", "nullishCoalescingOperator", "classProperties"],
  });

  const missing = new Map();

  traverse(ast, {
    ReferencedIdentifier(p) {
      const name = p.node.name;
      if (GLOBALS.has(name)) return;
      // JSX element names resolve as identifiers too; a lowercase one is an HTML
      // tag, not a binding.
      if (p.parent.type === "JSXOpeningElement" && /^[a-z]/.test(name)) return;
      if (p.scope.hasBinding(name, true)) return;
      if (!missing.has(name)) missing.set(name, p.node.loc?.start.line ?? 0);
    },
  });

  const label = file.split("/").pop().padEnd(28);
  if (missing.size) {
    failures++;
    console.log(
      `FAIL  ${label} ${[...missing].map(([n, line]) => `${n} (line ${line})`).join(", ")}`,
    );
  } else {
    console.log(`  ok  ${label} every identifier is defined`);
  }
}

console.log(
  failures ? `\n${failures} file(s) with undefined identifiers\n` : "\nno undefined identifiers\n",
);
process.exit(failures ? 1 : 0);
