// Push scribe-side labs to Genie for TEST_COMPANION_USER.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { syncLabsToGenie } = require("../genie-sync.cjs");

const p = await pool.query("SELECT id FROM patients WHERE file_no=$1", [
  "TEST_COMPANION_USER",
]);
const sid = p.rows[0].id;
console.log(`scribe id=${sid}`);

const t0 = Date.now();
const res = await syncLabsToGenie(sid, pool);
console.log(`syncLabsToGenie (${Date.now() - t0}ms):`, JSON.stringify(res, null, 2));

await pool.end();
