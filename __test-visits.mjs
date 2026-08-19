import puppeteer from "puppeteer";
const SHOT =
  "/tmp/claude-1000/-home-sahil-Documents-Project-Gurjot-gini-scribe/68e72f9d-ff0e-45ca-8194-fb2b0fdea896/scratchpad";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};
const record = {
  patient: {
    name: "Gunamay Marwaha",
    file_no: "P_175126",
    phone: "9876510000",
    sex: "Male",
    age: 51,
  },
  documents: [],
  visits: [
    {
      id: 1,
      appointment_date: "2026-08-19",
      time_slot: "08:50",
      doctor_name: "Dr. Simranpreet Kaur",
      assigned_mo: null,
      visit_type: "Follow-Up",
    },
    {
      id: 2,
      appointment_date: "2026-08-18",
      time_slot: "10. 4:30-5PM",
      doctor_name: "Dr. Anil Bhansali",
      assigned_mo: "Dr. Beant",
      visit_type: "OPD",
    },
    {
      id: 3,
      appointment_date: "2025-05-30",
      time_slot: "10:05",
      doctor_name: "Dr. Beant Sidhu",
      assigned_mo: null,
      visit_type: "New Patient",
    },
  ],
};
const b = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 800 });
await p.setRequestInterception(true);
p.on("request", (r) => {
  if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: CORS });
  if (r.url().includes("/api/ghm-patient-record/"))
    return r.respond({
      status: 200,
      contentType: "application/json",
      headers: CORS,
      body: JSON.stringify(record),
    });
  r.continue();
});
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => {
  if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errs.push(m.text());
});
await p.goto("http://127.0.0.1:5599/harness.html", { waitUntil: "networkidle0" });
await p.click("#open");
await p.waitForSelector(".prm__tab", { timeout: 5000 });
await p.evaluate(() =>
  [...document.querySelectorAll(".prm__tab")].find((t) => t.innerText.includes("Visits")).click(),
);
await p.waitForSelector(".prm-tbl", { timeout: 5000 });
await new Promise((r) => setTimeout(r, 300));
const out = await p.evaluate(() => ({
  headers: [...document.querySelectorAll(".prm-tbl th")].map((t) => t.innerText.trim()),
  firstRow: [...document.querySelectorAll(".prm-tbl tbody tr")[0].children].map((c) =>
    c.innerText.trim(),
  ),
  rows: document.querySelectorAll(".prm-tbl tbody tr").length,
  colCount: document.querySelectorAll(".prm-tbl tbody tr")[0].children.length,
}));
console.log(out);
console.log("errors:", errs.length ? errs : "none");
await p.screenshot({ path: `${SHOT}/prm-visits.png` });
const fail = [];
const H = out.headers.map((h) => h.toLowerCase());
if (H.includes("came?")) fail.push("Came? column still present");
if (H.includes("condition")) fail.push("Condition column still present");
if (H.join(",") !== "date,slot,doctor,mo,type") fail.push(`headers: ${out.headers}`);
if (out.colCount !== out.headers.length)
  fail.push(`row has ${out.colCount} cells vs ${out.headers.length} headers`);
if (out.rows !== 3) fail.push(`rows ${out.rows}`);
if (errs.length) fail.push("console errors");
console.log(fail.length ? "\nFAILED: " + fail.join("; ") : "\nOK");
await b.close();
process.exitCode = fail.length ? 1 : 0;
