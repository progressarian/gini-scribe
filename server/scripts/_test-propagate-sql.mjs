import "../loadEnv.js";
import pool from "../config/db.js";
import { appRowsForPhone } from "../services/patientAppUnlinks.js";

const phone = "1234567890";
const appRows = await appRowsForPhone(phone);
console.log("app DB rows on test phone:", appRows.length);
if (appRows.length) {
  console.log("refusing: the app DB branch would write real rows");
  process.exit(1);
}

const seen = [];
const realQuery = pool.query.bind(pool);
pool.query = (text, params) => {
  if (/^\s*UPDATE patients/i.test(text)) {
    seen.push(text);
    return realQuery(`EXPLAIN ${text}`, params);
  }
  return realQuery(text, params);
};

const { propagateToAllRows } = await import("../routes/patientAuth.js");
const errs = [];
const origErr = console.error;
console.error = (...a) => errs.push(a.map(String).join(" "));
await propagateToAllRows(phone, { otp_code: null, otp_expires_at: null });
console.error = origErr;

console.log("UPDATE statements planned:", seen.length);
console.log(seen[0]?.replace(/\s+/g, " ").trim());
console.log(
  errs.length ? `ERRORS: ${errs.join(" | ")}` : "no errors — SQL and parameter numbering are valid",
);
await pool.end();
