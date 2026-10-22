import { test, expect } from "@playwright/test";

const { analyzeFollowUpDates } = await import("../../server/services/cron/healthraySync.js");

const cases = [
  {
    name: "a dotted OBSERVATION ON date is today's visit",
    note: "FOLLOW UP TODAY:17/2/26\nOBSERVATION ON 12.08.2026\nOBSERVATION ON 21.10.2026\n- TAB LINAXA DM",
    date: "2026-10-21",
    want: { hasAny: true, matchesApptDate: true },
  },
  {
    name: "a FOLLOW UP TODAY date with a two-digit year still matches",
    note: "FOLLOW UP TODAY:20/4/26\nFOLLOW UP TODAY:21/10/26\nTAB. ROSROOT 20MG",
    date: "2026-10-21",
    want: { hasAny: true, matchesApptDate: true },
  },
  {
    name: "an older visit block alone is not today's visit",
    note: "FOLLOW UP TODAY:9/4/26\nOBSERVATION ON 22.08.2026\nTAB TELMA 40",
    date: "2026-10-21",
    want: { hasAny: true, matchesApptDate: false },
  },
  {
    name: "a day that only ends with the visit day does not match",
    note: "FOLLOW UP TODAY:21/10/26",
    date: "2026-11-01",
    want: { hasAny: true, matchesApptDate: false },
  },
  {
    name: "a next-visit date after the visit is not an older visit block",
    note: "ADVICE - FOLLOW UP AFTER STOPPING MEDICATION\nFOLLOW UP ON 22.10.2026\nTAB GLYCOMET 500",
    date: "2026-10-20",
    want: { hasAny: false, matchesApptDate: false },
  },
  {
    name: "a past block plus a next-visit date is still not today's visit",
    note: "FOLLOW UP ON 3.06.24\nFOLLOW UP AFTER 22.10.2026",
    date: "2026-10-20",
    want: { hasAny: true, matchesApptDate: false },
  },
  {
    name: "a dated medicine line is not a visit block",
    note: "OFF TAB THYRONORM 7/3/26\nTAB TELMA 40",
    date: "2026-10-21",
    want: { hasAny: false, matchesApptDate: false },
  },
];

test.describe("G112 the sync recognises the visit's own block in a cumulative note", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(analyzeFollowUpDates(c.note, c.date)).toEqual(c.want);
    });
  }
});
